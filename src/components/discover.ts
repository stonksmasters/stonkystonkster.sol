// src/components/discover.ts
// Serverless Discover feed via on-chain Memo, multi-registry manifest tied to the owner wallet.
// - On-chain manifest: owner publishes a small JSON memo listing registry pubkeys (registry-of-registries).
// - Write: pick a registry (round-robin/time-bucket) and attach it to the Memo ix keys[].
// - Read: now done via Netlify Functions to avoid RPC/CORS/rate limits.
// - Likes/Superlikes: transparent site fee split; likes are discoverable (anchored to registry).
// - Robust RPC pool for writes only, CORS-friendly, serial fetching (Helius/public friendly).
//
// Recommended: set VITE_PUBLISH_REGISTRY to the registry wallet (you did).

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

// ---------- Debug ----------
const DEBUG = (import.meta as any).env?.VITE_DEBUG === "1" || !!(CONFIG as any).DEBUG;
const toast = (window as any)?.toast || {};
const dbg  = (...a: any[]) => { if (DEBUG) console.debug("[Discover]", ...a); };
const info = (...a: any[]) => { if (DEBUG) console.info("[Discover]", ...a); };
const warn = (...a: any[]) => { if (DEBUG) console.warn("[Discover]", ...a); };

// ---------- Constants ----------
const enc = new TextEncoder();
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const FUNCTIONS_BASE = (CONFIG as any).FUNCTIONS_BASE || "/.netlify/functions";

// Site owner (receives site fee on likes)
const OWNER_PK = new PublicKey((CONFIG as any).TIP_DEST_SOL || (CONFIG as any).OWNER_WALLET);

// Legacy single-registry fallback (still supported)
const REGISTRY_FALLBACK: PublicKey = (() => {
  const envVal =
    (CONFIG as any).PUBLISH_REGISTRY ||
    (import.meta as any).env?.VITE_PUBLISH_REGISTRY ||
    (window as any).__ENV__?.VITE_PUBLISH_REGISTRY ||
    "";
  if (!envVal) return OWNER_PK;
  try { return new PublicKey(envVal); } catch { return OWNER_PK; }
})();

// UI / paging / rate-limit
const PAGE_SIZE = 12;
const TX_YIELD_EVERY = 8;
const MIN_CALL_SPACING = Number((CONFIG as any).MIN_CALL_SPACING || 250) || 250;

// Like economics
const LIKE_LAMPORTS =
  Number((CONFIG as any).LIKE_LAMPORTS) > 0 ? Number((CONFIG as any).LIKE_LAMPORTS) : 5_000; // 0.000005 SOL
const SUPERLIKE_LAMPORTS =
  Number((CONFIG as any).SUPERLIKE_LAMPORTS) > 0 ? Number((CONFIG as any).SUPERLIKE_LAMPORTS) : LIKE_LAMPORTS * 10;
const LIKE_FEE_BPS =
  Number((CONFIG as any).LIKE_FEE_BPS) > 0 ? Number((CONFIG as any).LIKE_FEE_BPS) : 1000; // 10%

// Manifest / sharding knobs
const MANIFEST_TAG = (CONFIG as any).MANIFEST_TAG || "registry.v1";
const WRITE_SHARDING = !!(CONFIG as any).WRITE_SHARDING;
const MAX_REGISTRIES = Math.max(1, Math.min(8, Number((CONFIG as any).MAX_REGISTRIES || 4)));

// ---------- Small utils ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.floor(Math.random() * 150);
function withTimeout<T>(p: Promise<T>, ms = 3500): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
function is429(e: unknown): boolean {
  const s = String((e as any)?.message || e || "");
  return s.includes("429") || s.includes("Too many requests") || s.includes("-32429");
}
function solStr(lamports: number) {
  const s = lamports / LAMPORTS_PER_SOL;
  return s.toFixed(9).replace(/\.?0+$/, "");
}
function safeJson<T = any>(s: string): T | null { try { return JSON.parse(s); } catch { return null; } }

// ---------- Endpoint pool (ONLY configured RPCs) for WRITES ----------
function corsFriendly(url: string): boolean {
  const l = url.toLowerCase();
  if (l.includes("publicnode.com")) return false;
  if (l.includes("solana.drpc.org")) return false;
  if (l.includes("rpc.ankr.com/multichain")) return false;
  return true;
}
function buildCandidateList(): string[] {
  const { DEFAULT_CLUSTER, DEVNET_RPCS, MAINNET_RPCS } = CONFIG as any;
  const base: string[] = (DEFAULT_CLUSTER === "devnet" ? DEVNET_RPCS : MAINNET_RPCS) || [];
  const seen = new Set<string>();
  const out = base
    .filter(Boolean)
    .filter(corsFriendly)
    .filter((u: string) => (seen.has(u) ? false : (seen.add(u), true)));
  dbg("RPC candidates:", out);
  return out;
}
type Ep = { url: string; cooldownUntil: number; failScore: number };
const pool: Ep[] = buildCandidateList().map((url) => ({ url, cooldownUntil: 0, failScore: 0 }));
let CACHED_CONN: Connection | null = null;
let CACHED_URL: string | null = null;

async function pickConn(): Promise<Connection> {
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
      info("Using RPC:", ep.url);
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

// Soft client-side rate limiter (used for writes only)
let lastCall = 0;
async function rateLimitPause() {
  const delta = Date.now() - lastCall;
  if (delta < MIN_CALL_SPACING) await sleep(MIN_CALL_SPACING - delta);
  lastCall = Date.now();
}

// ---------- Payloads ----------
type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };
type LikePayload    = { v: 1; t: "like"; id: string; c: string; amt: number; x?: 1 };
type FeedItem       = { sig: string; slot: number; time: number; p: PublishPayload };

// ---------- Memo helpers (kept for manifest scan fallback) ----------
function encodeMemo(obj: unknown): string { return JSON.stringify(obj); }
function tryDecodeUtf8ThenBase64(data: string): string | null {
  try { return Buffer.from(data, "utf8").toString("utf8"); } catch {}
  try { return Buffer.from(data, "base64").toString("utf8"); } catch {}
  return null;
}
function extractMemoFromTx(tx: any): string {
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

// ---------- Meme image URLs ----------
function memegenPreviewUrl(key: string, lines: string[]) {
  const u = new URL("https://api.memegen.link/images/preview.jpg");
  u.searchParams.set("template", key);
  (lines || []).forEach((t) => u.searchParams.append("text[]", t && t.trim() ? t : "_"));
  u.searchParams.set("font", "impact");
  u.searchParams.set("width", "600");
  u.searchParams.set("cb", String(Date.now() % 1e9));
  return u.toString();
}
function memegenFinalUrl(key: string, lines: string[]) {
  const encode = (s: string) =>
    s.trim()
      .replace(/_/g, "__").replace(/-/g, "--").replace(/ /g, "_")
      .replace(/\?/g, "~q").replace(/%/g, "~p").replace(/#/g, "~h")
      .replace(/\//g, "~s").replace(/\\/g, "~b").replace(/</g, "~l").replace(/>/g, "~g");
  const parts = (lines || []).map((t) => (t && t.trim() ? encode(t) : "_"));
  const u = new URL(`https://api.memegen.link/images/${encodeURIComponent(key)}/${parts.join("/")}.png`);
  u.searchParams.set("font", "impact");
  u.searchParams.set("width", "600");
  const k = (CONFIG as any)?.MEMEGEN_API_KEY;
  if (k) u.searchParams.set("api_key", k);
  return u.toString();
}
function memeId(key: string, lines: string[]) {
  const safe = (lines || []).map((s) => (s || "").replace(/\//g, "~s").trim());
  return `${key}|${safe.join("|")}`.slice(0, 120);
}

// ---------- Progress events ----------
function emitProgress(phase: string, data?: Record<string, any>) {
  const detail = { phase, ...(data || {}) };
  window.dispatchEvent(new CustomEvent("stonky:txProgress", { detail }));
  dbg("progress:", detail);
}

// ---------- Serverless READ APIs ----------
type ApiFeedItem = { sig: string; slot?: number; time?: number; blockTime?: number; p: PublishPayload };
type LikesMap = Record<string, number>;

async function fetchPageFromApi(before?: string, limit = PAGE_SIZE): Promise<FeedItem[]> {
  const url = new URL(`${FUNCTIONS_BASE}/fetchMemes`, window.location.origin);
  if (limit) url.searchParams.set("limit", String(limit));
  if (before) url.searchParams.set("before", before);

  const res = await fetch(url.toString(), { method: "GET", credentials: "omit" });
  if (!res.ok) throw new Error(`fetchMemes failed: ${res.status}`);
  const body = await res.json();

  // Accept either array or {items:[...]}
  const items: ApiFeedItem[] = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  return items
    .filter((x) => x && x.sig && x.p && Array.isArray(x.p.l) && typeof x.p.k === "string")
    .map((x) => ({
      sig: x.sig,
      slot: Number(x.slot ?? 0),
      time: 1000 * Number(x.time ?? x.blockTime ?? 0),
      p: x.p,
    }))
    .sort((a, b) => b.slot - a.slot);
}

async function loadRecentLikesMapFromApi(): Promise<LikesMap> {
  const url = new URL(`${FUNCTIONS_BASE}/fetchLikes`, window.location.origin);
  const res = await fetch(url.toString(), { method: "GET", credentials: "omit" });
  if (!res.ok) throw new Error(`fetchLikes failed: ${res.status}`);
  const j = await res.json();
  return (j && typeof j === "object") ? j as LikesMap : {};
}

// ---------- Transaction fetching (kept for rare manifest scan fallback) ----------
async function fetchTransactionsSerial(conn: Connection, sigs: string[]) {
  const out: (import("@solana/web3.js").ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    let tries = 0;
    for (;;) {
      try {
        await rateLimitPause();
        const tx = await withTimeout(
          conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }),
          6500
        );
        out.push(tx);
        break;
      } catch (e) {
        if (is429(e)) {
          const ep = pool.find((p) => p.url === (conn as any)._rpcEndpoint);
          await sleep(backoff(ep, tries++));
          if (tries > 3) { out.push(null); break; }
        } else {
          await sleep(jitter(400));
          out.push(null);
          break;
        }
      }
    }
    if ((i + 1) % TX_YIELD_EVERY === 0) await sleep(0);
  }
  return out;
}

async function confirmSignatureSmart(sig: string) {
  const tried = new Set<string>();
  let attempts = 0;
  while (attempts++ < 6) {
    const conn = await pickConn();
    const ep = (conn as any)._rpcEndpoint as string;
    if (tried.has(ep)) { await sleep(350 * attempts); continue; }
    tried.add(ep);
    dbg("confirm on", ep, "attempt", attempts);
    try {
      const st = await withTimeout(conn.getSignatureStatuses([sig]), 3500);
      const s = st?.value?.[0];
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
      await sleep(jitter(800));
    } catch (e) {
      if (is429(e)) {
        const pp = pool.find((p) => p.url === ep);
        await sleep(backoff(pp, attempts));
      } else {
        await sleep(jitter(600));
      }
    }
  }
}

// ---------- Registry manifest (owner-published); only used if no env registry ----------
type RegistryManifestV1 = {
  tag: string;              // "registry.v1"
  owner: string;            // base58
  registries: string[];     // base58[]
  updatedTs?: number;       // unix seconds
  version?: number;         // 1
};

// Publish the manifest (owner-only)
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
  toast.success?.("Registry manifest published");
  return sig;
}

// Load the latest manifest by scanning OWNER memos (fallback path only)
async function loadLatestRegistryManifest(): Promise<RegistryManifestV1 | null> {
  const conn = await pickConn();
  await rateLimitPause();
  const sigs = await conn.getSignaturesForAddress(OWNER_PK, { limit: 100 });
  const txs = await fetchTransactionsSerial(conn, sigs.map(s => s.signature));

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

// Cached active registries (for WRITES only)
let __activeRegistries: PublicKey[] | null = null;
let __registryLoadedAt = 0;
// Per-registry pagination cursors (unused now for reads; kept for shape)
const __perRegBefore = new Map<string, string | undefined>();

async function getActiveRegistries(): Promise<PublicKey[]> {
  // Prefer explicit env registry to avoid client read scans
  if (REGISTRY_FALLBACK && REGISTRY_FALLBACK.toBase58() !== OWNER_PK.toBase58()) {
    __activeRegistries = [REGISTRY_FALLBACK];
    __registryLoadedAt = Date.now();
    __perRegBefore.clear();
    __perRegBefore.set(REGISTRY_FALLBACK.toBase58(), undefined);
    dbg("Active registries (env):", [REGISTRY_FALLBACK.toBase58()]);
    return __activeRegistries;
  }

  // If no env registry provided, fallback to manifest scan (rare)
  if (__activeRegistries && (Date.now() - __registryLoadedAt) < 60_000) return __activeRegistries;

  const manifest = await loadLatestRegistryManifest();
  const list: PublicKey[] = [];

  if (manifest?.registries?.length) {
    for (const r of manifest.registries) {
      try { list.push(new PublicKey(r)); } catch {}
    }
  }
  if (list.length === 0) list.push(OWNER_PK);

  __activeRegistries = list.slice(0, MAX_REGISTRIES);
  __registryLoadedAt = Date.now();
  dbg("Active registries (manifest):", __activeRegistries.map(x => x.toBase58()));

  __perRegBefore.clear();
  for (const pk of __activeRegistries) __perRegBefore.set(pk.toBase58(), undefined);

  return __activeRegistries;
}

async function selectRegistryForWrite(): Promise<PublicKey> {
  const regs = await getActiveRegistries();
  if (regs.length === 1 || !WRITE_SHARDING) return regs[0];
  // time-bucket rotation
  const BUCKET_MIN = 30;
  const idx = Math.floor(Date.now() / (BUCKET_MIN * 60_000)) % regs.length;
  return regs[idx];
}

// ---------- Publish meme (WRITE; unchanged) ----------
export async function publishMemeApi(opts: { key: string; lines: string[]; wm?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const creator = provider.publicKey.toBase58();
  const payload: PublishPayload = { v: 1, t: "api", k: opts.key, l: opts.lines, wm: opts.wm, c: creator };
  emitProgress("build:start", { payload });

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

  // Optional 0-lamport ping (compatible, not required)
  const pingIx = SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: REG_FOR_WRITE, lamports: 0 });

  const tx = new Transaction().add(pingIx, memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = recent;

  let sig = "";
  if (typeof provider.signAndSendTransaction === "function") {
    emitProgress("wallet:signing", { mode: "signAndSendTransaction" });
    const res = await provider.signAndSendTransaction(tx); sig = res.signature;
  } else if (typeof provider.sendTransaction === "function") {
    emitProgress("wallet:signing", { mode: "sendTransaction" });
    sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
  } else {
    emitProgress("wallet:signing", { mode: "signTransaction" });
    const signed = await provider.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  }
  emitProgress("wallet:signed", { sig });

  try { emitProgress("confirm:start", { sig }); await confirmSignatureSmart(sig); emitProgress("confirm:done", { sig }); }
  catch (e) { warn("confirm failed (non-fatal):", e); }

  (window as any).__lastPublish = { sig, payload, endpoint: (conn as any)?._rpcEndpoint };
  toast.success?.("Published to Discover");
  emitProgress("done", { sig });

  // Optimistic UI (data source remains chain)
  window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig, payload } }));
  return sig;
}

// ---------- Like / Superlike (WRITE; unchanged) ----------
export async function publishLike(opts: { id: string; creator: string; lamports: number; superlike?: boolean }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const payer = provider.publicKey;
  const total = Math.max(1, Math.floor(opts.lamports));
  const fee = Math.max(1, Math.floor((total * LIKE_FEE_BPS) / 10_000));
  const toCreator = Math.max(0, total - fee);

  const likePayload: LikePayload = {
    v: 1, t: "like", id: opts.id, c: payer.toBase58(), amt: total, x: opts.superlike ? 1 : undefined,
  };

  const conn = await pickConn();
  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;

  // Anchor likes to whichever registry would be used for writes right now
  const REG_FOR_WRITE = await selectRegistryForWrite();

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: payer,         isSigner: true,  isWritable: false },
      { pubkey: REG_FOR_WRITE, isSigner: false, isWritable: false },
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
  toast.success?.(opts.superlike ? "Superliked!" : "Liked!");
  window.dispatchEvent(new CustomEvent("stonky:liked", { detail: { id: opts.id, lamports: total, sig } }));
  return sig;
}

// ---------- Likes map (READ via serverless) ----------
async function loadRecentLikesMap(totalLimitSigs = 200): Promise<LikesMap> {
  // totalLimitSigs kept for signature compatibility; server ignores/handles internally
  return await loadRecentLikesMapFromApi();
}

// ---------- Discover feed (READ via serverless) ----------
async function fetchPage(before?: string, limit = PAGE_SIZE): Promise<FeedItem[]> {
  return await fetchPageFromApi(before, limit);
}

// ---------- DOM scaffolding / UI ----------
function ensureDiscoverSection(): HTMLElement {
  let sec = document.getElementById("discover");
  if (sec) return sec;
  const memeCard = document.getElementById("meme") || document.body;

  sec = document.createElement("section");
  sec.id = "discover";
  // Desktop-friendly grid
  sec.className = "glass rounded-xl border border-white/10 shadow-[0_8px_30px_rgba(0,0,0,.25)] p-5 md:p-6 mt-6";
  sec.innerHTML = `
    <div class="flex items-center justify-between mb-3 md:mb-4">
      <div>
        <h3 class="text-base md:text-lg font-semibold tracking-tight">🌎 Discover</h3>
        <div class="text-[11px] md:text-xs text-white/60">Recent community memes (on-chain)</div>
      </div>
    </div>

    <div id="discover-grid" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5"></div>
    <div class="flex justify-center mt-4">
      <button id="discover-more"
        class="px-3 py-1.5 md:px-4 md:py-2 rounded-md border border-white/15
               bg-white/[0.06] hover:bg-white/[0.1] text-sm transition
               shadow-[inset_0_0_0_1px_rgba(255,255,255,.04)]">
        Load more
      </button>
    </div>
  `;
  memeCard.parentElement?.appendChild(sec);
  return sec;
}

function cardHtml(item: FeedItem) {
  const id = memeId(item.p.k, item.p.l || []);
  const src = memegenPreviewUrl(item.p.k, item.p.l);
  const viewUrl = memegenFinalUrl(item.p.k, item.p.l);
  const when = item.time ? new Date(item.time).toLocaleString() : "";
  const likeSol = solStr(LIKE_LAMPORTS);
  const superSol = solStr(SUPERLIKE_LAMPORTS);

  return `
    <div class="group relative overflow-hidden rounded-2xl border border-white/10
                bg-white/[0.04] hover:bg-white/[0.06]
                shadow-[0_6px_24px_rgba(0,0,0,.25)]
                hover:shadow-[0_10px_36px_rgba(0,0,0,.35)]
                transition">
      <!-- Image -->
      <div class="relative aspect-square overflow-hidden">
        <img src="${src}" alt="${escapeAttr(item.p.k)}"
             class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/60 to-transparent"></div>
        ${item.p.wm ? `
          <div class="absolute right-2 bottom-2 px-2 py-1 rounded-full bg-black/55 text-[11px] text-white/95
                      shadow-[0_2px_10px_rgba(0,0,0,.35)] backdrop-blur-[2px]">
            ${escapeAttr(item.p.wm)}
          </div>` : ""}
      </div>

      <!-- Meta + Actions -->
      <div class="p-3 md:p-3.5 space-y-2">
        <div class="flex items-center justify-between text-[12px] md:text-[13px] text-white/70">
          <span class="truncate font-medium text-white/85">${escapeHtml(item.p.k)}</span>
          <span class="whitespace-nowrap" title="${when}">${when}</span>
        </div>

        <!-- Actions -->
        <div class="grid grid-cols-2 gap-2 items-center">
          <button class="like-btn col-span-2 md:col-span-1 inline-flex items-center justify-center gap-1.5
                         px-3 md:px-3.5 py-2 md:py-2.5 rounded-full border border-white/10
                         bg-white/[0.07] hover:bg-white/[0.12]
                         text-[12px] md:text-[13px] whitespace-nowrap transition"
            data-id="${escapeAttr(id)}"
            data-creator="${escapeAttr(item.p.c)}"
            data-amt="${LIKE_LAMPORTS}">
            ❤️ Like <span class="opacity-70">· ${likeSol} SOL</span>
          </button>

          <button class="sulike-btn col-span-2 md:col-span-1 inline-flex items-center justify-center gap-1.5
                         px-3 md:px-3.5 py-2 md:py-2.5 rounded-full border border-pink-400/20
                         bg-gradient-to-r from-pink-500/15 to-fuchsia-500/15
                         hover:from-pink-500/25 hover:to-fuchsia-500/25
                         text-[12px] md:text-[13px] whitespace-nowrap transition"
            data-id="${escapeAttr(id)}"
            data-creator="${escapeAttr(item.p.c)}"
            data-amt="${SUPERLIKE_LAMPORTS}">
            💥 Superlike <span class="opacity-70">· ${superSol} SOL</span>
          </button>

          <div class="col-span-2 flex items-center gap-2">
            <a class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-white/10
                      bg-white/[0.06] hover:bg-white/[0.1] text-[12px] md:text-[13px] transition"
               href="${viewUrl}" target="_blank" rel="noopener">👁️ View</a>

            <span class="ml-auto inline-flex items-center gap-1 text-[12px] md:text-[13px] text-white/75">
              <span class="rounded-full bg-white/[0.08] px-2 py-1 border border-white/10">
                Likes: <b data-like-count="${escapeAttr(id)}">0</b>
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>`;
}

export function initDiscoverFeed() {
  ensureDiscoverSection();
  const grid = document.getElementById("discover-grid")!;
  const more = document.getElementById("discover-more")! as HTMLButtonElement;

  // cache likes we’ve seen so far (in-memory only)
  const likesMap: Record<string, number> = {};
  const bumpLike = (id: string) => {
    likesMap[id] = (likesMap[id] || 0) + 1;
    const el = grid.querySelector<HTMLElement>(`[data-like-count="${cssEscape(id)}"]`);
    if (el) el.textContent = String(likesMap[id]);
  };

  let loading = false;
  let cursor: string | undefined; // we page by 'before' signature if your function supports it

  async function renderCountsFor(ids: string[]) {
    // Lazy-load once per page batch
    if (Object.keys(likesMap).length === 0) {
      try {
        const m = await loadRecentLikesMap(250);
        Object.assign(likesMap, m);
      } catch (e) {
        warn("likes map load failed", e);
      }
    }
    ids.forEach((id) => {
      const el = grid.querySelector<HTMLElement>(`[data-like-count="${cssEscape(id)}"]`);
      if (el) el.textContent = String(likesMap[id] || 0);
    });
  }

  async function loadMore() {
    if (loading) return;
    loading = true; more.disabled = true;

    try {
      const page = await fetchPage(cursor, PAGE_SIZE);
      if (!page.length) { more.textContent = "No more"; return; }

      const html = page.map(cardHtml).join("");
      grid.insertAdjacentHTML("beforeend", html);

      // Like / Superlike wiring
      grid.querySelectorAll<HTMLButtonElement>("button.like-btn,button.sulike-btn").forEach((b) => {
        b.addEventListener("click", async () => {
          const id = String(b.dataset.id || "");
          const creator = String(b.dataset.creator || "");
          const lamports = Number(b.dataset.amt || "0") | 0;
          const superlike = b.classList.contains("sulike-btn");
          try {
            b.disabled = true;
            await publishLike({ id, creator, lamports, superlike });
            bumpLike(id);
          } catch {
            // error toast already surfaced
          } finally {
            b.disabled = false;
          }
        });
      });

      renderCountsFor(page.map((p) => memeId(p.p.k, p.p.l || [])));

      // advance cursor if your function supports "before"
      cursor = page[page.length - 1]?.sig;
    } catch (err) {
      console.error("[Discover] Failed to load page:", err);
      toast.error?.("Feed API busy / blocked. Check Netlify function logs & CORS.");
      CACHED_CONN = null; CACHED_URL = null;
    } finally {
      loading = false; more.disabled = false;
    }
  }

  // First page from API (serverless)
  loadMore();
  more.addEventListener("click", loadMore);

  // Live bump when a like finishes
  window.addEventListener("stonky:liked", (e: any) => {
    const id = e?.detail?.id;
    if (typeof id === "string") bumpLike(id);
  });

  // After publish, prepend immediately (UX only; actual source is still chain)
  window.addEventListener("stonky:published", (e: any) => {
    const payload = e?.detail?.payload as PublishPayload | undefined;
    if (!payload) return;
    const item: FeedItem = { sig: e?.detail?.sig || "", slot: 0, time: Date.now(), p: payload };
    grid.insertAdjacentHTML("afterbegin", cardHtml(item));
  });

  // Legacy custom event (if anything else triggers it)
  window.addEventListener("stonky:publishMeme", async (e: any) => {
    const { key, lines, wm } = e?.detail || {};
    try { await publishMemeApi({ key, lines, wm }); }
    catch (err) {
      if (String(err).includes("User rejected")) return;
      console.error("[Discover] Publish failed:", err);
      toast.error?.("Publish failed. Please try again.");
      CACHED_CONN = null; CACHED_URL = null;
    }
  });
}

// ---------- helpers for safe HTML attrs / selectors ----------
function escapeAttr(s: string) { return s.replace(/"/g, "&quot;"); }
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));
}
function cssEscape(s: string) {
  return (typeof (window as any).CSS?.escape === "function")
    ? (window as any).CSS.escape(s)
    : s.replace(/"/g, '\\"');
}
