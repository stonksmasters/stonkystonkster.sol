// src/components/discover.ts
// Serverless "Discover" feed via on-chain Memo.
// Adds: Like + Superlike with 10% creator-fee split to site owner.
// Safe for Helius free tier (no JSON-RPC batch). Serial getTransaction + backoff.

import { CONFIG } from "./config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Buffer } from "buffer";

// ---------- Debug ----------
const DEBUG = (import.meta as any).env?.VITE_DEBUG === "1";
const toast = (window as any)?.toast || {};
const dbg = (...a: any[]) => { if (DEBUG) console.debug("[Discover]", ...a); };
const info = (...a: any[]) => { if (DEBUG) console.info("[Discover]", ...a); };
const warn = (...a: any[]) => { if (DEBUG) console.warn("[Discover]", ...a); };

// ---------- Constants ----------
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const OWNER_PK = new PublicKey((CONFIG as any).TIP_DEST_SOL || (CONFIG as any).OWNER_WALLET);
const REGISTRY_PK = OWNER_PK; // we still "ping" this so likes show in the same feed
const enc = new TextEncoder();

// UI + paging
const PAGE_SIZE = 12;
const TX_CHUNK = 8;              // how many signatures to resolve serially before yielding
const MIN_CALL_SPACING = 250;    // ms soft-rate-limit between RPC calls

// Like economics (configurable via .env, with safe defaults)
const LIKE_LAMPORTS =
  Number((CONFIG as any).LIKE_LAMPORTS) > 0 ? Number((CONFIG as any).LIKE_LAMPORTS) : 5_000; // 0.000005 SOL
const SUPERLIKE_LAMPORTS =
  Number((CONFIG as any).SUPERLIKE_LAMPORTS) > 0 ? Number((CONFIG as any).SUPERLIKE_LAMPORTS) : LIKE_LAMPORTS * 10;
const LIKE_FEE_BPS =
  Number((CONFIG as any).LIKE_FEE_BPS) > 0 ? Number((CONFIG as any).LIKE_FEE_BPS) : 1000; // 10%

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
  // show up to 9 decimals, but trim trailing zeros
  return s.toFixed(9).replace(/\.?0+$/, "");
}

// ---------- Endpoint pool (ONLY configured RPCs) ----------
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
  const out = base.filter(Boolean).filter(corsFriendly).filter((u: string) => (seen.has(u) ? false : (seen.add(u), true)));
  dbg("RPC candidates:", out);
  return out;
}
function looksLikeHelius401(err: any, url?: string) {
  const msg = String(err?.message || err || "");
  return !!(url && url.includes("helius-rpc.com") && (msg.includes("401") || msg.includes("Unauthorized")));
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
      if (looksLikeHelius401(err, ep.url)) {
        toast.error?.("Helius says Unauthorized: add your site to Allowed Origins for this API key.");
      }
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

// Soft client-side rate limiter
let lastCall = 0;
async function rateLimitPause() {
  const delta = Date.now() - lastCall;
  if (delta < MIN_CALL_SPACING) await sleep(MIN_CALL_SPACING - delta);
  lastCall = Date.now();
}

// ---------- Payload helpers ----------
type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };
type LikePayload    = { v: 1; t: "like"; id: string; c: string; amt: number; x?: 1 };
type FeedItem = { sig: string; slot: number; time: number; p: PublishPayload };

function encodeMemo(obj: any) {
  return JSON.stringify(obj);
}
function tryParseMemo(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
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

// Deterministic meme id (so likes attach reliably)
function memeId(key: string, lines: string[]) {
  // Keep it readable + short; encode slashes to avoid collisions
  const safe = (lines || []).map((s) => (s || "").replace(/\//g, "~s").trim());
  return `${key}|${safe.join("|")}`.slice(0, 120);
}

// ---------- Progress events ----------
function emitProgress(phase: string, data?: Record<string, any>) {
  const detail = { phase, ...(data || {}) };
  window.dispatchEvent(new CustomEvent("stonky:txProgress", { detail }));
  dbg("progress:", detail);
}

// ---------- Publish meme (unchanged behavior) ----------
export async function publishMemeApi(opts: { key: string; lines: string[]; wm?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const creator = provider.publicKey.toBase58();
  const payload: PublishPayload = { v: 1, t: "api", k: opts.key, l: opts.lines, wm: opts.wm, c: creator };
  emitProgress("build:start", { payload });

  let conn: Connection;
  try {
    conn = await pickConn();
    emitProgress("build:rpc_ready", { endpoint: (conn as any)?._rpcEndpoint });
  } catch (e) {
    console.error("[Discover] pickConn failed:", e);
    toast.error?.("RPC unavailable. Check Helius origin allowlist.");
    throw e;
  }

  let recent: string;
  try {
    const bh = await conn.getLatestBlockhash("finalized");
    recent = bh.blockhash;
    emitProgress("build:blockhash_ok", { blockhash: recent });
  } catch (e) {
    console.error("[Discover] getLatestBlockhash failed:", e);
    toast.error?.("RPC busy. Try again.");
    throw e;
  }

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(encodeMemo(payload))),
  });
  const pingIx = SystemProgram.transfer({
    fromPubkey: provider.publicKey,
    toPubkey: REGISTRY_PK,
    lamports: 0,
  });

  const tx = new Transaction().add(pingIx, memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = recent;

  // Send via wallet
  let sig = "";
  try {
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

  // Confirm (non-fatal on error)
  try {
    emitProgress("confirm:start", { sig });
    await confirmSignatureSmart(sig);
    emitProgress("confirm:done", { sig });
  } catch (e) {
    console.error("[Discover] confirm failed:", e);
    warn("Proceeding despite confirm error.");
  }

  (window as any).__lastPublish = { sig, payload, endpoint: (conn as any)?._rpcEndpoint };
  toast.success?.("Published to Discover");
  emitProgress("done", { sig });

  window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig, payload } }));
  return sig;
}

// ---------- Like / Superlike ----------
export async function publishLike(opts: { id: string; creator: string; lamports: number; superlike?: boolean }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const payer = provider.publicKey;
  const total = Math.max(1, Math.floor(opts.lamports));
  const fee = Math.max(1, Math.floor((total * LIKE_FEE_BPS) / 10_000));
  const toCreator = Math.max(0, total - fee);

  const likePayload: LikePayload = {
    v: 1,
    t: "like",
    id: opts.id,
    c: payer.toBase58(),
    amt: total,
    x: opts.superlike ? 1 : undefined,
  };

  let conn: Connection;
  try { conn = await pickConn(); }
  catch (e) { toast.error?.("RPC unavailable"); throw e; }

  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(encodeMemo(likePayload))),
  });

  const ixPing = SystemProgram.transfer({ fromPubkey: payer, toPubkey: REGISTRY_PK, lamports: 0 });
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
  try {
    if (typeof provider.signAndSendTransaction === "function") {
      const res = await provider.signAndSendTransaction(tx);
      sig = res.signature;
    } else if (typeof provider.sendTransaction === "function") {
      sig = await provider.sendTransaction(tx, conn, { skipPreflight: true });
    } else {
      const signed = await provider.signTransaction(tx);
      sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    }
  } catch (e) {
    if (String(e).includes("User rejected")) { toast.info?.("Like canceled."); throw e; }
    console.error("[Discover] like send failed:", e);
    toast.error?.("Transaction failed.");
    throw e;
  }

  try { await confirmSignatureSmart(sig); } catch {}
  toast.success?.(opts.superlike ? "Superliked!" : "Liked!");
  // Inform UI to bump counts
  window.dispatchEvent(new CustomEvent("stonky:liked", { detail: { id: opts.id, lamports: total, sig } }));
  return sig;
}

// ---------- Confirm (rotate on hot endpoints) ----------
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

// ---------- Fetching (no batch) ----------
async function fetchTransactionsSerial(conn: Connection, sigs: string[]) {
  const out: (import("@solana/web3.js").VersionedTransactionResponse | null)[] = [];
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    let tries = 0;
    for (;;) {
      try {
        await rateLimitPause();
        const tx = await withTimeout(
          conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }),
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
    // yield occasionally
    if ((i + 1) % TX_CHUNK === 0) await sleep(0);
  }
  return out;
}

// Parse memo from tx meta
function extractMemoFromTx(tx: any): string {
  if (!tx) return "";
  const logs: string[] = (tx.meta as any)?.logMessages || [];
  const lastLog = logs.filter((m) => m?.startsWith("Program log: ")).pop();
  if (lastLog) return lastLog.slice("Program log: ".length);
  if ((tx.meta as any)?.memo) return String((tx.meta as any).memo);
  return "";
}

// ---------- Likes map (soft) ----------
type LikesMap = Record<string, number>;
async function loadRecentLikesMap(limitSigs = 200): Promise<LikesMap> {
  const conn = await pickConn();
  await rateLimitPause();
  const sigs = await conn.getSignaturesForAddress(REGISTRY_PK, { limit: limitSigs });
  const list = sigs.map((s) => s.signature);
  const txs = await fetchTransactionsSerial(conn, list);
  const counts: LikesMap = {};
  for (let i = 0; i < txs.length; i++) {
    const memoStr = extractMemoFromTx(txs[i]);
    const m = tryParseMemo(memoStr);
    if (m?.t === "like" && typeof m.id === "string") {
      counts[m.id] = (counts[m.id] || 0) + 1;
    }
  }
  return counts;
}

// ---------- Discover feed ----------
async function fetchPage(before?: string, limit = PAGE_SIZE): Promise<FeedItem[]> {
  const conn = await pickConn();
  await rateLimitPause();

  const sigs = await conn.getSignaturesForAddress(
    REGISTRY_PK,
    before ? { before, limit } : { limit },
  );
  dbg("page sigs:", sigs.length);
  if (!sigs.length) return [];

  const list = sigs.map((s) => s.signature);
  const txs = await fetchTransactionsSerial(conn, list);

  const out: FeedItem[] = [];
  for (let j = 0; j < txs.length; j++) {
    const tx = txs[j];
    const sig = list[j];
    if (!tx) continue;
    const memoStr = extractMemoFromTx(tx);
    const m = tryParseMemo(memoStr);
    if (m?.t === "api" && typeof m.k === "string" && Array.isArray(m.l)) {
      out.push({ sig, slot: tx.slot, time: (tx.blockTime || 0) * 1000, p: m as PublishPayload });
    }
  }

  return out.sort((a, b) => b.slot - a.slot);
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

export function initDiscoverFeed() {
  ensureDiscoverSection();
  const grid = document.getElementById("discover-grid")!;
  const more = document.getElementById("discover-more")! as HTMLButtonElement;

  // cache likes we’ve seen so far
  const likesMap: LikesMap = {};
  const bumpLike = (id: string) => {
    likesMap[id] = (likesMap[id] || 0) + 1;
    const el = grid.querySelector<HTMLElement>(`[data-like-count="${cssEscape(id)}"]`);
    if (el) el.textContent = String(likesMap[id]);
  };

  let lastSig: string | undefined;
  let loading = false;

  async function renderCountsFor(ids: string[]) {
    // If we haven't loaded any likes yet, bootstrap from recent history once
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
      const page = await fetchPage(lastSig, PAGE_SIZE);
      if (!page.length) { more.textContent = "No more"; return; }
      lastSig = page[page.length - 1].sig;

      const cards = page.map((it) => {
        const id = memeId(it.p.k, it.p.l || []);
        const src = memegenPreviewUrl(it.p.k, it.p.l);
        const when = it.time ? new Date(it.time).toLocaleString() : "";
        // transparent pricing
        const likeSol = solStr(LIKE_LAMPORTS);
        const superSol = solStr(SUPERLIKE_LAMPORTS);
        return `
          <div class="relative rounded-lg overflow-hidden border border-white/10 bg-white/5">
            <img src="${src}" alt="${it.p.k}" class="w-full aspect-square object-cover" />
            <div class="absolute right-2 bottom-2 px-2 py-1 rounded bg-black/50 text-[11px]">${it.p.wm || ""}</div>

            <div class="p-2 text-[11px] text-white/70 flex items-center justify-between">
              <span>${it.p.k}</span><span>${when}</span>
            </div>

            <div class="px-2 pb-2 flex gap-1 items-center">
              <button class="like-btn px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
                data-id="${escapeAttr(id)}" data-creator="${escapeAttr(it.p.c)}" data-amt="${LIKE_LAMPORTS}">
                ❤️ Like (${likeSol} SOL)
              </button>
              <button class="sulike-btn px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
                data-id="${escapeAttr(id)}" data-creator="${escapeAttr(it.p.c)}" data-amt="${SUPERLIKE_LAMPORTS}">
                💥 Superlike (${superSol} SOL)
              </button>
              <span class="ml-auto text-xs opacity-80">Likes: <b data-like-count="${escapeAttr(id)}">0</b></span>
              <button class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs open-btn"
                data-open="${encodeURIComponent(it.p.k)}"
                data-lines='${encodeURIComponent(JSON.stringify(it.p.l || []))}'>Open</button>
            </div>
          </div>`;
      }).join("");

      grid.insertAdjacentHTML("beforeend", cards);

      // Wire open
      grid.querySelectorAll<HTMLButtonElement>("button.open-btn").forEach((b) => {
        b.addEventListener("click", () => {
          const tpl = decodeURIComponent(b.dataset.open || "");
          const lines = JSON.parse(decodeURIComponent(b.dataset.lines || "[]"));
          window.dispatchEvent(new CustomEvent("stonky:openMeme", { detail: { tpl, lines } }));
          toast.success?.("Loaded into editor");
        });
      });

      // Wire like/superlike
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
            // no-op; messages already shown
          } finally {
            b.disabled = false;
          }
        });
      });

      // Fill counts (soft, from recent history)
      renderCountsFor(page.map((p) => memeId(p.p.k, p.p.l || [])));
    } catch (err) {
      console.error("[Discover] Failed to load page:", err);
      toast.error?.("RPC busy / unauthorized. Check Helius origin allowlist.");
      CACHED_CONN = null; CACHED_URL = null;
    } finally {
      loading = false; more.disabled = false;
    }
  }

  // First page
  loadMore();
  more.addEventListener("click", loadMore);

  // Live bump when a like finishes
  window.addEventListener("stonky:liked", (e: any) => {
    const id = e?.detail?.id;
    if (typeof id === "string") bumpLike(id);
  });

  // Handle publish events (unchanged)
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
function cssEscape(s: string) { return CSS && (CSS as any).escape ? (CSS as any).escape(s) : s.replace(/"/g, '\\"'); }
