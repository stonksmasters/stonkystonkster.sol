// src/components/solana.ts
// Free-RPC pool with rotation + backoff, SNS resolve, sendTip, recent feed,
// and Solana Pay deep links. Uses public Solana RPCs (no Ankr Multichain).

import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import type { Cluster } from "./config";

let connection: Connection;
let rpcPool: string[] = [];
let rpcIndex = 0;
let cluster: Cluster = CONFIG.DEFAULT_CLUSTER;
let pauseUntil = 0; // cooldown after burst errors

// -------------------- helpers --------------------
const now = () => Date.now();
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

function isRetryable(e: any) {
  const s = String(e?.message || e || "");
  const m = s.toLowerCase();
  return (
    m.includes("429") || // rate limit
    m.includes("rate") ||
    m.includes("fetch") ||
    m.includes("network") ||
    m.includes("timeout") ||
    m.includes("forbidden") || // 403
    m.includes("403")
  );
}

function looksLikeMultichain(u: string) {
  return /rpc\.ankr\.com\/multichain/i.test(u);
}

function ensurePoolHasSafeDefaults(list: string[], which: Cluster) {
  if (list.length > 0) return list;
  // Fallback to known public RPCs if everything got filtered out
  if (which === "devnet") {
    return [
      "https://rpc.publicnode.com/solana-devnet",
      "https://api.devnet.solana.com",
    ];
  }
  return [
    "https://rpc.publicnode.com/solana",
    "https://solana.drpc.org",
    "https://api.mainnet-beta.solana.com",
  ];
}

// -------------------- RPC pool --------------------
function setPool(which: Cluster) {
  cluster = which;
  const raw = which === "devnet" ? CONFIG.DEVNET_RPCS : CONFIG.MAINNET_RPCS;

  // 1) de-dup
  let list = uniq(raw).filter(Boolean);

  // 2) drop any Ankr Multichain endpoints proactively
  const before = list.length;
  list = list.filter((u) => !looksLikeMultichain(u));
  if (list.length !== before) {
    console.warn(
      "[RPC] Ignoring Ankr Multichain endpoints for Solana JSON-RPC. Supply native Solana RPC URLs instead."
    );
  }

  // 3) ensure we have something usable
  list = ensurePoolHasSafeDefaults(list, which);

  rpcPool = list;
  rpcIndex = 0;
  connection = new Connection(currentRpc(), { commitment: "confirmed" });
}

function rotateRpc(label?: string) {
  rpcIndex = (rpcIndex + 1) % (rpcPool.length || 1);
  connection = new Connection(currentRpc(), { commitment: "confirmed" });
  console.warn("[RPC] rotated →", currentRpc(), label ? `(${label})` : "");
}

export function currentRpc() {
  if (!rpcPool.length) setPool(CONFIG.DEFAULT_CLUSTER);
  return rpcPool[rpcIndex % rpcPool.length];
}

export function initConnection(which: Cluster = CONFIG.DEFAULT_CLUSTER) {
  setPool(which);
  return connection;
}

export function getConnection() {
  if (!connection) initConnection(CONFIG.DEFAULT_CLUSTER);
  return connection;
}

export function getCluster(): Cluster {
  return cluster;
}

// -------------------- Backoff + failover --------------------
export async function withFailover<T>(
  work: (c: Connection) => Promise<T>,
  label = "op",
  retries = 2
): Promise<T> {
  if (!connection) initConnection(CONFIG.DEFAULT_CLUSTER);

  // Honor cooldown if we recently got rate-limited
  if (now() < pauseUntil) {
    await new Promise((r) => setTimeout(r, Math.max(0, pauseUntil - now())));
  }

  let delay = 700;
  for (let i = 0; i <= retries; i++) {
    try {
      return await work(connection);
    } catch (e: any) {
      const retryable = isRetryable(e);
      console.warn(
        `[RPC] ${label} failed on ${currentRpc()} (try ${i + 1}/${retries + 1})`,
        e
      );

      if (!retryable || i === retries) throw e;

      // After 429, chill a bit globally
      if (String(e?.message || "").includes("429")) {
        pauseUntil = now() + 15_000;
      }

      rotateRpc(label);
      await new Promise((r) =>
        setTimeout(r, delay + Math.floor(Math.random() * 300))
      );
      delay = Math.min(delay * 2, 6_000);
    }
  }
  throw new Error("failover loop exhausted");
}

// -------------------- SNS (.sol) resolve (best-effort) --------------------
export async function tryResolveSol(name: string): Promise<string | null> {
  if (!name) return null;
  try {
    const bare = name.endsWith(".sol") ? name.slice(0, -4) : name;
    const res = await fetch(
      `https://sns-api.bonfida.com/resolve/${encodeURIComponent(bare)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data?.address;
    return addr && isValidPubkey(addr) ? addr : null;
  } catch {
    return null;
  }
}

export function isValidPubkey(s: string) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// -------------------- Tip send (wallet signs) --------------------
export async function sendTip(
  fromPubkey: PublicKey,
  amountSol: number
): Promise<string> {
  const to = await ensureRecipient();
  const toKey = new PublicKey(to);

  const { blockhash } = await withFailover(
    (c) => c.getLatestBlockhash({ commitment: "finalized" } as any),
    "getLatestBlockhash"
  );

  const ix = SystemProgram.transfer({
    fromPubkey,
    toPubkey: toKey,
    lamports: Math.round(Number(amountSol) * LAMPORTS_PER_SOL),
  });

  const msg = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);

  const provider = getProvider();
  if (!provider?.signAndSendTransaction) {
    throw new Error("No wallet found. Open Phantom and connect.");
  }

  const result = await provider.signAndSendTransaction(vtx as any);
  return String((result as any)?.signature ?? (result as unknown as string));
}

// -------------------- Recent tips (lean + robust) --------------------
export async function loadRecentTips(): Promise<
  Array<{ sol: string; sig: string; from: string; when: number }>
> {
  const recipient = await ensureRecipient();
  const addr = new PublicKey(recipient);

  // 1) get recent signatures (explicit commitment to satisfy web3.js)
  const sigInfos = await withFailover(
    (c) =>
      c.getSignaturesForAddress(
        addr,
        { limit: 15 } as any,
        "confirmed" as any
      ),
    "getSignaturesForAddress"
  );
  if (!sigInfos?.length) return [];

  const sigs = sigInfos.map((s) => s.signature).slice(0, 12);

  // 2) fetch transactions individually; cheaper + compatible with public endpoints
  const txs = await withFailover(
    async (c) => {
      const list = await Promise.all(
        sigs.map((sig) =>
          c.getTransaction(sig, {
            maxSupportedTransactionVersion: 0,
          } as any)
        )
      );
      return list.filter(Boolean) as any[];
    },
    "getTransaction(batch)"
  );

  const out: Array<{ sol: string; sig: string; from: string; when: number }> =
    [];
  for (const tx of txs) {
    try {
      const keys = tx.transaction.message.accountKeys.map((k: any) =>
        typeof k === "string"
          ? k
          : k?.toBase58
          ? k.toBase58()
          : String(k?.pubkey ?? k)
      );

      const i = keys.indexOf(recipient);
      if (i < 0) continue;

      const pre = tx.meta?.preBalances?.[i] ?? 0;
      const post = tx.meta?.postBalances?.[i] ?? 0;
      const delta = post - pre;

      if (delta > 0) {
        out.push({
          sol: (delta / LAMPORTS_PER_SOL).toFixed(4),
          sig: tx.transaction.signatures[0],
          from: keys[0],
          when: tx.blockTime ?? 0,
        });
      }
    } catch {
      /* ignore malformed */
    }
  }

  return out.slice(0, 10);
}

// -------------------- Provider + recipient --------------------
export function getProvider(): any {
  const p = (window as any).solana;
  return p?.isPhantom ? p : null;
}

let cachedRecipient: string | null = null;

export async function ensureRecipient(): Promise<string> {
  if (cachedRecipient && isValidPubkey(cachedRecipient)) return cachedRecipient;

  let dest = CONFIG.TIP_DEST_SOL;
  if (!isValidPubkey(dest) && CONFIG.OWNER_SOL_DOMAIN) {
    const resolved = await tryResolveSol(CONFIG.OWNER_SOL_DOMAIN);
    if (resolved) dest = resolved;
  }
  if (!isValidPubkey(dest)) {
    throw new Error(
      "Invalid recipient. Set VITE_OWNER_WALLET to a base58 address."
    );
  }
  cachedRecipient = dest;
  return dest;
}

// -------------------- Solana Pay deep link --------------------
export function buildSolanaPayUrl(
  to: string,
  amount: number,
  label: string,
  message?: string
) {
  const u = new URL(`solana:${to}`);
  if (amount > 0) u.searchParams.set("amount", String(amount));
  if (label) u.searchParams.set("label", label);
  if (message) u.searchParams.set("message", message);
  return u.toString();
}
