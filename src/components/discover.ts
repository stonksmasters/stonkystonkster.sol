// src/components/discover.ts
// Serverless "Discover" via Memo.
// IMPORTANT: No batch RPC calls (compatible with Helius free plan).
// - Uses only CONFIG RPCs
// - Single-request fetch per signature (throttled) with raw→parsed fallback
// - Robust publish flow + optimistic card + local library

import { CONFIG } from "./config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

// ---------- Debug ----------
const RUNTIME_DEBUG =
  /(?:^|[?&])debug=1(?:$|&)/.test(location.search) ||
  localStorage.getItem("STONKY_DEBUG") === "1";
const DEBUG = RUNTIME_DEBUG || (import.meta as any).env?.VITE_DEBUG === "1";
const toast = (window as any)?.toast || {};
const dbg = (...a: any[]) => { if (DEBUG) console.debug("[Discover]", ...a); };
const info = (...a: any[]) => { if (DEBUG) console.info("[Discover]", ...a); };
const warn = (...a: any[]) => { if (DEBUG) console.warn("[Discover]", ...a); };

// ---------- Constants ----------
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const REGISTRY_PK = new PublicKey((CONFIG as any).PUBLISH_REGISTRY || (CONFIG as any).OWNER_WALLET);
const enc = new TextEncoder();

// UI + paging
const PAGE_SIZE = 12;
// Soft client-side rate limit between *RPC* calls
const MIN_CALL_SPACING = 300; // a touch higher to be kind to free plans

// Local library
const LIB_KEY = "stonky:library";

// ---------- Utils ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.floor(Math.random() * 150);
function is429(e: unknown): boolean {
  const msg = String((e as any)?.message || e || "");
  return msg.includes("429") || msg.includes("Too many requests") || msg.includes("-32429");
}
function is401_403(e: unknown): boolean {
  const msg = String((e as any)?.message || e || "");
  return msg.includes("401") || msg.includes("Unauthorized") || msg.includes("403") || msg.includes("Forbidden");
}
function isLongTermStorageErr(e: unknown): boolean {
  const msg = String((e as any)?.message || e || "");
  return msg.includes("Failed to query long-term storage");
}
function withTimeout<T>(p: Promise<T>, ms = 3500): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
function addToLibrary(entry: { sig: string; p: PublishPayload; time: number }) {
  try {
    const cur = JSON.parse(localStorage.getItem(LIB_KEY) || "[]");
    const next = [entry, ...cur].slice(0, 500);
    localStorage.setItem(LIB_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("stonky:libraryUpdated", { detail: { size: next.length } }));
    dbg("library+1", entry.sig, entry.p);
  } catch (e) { warn("library save failed", e); }
}

// ---------- RPC pool (CONFIG only) ----------
function corsFriendly(u: string) {
  const l = u.toLowerCase();
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
let pool: Ep[] = buildCandidateList().map((url) => ({ url, cooldownUntil: 0, failScore: 0 }));
let CACHED_CONN: Connection | null = null;
let CACHED_URL: string | null = null;

function rebuildPoolIfEmpty() {
  if (!pool.length) pool = buildCandidateList().map((url) => ({ url, cooldownUntil: 0, failScore: 0 }));
}
function looksLikeHelius401(err: unknown, url?: string) {
  const msg = String((err as any)?.message || err || "");
  return !!(url && url.includes("helius-rpc.com") && (msg.includes("401") || msg.includes("Unauthorized")));
}

async function pickConn(): Promise<Connection> {
  rebuildPoolIfEmpty();
  if (!pool.length) throw new Error("No CORS-friendly RPC available");

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
      if (looksLikeHelius401(err, ep.url)) {
        toast.error?.("Helius denied this origin/API key. Check Allowed Origins or plan limits.");
      }
      ep.failScore += 1;
      ep.cooldownUntil = now + Math.min(30_000, 3_000 * ep.failScore);
      warn("RPC probe failed:", ep.url, "failScore:", ep.failScore, err);
    }
  }
  throw new Error("No CORS-friendly RPC available");
}

// Soft client-side rate limiter
let lastCall = 0;
async function rateLimitPause() {
  const delta = Date.now() - lastCall;
  if (delta < MIN_CALL_SPACING) await sleep(MIN_CALL_SPACING - delta);
  lastCall = Date.now();
}

// ---------- Payload helpers ----------
type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };
type FeedItem = { sig: string; slot: number; time: number; p: PublishPayload };

function encodePayload(p: PublishPayload): string {
  const safe: PublishPayload = {
    v: 1,
    t: "api",
    k: (p.k || "").slice(0, 64),
    l: (Array.isArray(p.l) ? p.l : []).map((s) => String(s || "").slice(0, 140)).slice(0, 6),
    wm: (p.wm || "").slice(0, 64),
    c: (p.c || "").slice(0, 64),
  };
  return JSON.stringify(safe);
}
function tryParsePayload(s: string): PublishPayload | null {
  try {
    const j = JSON.parse(s);
    if (j?.v === 1 && j?.t === "api" && typeof j.k === "string" && Array.isArray(j.l)) return j;
  } catch {}
  return null;
}
function memegenPreviewUrl(key: string, lines: string[]) {
  const u = new URL("https://api.memegen.link/images/preview.jpg");
  u.searchParams.set("template", key);
  (lines || []).forEach((t) => u.searchParams.append("text[]", t && t.trim() ? t : "_"));
  u.searchParams.set("font", "impact");
  u.searchParams.set("width", "600");
  u.searchParams.set("cb", String(Date.now() % 1e9));
  return u.toString();
}
function likeLink(to: string, memeId: string, amount = 0.0001) {
  const url = new URL(`solana:${to}`);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("label", "Like this meme");
  url.searchParams.set("message", "Thanks for the meme!");
  url.searchParams.set("memo", `LIKE:${memeId}`);
  return url.toString();
}

// ---------- Progress events ----------
function emitProgress(phase: string, data?: Record<string, any>) {
  const detail = { phase, ...(data || {}) };
  window.dispatchEvent(new CustomEvent("stonky:txProgress", { detail }));
  dbg("progress:", detail);
}

// ---------- Publish (optimistic UI + library) ----------
export async function publishMemeApi(opts: { key: string; lines: string[]; wm?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const creator = provider.publicKey.toBase58();
  const payload: PublishPayload = { v: 1, t: "api", k: opts.key, l: opts.lines, wm: opts.wm, c: creator };
  emitProgress("build:start", { payload });

  const conn = await pickConn().catch((e) => {
    console.error("[Discover] pickConn failed:", e);
    toast.error?.("RPC unavailable. Check your Helius origin allowlist.");
    throw e;
  });

  const recent = await conn.getLatestBlockhash("finalized")
    .then((bh) => (emitProgress("build:blockhash_ok", { blockhash: bh.blockhash }), bh.blockhash))
    .catch((e) => { console.error("[Discover] getLatestBlockhash failed:", e); toast.error?.("RPC busy. Try again."); throw e; });

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(encodePayload(payload))),
  });
  const zeroIx = SystemProgram.transfer({
    fromPubkey: provider.publicKey,
    toPubkey: REGISTRY_PK,
    lamports: 0,
  });

  const tx = new Transaction().add(zeroIx, memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = recent;

  // Send
  let sig = "";
  try {
    toast.info?.("Opening wallet…");
    if (typeof provider.signAndSendTransaction === "function") {
      emitProgress("wallet:signing", { mode: "signAndSendTransaction" });
      const res = await provider.signAndSendTransaction(tx);
      sig = res.signature;
    } else if (typeof provider.sendTransaction === "function") {
      emitProgress("wallet:signing", { mode: "sendTransaction" });
      sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
    } else {
      emitProgress("wallet:signing", { mode: "signTransaction" });
      const signed = await provider.signTransaction(tx);
      sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    }
    emitProgress("wallet:signed", { sig });
    toast.info?.("Submitted. Waiting for confirmation…");
  } catch (e) {
    if (String(e).includes("User rejected")) {
      info("wallet rejected by user");
      toast.info?.("Publish canceled.");
      throw e;
    }
    console.error("[Discover] wallet send failed:", e);
    toast.error?.("Wallet send failed.");
    throw e;
  }

  // Confirm (short + rotates)
  try {
    emitProgress("confirm:start", { sig });
    await confirmSignatureSmart(sig);
    emitProgress("confirm:done", { sig });
  } catch (e) {
    console.error("[Discover] confirm failed:", e);
    warn("Proceeding despite confirm error.");
  }

  // Optimistic card + local library
  injectOptimisticCard(payload, sig);
  addToLibrary({ sig, p: payload, time: Date.now() });

  (window as any).__lastPublish = { sig, payload, endpoint: (conn as any)?._rpcEndpoint };
  toast.success?.("Published to Discover");
  emitProgress("done", { sig });

  window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig, payload } }));
  return sig;
}

async function confirmSignatureSmart(sig: string) {
  const tried = new Set<string>();
  let attempts = 0;
  while (attempts++ < 4) {
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
      // 429/401/403: brief backoff + rotate on next iter
      await sleep(is429(e) || is401_403(e) ? jitter(800) : jitter(500));
      CACHED_CONN = null; CACHED_URL = null;
    }
  }
  // soft fail
}

// ---------- Discover feed (NO BATCH) ----------
async function fetchPage(before?: string, limit = PAGE_SIZE): Promise<FeedItem[]> {
  const conn = await pickConn();
  await rateLimitPause();

  // Cheap signatures fetch
  const sigs = await conn.getSignaturesForAddress(
    REGISTRY_PK,
    before ? { before, limit } : { limit },
  );
  dbg("page sigs:", sigs.length);
  if (!sigs.length) return [];

  // One-by-one tx fetch (raw → parsed fallback), throttled
  const out: FeedItem[] = [];
  for (const s of sigs) {
    const sig = s.signature;
    try {
      await rateLimitPause();
      const item = await fetchOneTx(conn, sig);
      if (item) out.push(item);
    } catch (e) {
      // don’t bomb whole page; just log and continue
      dbg("tx fetch failed", sig, e);
      // rotate on persistent auth/rate errors
      if (is401_403(e) || is429(e)) { CACHED_CONN = null; CACHED_URL = null; }
    }
  }

  return out.sort((a, b) => b.slot - a.slot);
}

type OneTx = FeedItem | null;

// Single-call tx fetch with fallback to parsed when necessary
async function fetchOneTx(conn: Connection, sig: string): Promise<OneTx> {
  // A) try raw
  try {
    const tx = await withTimeout(conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }), 6000);
    if (tx) {
      const memo = extractMemoFromRaw(tx as any);
      const p = tryParsePayload(memo);
      if (p) {
        return { sig, slot: (tx as any).slot, time: ((tx as any).blockTime || 0) * 1000, p };
      }
    }
  } catch (e) {
    if (!(is401_403(e) || is429(e) || isLongTermStorageErr(e) || String(e).includes("timeout"))) {
      // Non-retryable error; bail
      throw e;
    }
  }

  // B) fallback parsed
  try {
    await rateLimitPause();
    const ptx = await withTimeout(conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }), 6000);
    if (ptx) {
      const memo = extractMemoFromParsed(ptx as any);
      const p = tryParsePayload(memo);
      if (p) {
        return { sig, slot: (ptx as any).slot, time: ((ptx as any).blockTime || 0) * 1000, p };
      }
    }
  } catch (e) {
    if (is401_403(e)) {
      // plan limitation; rethrow to let caller rotate endpoint
      throw e;
    }
  }

  return null;
}

function extractMemoFromRaw(tx: any): string {
  const logs: string[] = (tx?.meta?.logMessages || []);
  const lastLog = logs.filter((m) => m?.startsWith("Program log: ")).pop();
  if (lastLog) return lastLog.slice("Program log: ".length);
  if (tx?.meta?.memo) return String(tx.meta.memo);
  return "";
}
function extractMemoFromParsed(ptx: any): string {
  const ixs: any[] = (ptx?.transaction?.message?.instructions || []);
  const ix = ixs.find((ii) =>
    (ii?.program === "spl-memo") ||
    (ii?.programId?.toBase58?.() === MEMO_PROGRAM_ID.toBase58()) ||
    (ii?.programId === MEMO_PROGRAM_ID.toBase58())
  );
  if (!ix) return "";
  if (typeof ix?.parsed === "string") return ix.parsed;
  if (typeof ix?.data === "string") {
    try { return new TextDecoder().decode(Buffer.from(ix.data, "base64")); } catch {}
  }
  return "";
}

function ensureDiscoverSection(): HTMLElement {
  let sec = document.getElementById("discover");
  if (sec) return sec;
  const memeCard = document.getElementById("meme") || document.body;
  sec = document.createElement("section");
  sec.id = "discover";
  sec.className = "glass card rounded-xl p-6 mt-4";
  sec.innerHTML = `
    <h3 class="text-lg font-semibold mb-3">🌎 Discover</h3>
    <div class="text-xs text-white/60 mb-2">Recent community memes (on-chain)</div>
    <div id="discover-grid" class="grid grid-cols-2 md:grid-cols-3 gap-3"></div>
    <div class="flex justify-center mt-3">
      <button id="discover-more" class="px-3 py-1.5 rounded-md border border-white/15 bg-white/10 text-sm hover:bg-white/15">Load more</button>
    </div>
  `;
  memeCard.parentElement?.appendChild(sec);
  return sec;
}

function injectOptimisticCard(p: PublishPayload, sig: string) {
  const grid = document.getElementById("discover-grid");
  if (!grid) return;
  const id = `${p.k}-${(p.l || []).join("|")}`.slice(0, 64);
  const src = memegenPreviewUrl(p.k, p.l);
  const when = new Date().toLocaleString();
  const like = likeLink(p.c, id);
  const html = `
    <div class="relative rounded-lg overflow-hidden border border-white/10 bg-white/5">
      <img src="${src}" alt="${p.k}" class="w-full aspect-square object-cover" />
      <div class="absolute right-2 bottom-2 px-2 py-1 rounded bg-black/50 text-[11px]">${p.wm || ""}</div>
      <div class="p-2 text-[11px] text-white/70 flex items-center justify-between">
        <span>${p.k}</span><span>${when}</span>
      </div>
      <div class="px-2 pb-2 flex gap-1">
        <button class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
          data-open="${encodeURIComponent(p.k)}"
          data-lines='${encodeURIComponent(JSON.stringify(p.l || []))}'>Open</button>
        <a class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs" href="${like}" target="_blank" rel="noopener">Like</a>
      </div>
    </div>`;
  grid.insertAdjacentHTML("afterbegin", html);
  grid.querySelector<HTMLButtonElement>("button[data-open]")?.addEventListener("click", (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    const tpl = decodeURIComponent(b.dataset.open || "");
    const lines = JSON.parse(decodeURIComponent(b.dataset.lines || "[]"));
    window.dispatchEvent(new CustomEvent("stonky:openMeme", { detail: { tpl, lines } }));
    toast.success?.("Loaded into editor");
  });
  dbg("optimistic card inserted for", sig);
}

export function initDiscoverFeed() {
  info("init discover feed");
  ensureDiscoverSection();
  const grid = document.getElementById("discover-grid")!;
  const more = document.getElementById("discover-more")! as HTMLButtonElement;

  let lastSig: string | undefined;
  let loading = false;

  async function loadMore() {
    if (loading) return;
    loading = true; more.disabled = true;

    try {
      const page = await fetchPage(lastSig, PAGE_SIZE);
      if (!page.length) { more.textContent = "No more"; return; }
      lastSig = page[page.length - 1].sig;

      const cards = page.map((it) => {
        const id = `${it.p.k}-${(it.p.l || []).join("|")}`.slice(0, 64);
        const src = memegenPreviewUrl(it.p.k, it.p.l);
        const when = it.time ? new Date(it.time).toLocaleString() : "";
        const like = likeLink(it.p.c, id);
        return `
          <div class="relative rounded-lg overflow-hidden border border-white/10 bg-white/5">
            <img src="${src}" alt="${it.p.k}" class="w-full aspect-square object-cover" />
            <div class="absolute right-2 bottom-2 px-2 py-1 rounded bg-black/50 text-[11px]">${it.p.wm || ""}</div>
            <div class="p-2 text-[11px] text-white/70 flex items-center justify-between">
              <span>${it.p.k}</span><span>${when}</span>
            </div>
            <div class="px-2 pb-2 flex gap-1">
              <button class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
                data-open="${encodeURIComponent(it.p.k)}"
                data-lines='${encodeURIComponent(JSON.stringify(it.p.l || []))}'>Open</button>
              <a class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs" href="${like}" target="_blank" rel="noopener">Like</a>
            </div>
          </div>`;
      }).join("");

      grid.insertAdjacentHTML("beforeend", cards);
      grid.querySelectorAll<HTMLButtonElement>("button[data-open]").forEach((b) => {
        b.addEventListener("click", () => {
          const tpl = decodeURIComponent(b.dataset.open || "");
          const lines = JSON.parse(decodeURIComponent(b.dataset.lines || "[]"));
          window.dispatchEvent(new CustomEvent("stonky:openMeme", { detail: { tpl, lines } }));
          toast.success?.("Loaded into editor");
        });
      });
    } catch (err) {
      console.error("[Discover] Failed to load page:", err);
      toast.error?.("RPC busy / unauthorized. Check your Helius origin + plan.");
      CACHED_CONN = null; CACHED_URL = null;
    } finally {
      loading = false; more.disabled = false;
    }
  }

  // First page
  loadMore();
  more.addEventListener("click", loadMore);

  // Handle publish events from meme.ts
  window.addEventListener("stonky:publishMeme", async (e: any) => {
    const { key, lines, wm } = e?.detail || {};
    try {
      await publishMemeApi({ key, lines, wm });
    } catch (err) {
      if (String(err).includes("User rejected")) return;
      console.error("[Discover] Publish failed:", err);
      toast.error?.("Publish failed. Please try again.");
      CACHED_CONN = null; CACHED_URL = null;
    }
  });
}
