// src/components/registry.ts
// Centralized on-chain registry utilities used by meme.ts / discover.ts / tipjar.ts.
// - Loads active registries from an owner-published manifest memo (tag = CONFIG.MANIFEST_TAG).
// - Selects a registry for writes (time-bucket sharding).
// - Anchors JSON payloads via Memo with discoverable keys[].
// - Exposes publishMemeApi() and publishLike() so features call a single path.

import { CONFIG } from "./config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";
import { Buffer } from "buffer";

/* --------------------------- Debug / Globals ---------------------------- */
const DEBUG = (import.meta as any).env?.VITE_DEBUG === "1" || !!CONFIG.DEBUG;
const dbg  = (...a: any[]) => { if (DEBUG) console.debug("[Registry]", ...a); };
const warn = (...a: any[]) => { if (DEBUG) console.warn("[Registry]", ...a); };

const enc = new TextEncoder();
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const OWNER_PK = new PublicKey((CONFIG as any).TIP_DEST_SOL || (CONFIG as any).OWNER_WALLET);

const REGISTRY_FALLBACK: PublicKey = (() => {
  const envVal =
    (CONFIG as any).PUBLISH_REGISTRY ||
    (import.meta as any).env?.VITE_PUBLISH_REGISTRY ||
    (window as any).__ENV__?.VITE_PUBLISH_REGISTRY ||
    "";
  try { return envVal ? new PublicKey(envVal) : OWNER_PK; } catch { return OWNER_PK; }
})();

const PAGE_SIZE_DEFAULT = Number((CONFIG as any).DISCOVER_PAGE_SIZE || 12) || 12;
const MIN_CALL_SPACING = Number((CONFIG as any).MIN_CALL_SPACING || 500) || 500;

const LIKE_LAMPORTS =
  Number((CONFIG as any).LIKE_LAMPORTS) > 0 ? Number((CONFIG as any).LIKE_LAMPORTS) : 5_000;
const SUPERLIKE_LAMPORTS =
  Number((CONFIG as any).SUPERLIKE_LAMPORTS) > 0 ? Number((CONFIG as any).SUPERLIKE_LAMPORTS) : LIKE_LAMPORTS * 10;
const LIKE_FEE_BPS =
  Number((CONFIG as any).LIKE_FEE_BPS) > 0 ? Number((CONFIG as any).LIKE_FEE_BPS) : 1000; // 10%

const MANIFEST_TAG = (CONFIG as any).MANIFEST_TAG || "registry.v1";
const WRITE_SHARDING = !!(CONFIG as any).WRITE_SHARDING;
const MAX_REGISTRIES = Math.max(1, Math.min(8, Number((CONFIG as any).MAX_REGISTRIES || 4)));

/* --------------------------- RPC Pool ----------------------------------- */
function corsFriendly(url: string): boolean {
  const l = (url || "").toLowerCase();
  if (l.includes("publicnode.com")) return false;
  if (l.includes("solana.drpc.org")) return false;
  if (l.includes("rpc.ankr.com/multichain")) return false;
  return true;
}

function buildCandidateList(): string[] {
  const { DEFAULT_CLUSTER, DEVNET_RPCS, MAINNET_RPCS } = CONFIG as any;
  const base: string[] = (DEFAULT_CLUSTER === "devnet" ? DEVNET_RPCS : MAINNET_RPCS) || [];
  const seen = new Set<string>();
  const out = base.filter(Boolean).filter(corsFriendly).filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  dbg("RPC candidates:", out);
  return out;
}
type Ep = { url: string; cooldownUntil: number; failScore: number };
const pool: Ep[] = buildCandidateList().map((url) => ({ url, cooldownUntil: 0, failScore: 0 }));

let CACHED_CONN: Connection | null = null;
let CACHED_URL: string | null = null;

function jitter(ms: number) { return ms + Math.floor(Math.random() * 150); }
function is429(e: unknown): boolean {
  const s = String((e as any)?.message || e || "");
  return s.includes("429") || s.includes("Too many requests") || s.includes("-32429");
}
function withTimeout<T>(p: Promise<T>, ms = 3500): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export async function pickConn(): Promise<Connection> {
  const now = Date.now();
  if (CACHED_CONN && CACHED_URL) {
    const ep = pool.find((p) => p.url === CACHED_URL);
    if (ep && ep.cooldownUntil <= now) return CACHED_CONN;
  }
  const order = [...pool].sort((a, b) => (a.cooldownUntil - b.cooldownUntil) || (a.failScore - b.failScore));
  for (const ep of order) {
    if (ep.cooldownUntil > now) continue;
    try {
      const c = new Connection(ep.url, { commitment: "confirmed" });
      dbg("Probing RPC:", ep.url);
      await withTimeout(c.getLatestBlockhash("finalized"), 3500);
      CACHED_CONN = c;
      CACHED_URL = ep.url;
      dbg("Using RPC:", ep.url);
      return c;
    } catch (err) {
      ep.failScore += 1;
      ep.cooldownUntil = now + Math.min(30_000, 3_000 * ep.failScore);
      warn("RPC probe failed:", ep.url, "failScore:", ep.failScore, err);
    }
  }
  throw new Error("No CORS-friendly RPC available");
}
function backoff(ep?: Ep, attempt = 0) {
  const base = [500, 1000, 2000, 4000, 6000][Math.min(attempt, 4)];
  const wait = jitter(base);
  if (ep) {
    ep.failScore += 1;
    ep.cooldownUntil = Date.now() + Math.min(60_000, base * 3);
  }
  return wait;
}

// Soft rate-limit
let lastCall = 0;
export async function rateLimitPause() {
  const delta = Date.now() - lastCall;
  if (delta < MIN_CALL_SPACING) await new Promise((r) => setTimeout(r, MIN_CALL_SPACING - delta));
  lastCall = Date.now();
}

/* --------------------------- Helpers ------------------------------------ */
function encodeMemo(obj: unknown): string { return JSON.stringify(obj); }
function tryDecodeUtf8ThenBase64(data: string): string | null {
  try { return Buffer.from(data, "utf8").toString("utf8"); } catch {}
  try { return Buffer.from(data, "base64").toString("utf8"); } catch {}
  return null;
}
export function extractMemoFromTx(tx: any): string {
  if (!tx) return "";
  const msg = tx?.transaction?.message;
  const ixs = msg?.instructions || [];
  const isMemoId = (pid: string) => { try { return new PublicKey(pid).equals(MEMO_PROGRAM_ID); } catch { return false; } };

  for (const i of ixs) {
    if (i?.programId && isMemoId(i.programId)) {
      if (typeof i?.parsed?.memo === "string") return i.parsed.memo;
      if (typeof i?.data === "string") { const s = tryDecodeUtf8ThenBase64(i.data); if (s != null) return s; }
    }
    if (typeof i?.programIdIndex === "number" && Array.isArray(msg?.accountKeys)) {
      const programId = msg.accountKeys[i.programIdIndex];
      if (programId && isMemoId(programId)) {
        if (typeof i?.data === "string") { const s = tryDecodeUtf8ThenBase64(i.data); if (s != null) return s; }
      }
    }
  }
  const metaMemo = (tx.meta as any)?.memo;
  if (metaMemo) return String(metaMemo);
  const logs: string[] = (tx.meta as any)?.logMessages || [];
  const lastLog = logs.filter((m: string) => m?.startsWith("Program log: ")).pop();
  if (lastLog) return lastLog.slice("Program log: ".length);
  return "";
}

export async function confirmSignatureSmart(sig: string) {
  const tried = new Set<string>();
  let attempts = 0;
  while (attempts++ < 6) {
    const conn = await pickConn();
    const ep = (conn as any)._rpcEndpoint as string;
    if (tried.has(ep)) { await new Promise((r) => setTimeout(r, 350 * attempts)); continue; }
    tried.add(ep);
    try {
      const st = await withTimeout(conn.getSignatureStatuses([sig]), 3500);
      const s = st?.value?.[0];
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
      await new Promise((r) => setTimeout(r, jitter(800)));
    } catch (e) {
      if (is429(e)) {
        const pp = pool.find((p) => p.url === ep);
        await new Promise((r) => setTimeout(r, backoff(pp, attempts)));
        // force rotate
        CACHED_CONN = null; CACHED_URL = null;
      } else {
        await new Promise((r) => setTimeout(r, jitter(600)));
      }
    }
  }
}

/* -------------------- Registry-of-registries manifest ------------------- */
type RegistryManifestV1 = {
  tag: string;              // "registry.v1"
  owner: string;            // base58
  registries: string[];     // base58[]
  updatedTs?: number;       // unix seconds
  version?: number;         // 1
};

function safeJson<T = any>(s: string): T | null { try { return JSON.parse(s); } catch { return null; } }

export async function publishRegistryManifest(registries: string[]) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");
  if (provider.publicKey.toBase58() !== OWNER_PK.toBase58()) {
    throw new Error("Only owner can publish manifest");
  }

  const uniq = Array.from(new Set(registries)).slice(0, MAX_REGISTRIES);
  if (uniq.length === 0) throw new Error("At least one registry is required");

  const payload: RegistryManifestV1 = {
    tag: MANIFEST_TAG,
    owner: OWNER_PK.toBase58(),
    registries: uniq,
    updatedTs: Math.floor(Date.now() / 1000),
    version: 1,
  };

  const conn = await pickConn();
  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: provider.publicKey, isSigner: true, isWritable: false },
      { pubkey: OWNER_PK,           isSigner: false, isWritable: false },
    ],
    data: Buffer.from(enc.encode(JSON.stringify(payload))),
  });

  const tx = new Transaction().add(memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = recent;

  let sig = "";
  if (typeof provider.signAndSendTransaction === "function") {
    const res = await provider.signAndSendTransaction(tx); sig = res.signature;
  } else if (typeof provider.sendTransaction === "function") {
    sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
  } else {
    const signed = await provider.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  }

  try { await confirmSignatureSmart(sig); } catch {}
  return sig;
}

async function loadLatestRegistryManifest(): Promise<RegistryManifestV1 | null> {
  const conn = await pickConn();
  await rateLimitPause();
  const sigs = await conn.getSignaturesForAddress(OWNER_PK, { limit: 100 });
  const list = sigs.map((s) => s.signature);
  const txs = await (async () => {
    const out: (import("@solana/web3.js").ParsedTransactionWithMeta | null)[] = [];
    for (let i = 0; i < list.length; i++) {
      const sig = list[i];
      let tries = 0;
      for (;;) {
        try {
          await rateLimitPause();
          const tx = await withTimeout(
            (await pickConn()).getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }),
            6500
          );
          out.push(tx); break;
        } catch (e) {
          if (is429(e)) {
            const ep = pool.find((p) => p.url === CACHED_URL);
            await new Promise((r) => setTimeout(r, backoff(ep, tries++)));
            if (tries > 2) { CACHED_CONN = null; CACHED_URL = null; }
            if (tries > 3) { out.push(null); break; }
          } else { out.push(null); break; }
        }
      }
    }
    return out;
  })();

  let latest: { ts: number; m: RegistryManifestV1 } | null = null;
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]; if (!tx) continue;
    const memoStr = extractMemoFromTx(tx);
    const obj = safeJson<RegistryManifestV1>(memoStr);
    if (!obj || obj.tag !== MANIFEST_TAG) continue;
    if (!Array.isArray(obj.registries) || obj.registries.length === 0) continue;
    const ts = Number(tx.blockTime || 0);
    if (!latest || ts > latest.ts) latest = { ts, m: obj };
  }
  return latest?.m || null;
}

/* -------------------- Active registries + selection --------------------- */
let __activeRegistries: PublicKey[] | null = null;
let __registryLoadedAt = 0;

export async function getActiveRegistries(): Promise<PublicKey[]> {
  if (__activeRegistries && (Date.now() - __registryLoadedAt) < 60_000) return __activeRegistries;

  const list: PublicKey[] = [];
  const manifest = await loadLatestRegistryManifest();

  if (manifest?.registries?.length) {
    for (const r of manifest.registries) {
      try { list.push(new PublicKey(r)); } catch {}
    }
  }

  if (list.length === 0) list.push(REGISTRY_FALLBACK || OWNER_PK);

  __activeRegistries = list.slice(0, MAX_REGISTRIES);
  __registryLoadedAt = Date.now();
  dbg("Active registries:", __activeRegistries.map((x) => x.toBase58()));
  return __activeRegistries;
}

export async function selectRegistryForWrite(): Promise<PublicKey> {
  const regs = await getActiveRegistries();
  if (regs.length === 1 || !WRITE_SHARDING) return regs[0];
  const BUCKET_MIN = 30; // rotate every 30 minutes
  const idx = Math.floor(Date.now() / (BUCKET_MIN * 60_000)) % regs.length;
  return regs[idx];
}

/* -------------------- Public high-level writers ------------------------- */
export type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };
export type LikePayload    = { v: 1; t: "like"; id: string; c: string; amt: number; x?: 1 };

export async function publishMemeApi(opts: { key: string; lines: string[]; wm?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const creator = provider.publicKey.toBase58();
  const payload: PublishPayload = { v: 1, t: "api", k: opts.key, l: opts.lines, wm: opts.wm, c: creator };

  const conn = await pickConn();
  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;

  const reference = Keypair.generate().publicKey;
  const REG_FOR_WRITE = await selectRegistryForWrite();

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: provider.publicKey, isSigner: true,  isWritable: false },
      { pubkey: REG_FOR_WRITE,      isSigner: false, isWritable: false },
      { pubkey: reference,          isSigner: false, isWritable: false },
    ],
    data: Buffer.from(enc.encode(encodeMemo(payload))),
  });

  const pingIx = SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: REG_FOR_WRITE, lamports: 0 });

  const tx = new Transaction().add(pingIx, memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = recent;

  let sig = "";
  if (typeof provider.signAndSendTransaction === "function") {
    const res = await provider.signAndSendTransaction(tx); sig = res.signature;
  } else if (typeof provider.sendTransaction === "function") {
    sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
  } else {
    const signed = await provider.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  }

  try { await confirmSignatureSmart(sig); } catch {}
  return sig;
}

export async function publishLike(opts: { id: string; creator: string; lamports?: number; superlike?: boolean }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const payer = provider.publicKey;
  const total = Math.max(1, Math.floor(opts.lamports ?? (opts.superlike ? SUPERLIKE_LAMPORTS : LIKE_LAMPORTS)));
  const fee = Math.max(1, Math.floor((total * LIKE_FEE_BPS) / 10_000));
  const toCreator = Math.max(0, total - fee);

  const likePayload: LikePayload = {
    v: 1, t: "like", id: opts.id, c: payer.toBase58(), amt: total, x: opts.superlike ? 1 : undefined,
  };

  const conn = await pickConn();
  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;
  const REG_FOR_WRITE = await selectRegistryForWrite();

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: payer,          isSigner: true,  isWritable: false },
      { pubkey: REG_FOR_WRITE,  isSigner: false, isWritable: false },
    ],
    data: Buffer.from(enc.encode(encodeMemo(likePayload))),
  });

  const ixPing = SystemProgram.transfer({ fromPubkey: payer, toPubkey: REG_FOR_WRITE, lamports: 0 });
  const ixFee  = SystemProgram.transfer({ fromPubkey: payer, toPubkey: OWNER_PK,    lamports: fee });
  const ixTip  = toCreator > 0
    ? SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(opts.creator), lamports: toCreator })
    : null;

  const tx = new Transaction();
  tx.add(ixPing, ixFee);
  if (ixTip) tx.add(ixTip);
  tx.add(memoIx);
  tx.feePayer = payer;
  tx.recentBlockhash = recent;

  let sig = "";
  if (typeof provider.signAndSendTransaction === "function") {
    const res = await provider.signAndSendTransaction(tx); sig = res.signature;
  } else if (typeof provider.sendTransaction === "function") {
    sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
  } else {
    const signed = await provider.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  }

  try { await confirmSignatureSmart(sig); } catch {}
  return sig;
}

/* -------------------- Small utils exported for UI ----------------------- */
export function solStr(lamports: number) {
  const s = lamports / LAMPORTS_PER_SOL;
  return s.toFixed(9).replace(/\.?0+$/, "");
}
