import type { Handler } from "@netlify/functions";
import { Connection, PublicKey } from "@solana/web3.js";

// ---- Env helpers ----
const ENV = (k: string, d = "") =>
  process.env[k] ?? process.env[`VITE_${k}`] ?? d;

const RPC_MAIN = ENV("RPC_MAINNET", ENV("HELIUS_RPC", ENV("RPC_URL", ENV("RPC_ENDPOINT", ENV("RPC", ENV("RPC_MAIN", ENV("VITE_RPC_MAINNET", "")))))));
const RPC_FALLBACKS = (ENV("RPC_FALLBACKS", ENV("VITE_RPC_FALLBACKS", "")) || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const OWNER_WALLET = ENV("OWNER_WALLET", "");
const PUBLISH_REGISTRY = ENV("PUBLISH_REGISTRY", ENV("VITE_PUBLISH_REGISTRY", ""));

const MANIFEST_TAG = ENV("MANIFEST_TAG", "registry.v1");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---- RPC pool ----
function rpcList(): string[] {
  const base = [RPC_MAIN, ...RPC_FALLBACKS].filter(Boolean);
  const seen = new Set<string>();
  return base.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
}
async function pickConn(): Promise<Connection> {
  const list = rpcList();
  let lastErr: any = null;
  for (const url of list) {
    try {
      const c = new Connection(url, { commitment: "confirmed" });
      await c.getLatestBlockhash("finalized");
      return c;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("No RPC available");
}

// ---- Memo parsing ----
function tryDecodeUtf8ThenBase64(data: string): string | null {
  try { return Buffer.from(data, "utf8").toString("utf8"); } catch {}
  try { return Buffer.from(data, "base64").toString("utf8"); } catch {}
  return null;
}
function extractMemoFromTx(tx: any): string {
  if (!tx) return "";
  const msg = tx?.transaction?.message;
  const ixs = msg?.instructions || [];
  const isMemoId = (pid: string) => {
    try { return new PublicKey(pid).equals(MEMO_PROGRAM_ID); } catch { return false; }
  };
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

// ---- Manifest scan (owner) ----
async function loadRegistriesViaManifest(conn: Connection): Promise<PublicKey[]> {
  if (!OWNER_WALLET) return [];
  const owner = new PublicKey(OWNER_WALLET);
  const sigs = await conn.getSignaturesForAddress(owner, { limit: 100 });
  const txs = await conn.getParsedTransactions(sigs.map(s => s.signature), { maxSupportedTransactionVersion: 0 });

  let best: { ts: number; regs: string[] } | null = null;
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]; if (!tx) continue;
    const memoStr = extractMemoFromTx(tx);
    try {
      const j = JSON.parse(memoStr);
      if (j && j.tag === MANIFEST_TAG && Array.isArray(j.registries) && j.registries.length) {
        const ts = Number(tx.blockTime || 0);
        if (!best || ts > best.ts) best = { ts, regs: j.registries };
      }
    } catch {}
  }
  const out: PublicKey[] = [];
  for (const r of best?.regs || []) {
    try { out.push(new PublicKey(r)); } catch {}
  }
  return out;
}

// ---- Discover feed ----
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }

  try {
    const limit = Math.max(1, Math.min(50, Number(event.queryStringParameters?.limit || "12")));
    const beforeSig = event.queryStringParameters?.before || "";

    const conn = await pickConn();

    // Registries: prefer env single-registry; else manifest
    let registries: PublicKey[] = [];
    if (PUBLISH_REGISTRY) {
      try { registries = [new PublicKey(PUBLISH_REGISTRY)]; } catch {}
    }
    if (registries.length === 0) {
      registries = await loadRegistriesViaManifest(conn);
    }
    if (registries.length === 0) {
      // As a last resort, treat owner wallet as the registry (legacy)
      if (OWNER_WALLET) registries = [new PublicKey(OWNER_WALLET)];
    }
    if (registries.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ items: [] }),
      };
    }

    // Resolve cutoff time from 'before' signature (stateless pagination by time)
    let cutoffMs = Number.MAX_SAFE_INTEGER;
    if (beforeSig) {
      const tx = await conn.getParsedTransaction(beforeSig, { maxSupportedTransactionVersion: 0 });
      const bt = Number(tx?.blockTime || 0);
      if (bt > 0) cutoffMs = bt * 1000;
    }

    // Pull a little more than page size per registry to have room after time filter
    const perReg = Math.max(limit, 30);

    type Row = { sig: string; slot: number; time: number; p: PublishPayload };
    let merged: Row[] = [];

    for (const reg of registries) {
      const sigs = await conn.getSignaturesForAddress(reg, { limit: perReg });
      const list = sigs.map(s => s.signature);
      const txs = await conn.getParsedTransactions(list, { maxSupportedTransactionVersion: 0 });

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]; if (!tx) continue;
        const memoStr = extractMemoFromTx(tx);
        try {
          const j = JSON.parse(memoStr);
          if (j && j.t === "api" && typeof j.k === "string" && Array.isArray(j.l)) {
            const ms = Number(tx.blockTime || 0) * 1000;
            if (ms && ms < cutoffMs) {
              merged.push({
                sig: list[i],
                slot: Number(tx.slot || 0),
                time: ms,
                p: j as PublishPayload,
              });
            }
          }
        } catch {}
      }
    }

    merged.sort((a, b) => b.slot - a.slot);
    const items = merged.slice(0, limit);

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ items, nextBefore: items[items.length - 1]?.sig || null }),
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};
