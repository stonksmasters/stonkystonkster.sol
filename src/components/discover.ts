// src/components/discover.ts
// Discover feed via static JSON (Web2, free) + light on-chain deltas for likes.
// Writes stay on-chain (Memo + tiny transfers). Compatible with Helius free tier.

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
const REGISTRY_PK = OWNER_PK; // one address to index for posts/likes
const enc = new TextEncoder();

// UI + paging
const PAGE_SIZE = 12;

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
function solStr(lamports: number) {
  const s = lamports / LAMPORTS_PER_SOL;
  return s.toFixed(9).replace(/\.?0+$/, "");
}
function ipfsToHttp(u: string) {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `https://w3s.link/ipfs/${u.slice("ipfs://".length)}`;
  return u;
}
function encodeMemo(obj: any) { return JSON.stringify(obj); }
function tryParseJSON(s: string) { try { return JSON.parse(s); } catch { return null; } }

// ---------- Endpoint pool (for confirm + likes delta only) ----------
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
      await c.getLatestBlockhash("finalized");
      CACHED_CONN = c;
      CACHED_URL = ep.url;
      info("Using RPC:", ep.url);
      return c;
    } catch (err) {
      if (looksLikeHelius401(err, ep.url)) {
        toast.error?.("Helius Unauthorized: add this site origin to the key's allowlist.");
      }
      ep.failScore += 1;
      ep.cooldownUntil = now + Math.min(30_000, 3_000 * ep.failScore);
      warn("RPC probe failed:", ep.url, "failScore:", ep.failScore, err);
    }
  }
  throw new Error("No CORS-friendly RPC available");
}

// ---------- Payloads ----------
type PostPayload = {
  v: 1; t: "post";
  // minimal web2/web3 pointer fields:
  cid?: string;                 // optional IPFS CID
  url: string;                  // http(s) or ipfs://
  author: string;               // base58
  cap?: string;                 // optional caption
  // carry-through memegen extras so your editor can reconstruct:
  k?: string; l?: string[]; wm?: string;
};

type LikePayload = {
  v: 1; t: "like";
  id?: string;                  // legacy id (used by older clients)
  cid?: string;                 // preferred: pointer to the post content
  to: string;                   // author base58
  c: string;                    // liker base58
  amt: number;                  // lamports paid by liker
  x?: 1;                        // superlike marker
};

// ---------- Feed (static JSON) ----------
type FeedIndex = {
  updated: number;
  latestPage: number;
  pageSize: number;
  pages: { n: number; path: string; fromSig?: string; toSig?: string }[];
};

type FeedItemPost = PostPayload & { sig: string; slot: number; ts: number; likes?: number; tipLamports?: number };
type FeedItemLike = LikePayload & { sig: string; slot: number; ts: number };
type FeedPage = { n: number; items: Array<({ type: "post" } & FeedItemPost) | ({ type: "like" } & FeedItemLike)> };

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Fetch ${path} failed: ${res.status}`);
  return res.json();
}

async function loadStaticPage(): Promise<FeedItemPost[]> {
  // 1) fetch index
  const idx = await fetchJSON<FeedIndex>("/feed/index.json");
  const latestPath =
    idx.pages.find(p => p.n === idx.latestPage)?.path ||
    `/feed/pages/page-${String(idx.latestPage).padStart(4, "0")}.json`;

  // 2) fetch latest page
  const page = await fetchJSON<FeedPage>(latestPath);

  // 3) take posts only, newest first
  const posts = (page.items || [])
    .filter((it: any) => it.type === "post")
    .map((it: any) => it as FeedItemPost)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return posts;
}

// ---------- Progress events ----------
function emitProgress(phase: string, data?: Record<string, any>) {
  const detail = { phase, ...(data || {}) };
  window.dispatchEvent(new CustomEvent("stonky:txProgress", { detail }));
  dbg("progress:", detail);
}

// ---------- Memegen helper (for legacy posts or local preview) ----------
function memegenPreviewUrl(key?: string, lines?: string[]) {
  if (!key) return "";
  const u = new URL("https://api.memegen.link/images/preview.jpg");
  u.searchParams.set("template", key);
  (lines || []).forEach((t) => u.searchParams.append("text[]", t && t.trim() ? t : "_"));
  u.searchParams.set("font", "impact");
  u.searchParams.set("width", "600");
  u.searchParams.set("cb", String(Date.now() % 1e9));
  return u.toString();
}

// Deterministic id for legacy likes (when no CID)
function memeId(key?: string, lines?: string[]) {
  if (!key) return "";
  const safe = (lines || []).map((s) => (s || "").replace(/\//g, "~s").trim());
  return `${key}|${safe.join("|")}`.slice(0, 120);
}

// ---------- Publish meme (now emits t:"post" for the Web2 feed bot) ----------
export async function publishMemeApi(opts: { key?: string; lines?: string[]; wm?: string; url?: string; cid?: string; cap?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  // Prefer explicit URL/CID if provided (e.g., IPFS); otherwise use memegen preview URL.
  const url = opts.url || memegenPreviewUrl(opts.key, opts.lines);
  if (!url) throw new Error("Missing meme URL");

  const payload: PostPayload = {
    v: 1, t: "post",
    url, cid: opts.cid, author: provider.publicKey.toBase58(),
    cap: opts.cap,
    // carry extras so editor can reconstruct:
    k: opts.key, l: opts.lines, wm: opts.wm,
  };
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

  const recent = (await conn.getLatestBlockhash("finalized")).blockhash;

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(encodeMemo(payload))),
  });
  // 1 lamport "ping" so the tx indexes under REGISTRY
  const pingIx = SystemProgram.transfer({
    fromPubkey: provider.publicKey,
    toPubkey: REGISTRY_PK,
    lamports: 1, // 0 is invalid; costs effectively nothing
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

// ---------- Like / Superlike (adds both id & cid so indexer can tally by CID) ----------
export async function publishLike(opts: { id?: string; cid?: string; creator: string; lamports: number; superlike?: boolean }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const payer = provider.publicKey;
  const total = Math.max(1, Math.floor(opts.lamports));
  const fee = Math.max(1, Math.floor((total * LIKE_FEE_BPS) / 10_000));
  const toCreator = Math.max(0, total - fee);

  const likePayload: LikePayload = {
    v: 1,
    t: "like",
    id: opts.id,           // legacy
    cid: opts.cid,         // preferred when present
    to: opts.creator,
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

  const ixPing = SystemProgram.transfer({ fromPubkey: payer, toPubkey: REGISTRY_PK, lamports: 1 });
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
  window.dispatchEvent(new CustomEvent("stonky:liked", { detail: { id: opts.id, cid: opts.cid, lamports: total, sig } }));
  return sig;
}

// ---------- Confirm helper ----------
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
      const st = await conn.getSignatureStatuses([sig]);
      const s = st?.value?.[0];
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
      await sleep(jitter(800));
    } catch {
      await sleep(jitter(600));
    }
  }
}

// ---------- Likes map (soft, recent only to stay rate-limit friendly) ----------
type LikesMap = Record<string, number>;
async function loadRecentLikesMap(limitSigs = 200): Promise<LikesMap> {
  // Pull just a single page of signatures and count likes by cid or id (fallback)
  const conn = await pickConn();
  const sigs = await conn.getSignaturesForAddress(REGISTRY_PK, { limit: limitSigs });
  const list = sigs.map((s) => s.signature);

  const out: LikesMap = {};
  for (const sig of list) {
    try {
      const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      const metaMemo = (tx as any)?.meta?.memo;
      let memoStr = typeof metaMemo === "string" && metaMemo ? metaMemo : "";
      if (!memoStr) {
        const logs: string[] = (tx as any)?.meta?.logMessages || [];
        const lastLog = logs.filter((m: string) => m?.startsWith("Program log: ")).pop();
        if (lastLog) memoStr = lastLog.slice("Program log: ".length);
      }
      const j = tryParseJSON(memoStr);
      if (j && j.t === "like") {
        const key = j.cid || j.id;
        if (typeof key === "string" && key.length) out[key] = (out[key] || 0) + 1;
      }
    } catch {}
  }
  return out;
}

// ---------- DOM + rendering ----------
function ensureDiscoverSection(): HTMLElement {
  let sec = document.getElementById("discover");
  if (sec) return sec;
  const memeCard = document.getElementById("meme") || document.body;
  sec = document.createElement("section");
  sec.id = "discover";
  sec.className = "glass card rounded-xl p-6 mt-4";
  sec.innerHTML = `
    <h3 class="text-lg font-semibold mb-3">🌎 Discover</h3>
    <div class="text-xs text-white/60 mb-2">Recent community memes (cached)</div>
    <div id="discover-grid" class="grid grid-cols-2 md:grid-cols-3 gap-3"></div>
    <div class="flex justify-center mt-3">
      <button id="discover-more" class="px-3 py-1.5 rounded-md border border-white/15 bg-white/10 text-sm hover:bg-white/15">Load more</button>
    </div>
  `;
  memeCard.parentElement?.appendChild(sec);
  return sec;
}

// ---------- Main init ----------
export function initDiscoverFeed() {
  ensureDiscoverSection();
  const grid = document.getElementById("discover-grid")!;
  const more = document.getElementById("discover-more")! as HTMLButtonElement;

  // cache likes we’ve seen so far
  const likesMap: LikesMap = {};
  const bumpLike = (key: string) => {
    likesMap[key] = (likesMap[key] || 0) + 1;
    const el = grid.querySelector<HTMLElement>(`[data-like-count="${cssEscape(key)}"]`);
    if (el) el.textContent = String(likesMap[key]);
  };

  let pageOffset = 0; // we slice the latest static page in chunks of PAGE_SIZE

  async function bootstrapLikes() {
    if (Object.keys(likesMap).length) return;
    try {
      const m = await loadRecentLikesMap(200);
      Object.assign(likesMap, m);
    } catch (e) {
      warn("likes map load failed", e);
    }
  }

  function renderCards(posts: FeedItemPost[]) {
    const cards = posts.map((it) => {
      const httpUrl = ipfsToHttp(it.url || "");
      // Prefer CID as the stable key for likes; fallback to legacy id reconstruction.
      const key = it.cid || memeId(it.k, it.l);
      const when = it.ts ? new Date((it.ts || 0) * 1000).toLocaleString() : "";
      const likeSol = solStr(LIKE_LAMPORTS);
      const superSol = solStr(SUPERLIKE_LAMPORTS);

      // if there is no url but memegen extras exist, reconstruct a preview
      const imgSrc = httpUrl || memegenPreviewUrl(it.k, it.l);

      return `
        <div class="relative rounded-lg overflow-hidden border border-white/10 bg-white/5">
          <img src="${imgSrc}" alt="${escapeAttr(it.k || it.cap || "meme")}" class="w-full aspect-square object-cover" />
          ${it.wm ? `<div class="absolute right-2 bottom-2 px-2 py-1 rounded bg-black/50 text-[11px]">${escapeAttr(it.wm)}</div>` : ""}

          <div class="p-2 text-[11px] text-white/70 flex items-center justify-between">
            <span>${escapeHtmlShort(it.k || it.cap || "")}</span><span>${when}</span>
          </div>

          <div class="px-2 pb-2 flex gap-1 items-center">
            <button class="like-btn px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
              data-key="${escapeAttr(key)}" data-cid="${escapeAttr(it.cid || "")}" data-creator="${escapeAttr(it.author)}" data-amt="${LIKE_LAMPORTS}">
              ❤️ Like (${likeSol} SOL)
            </button>
            <button class="sulike-btn px-2 py-1 rounded bg-white/10 border border-white/10 text-xs"
              data-key="${escapeAttr(key)}" data-cid="${escapeAttr(it.cid || "")}" data-creator="${escapeAttr(it.author)}" data-amt="${SUPERLIKE_LAMPORTS}">
              💥 Superlike (${superSol} SOL)
            </button>
            <span class="ml-auto text-xs opacity-80">Likes: <b data-like-count="${escapeAttr(key)}">${it.likes ?? 0}</b></span>
            ${it.k ? `<button class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs open-btn"
              data-open="${encodeURIComponent(it.k || "")}"
              data-lines='${encodeURIComponent(JSON.stringify(it.l || []))}'>Open</button>` : ""}
          </div>
        </div>`;
    }).join("");
    grid.insertAdjacentHTML("beforeend", cards);

    // Wire open back into editor
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
        const key = String(b.dataset.key || "");
        const cid = String(b.dataset.cid || "") || undefined;
        const creator = String(b.dataset.creator || "");
        const lamports = Number(b.dataset.amt || "0") | 0;
        const superlike = b.classList.contains("sulike-btn");
        try {
          b.disabled = true;
          await publishLike({ id: key, cid, creator, lamports, superlike });
          bumpLike(cid || key);
        } catch {
          // messages already shown
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  async function loadMore() {
    more.disabled = true;

    try {
      // 1) load latest static page
      const allPosts = await loadStaticPage();
      if (!allPosts.length) {
        more.textContent = "No posts yet";
        return;
      }

      // 2) slice a chunk
      const slice = allPosts.slice(pageOffset, pageOffset + PAGE_SIZE);
      pageOffset += slice.length;
      renderCards(slice);

      // 3) populate likes
      await bootstrapLikes();
      for (const it of slice) {
        const k = it.cid || memeId(it.k, it.l);
        const el = grid.querySelector<HTMLElement>(`[data-like-count="${cssEscape(k)}"]`);
        if (el && it.likes == null) el.textContent = String(likesMap[k] || 0);
      }

      // 4) no more?
      if (pageOffset >= allPosts.length) {
        more.textContent = "No more";
        more.disabled = true;
      } else {
        more.disabled = false;
      }
    } catch (err) {
      console.error("[Discover] Failed to load static feed:", err);
      toast.error?.("Feed unavailable.");
      more.disabled = false;
    }
  }

  // First page
  loadMore();
  more.addEventListener("click", loadMore);

  // Live bump when a like finishes
  window.addEventListener("stonky:liked", (e: any) => {
    const key = e?.detail?.cid || e?.detail?.id;
    if (typeof key === "string" && key) bumpLike(key);
  });

  // Handle publish events (unchanged call site; now emits t:"post")
  window.addEventListener("stonky:publishMeme", async (e: any) => {
    const { key, lines, wm, url, cid, cap } = e?.detail || {};
    try { await publishMemeApi({ key, lines, wm, url, cid, cap }); }
    catch (err) {
      if (String(err).includes("User rejected")) return;
      console.error("[Discover] Publish failed:", err);
      toast.error?.("Publish failed. Please try again.");
    }
  });
}

// ---------- helpers for safe HTML attrs / selectors ----------
function escapeAttr(s: string) { return String(s || "").replace(/"/g, "&quot;"); }
function escapeHtmlShort(s?: string) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c] as string));
}
function cssEscape(s: string) { return (window as any).CSS && (CSS as any).escape ? (CSS as any).escape(s) : String(s).replace(/"/g, '\\"'); }
