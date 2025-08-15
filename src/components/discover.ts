// src/components/discover.ts
// Serverless "Discover" feed via on-chain Memo, rate-limit aware RPC selection,
// chunked reads, and robust publish path with detailed debugging.

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
const DEBUG = (import.meta as any).env?.VITE_DEBUG === "1";
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
const TX_CHUNK = 6;
const MIN_CALL_SPACING = 250;

// ---------- Small utils ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.floor(Math.random() * 150);
function is429(e: any): boolean {
  const msg = String(e?.message || e || "");
  return msg.includes("429") || msg.includes("Too many requests") || msg.includes("-32429");
}
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
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
        toast.error?.("Helius denied this origin. Add your site to Allowed Origins for this API key.");
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

// ---------- Publish ----------
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
    toast.error?.("RPC unavailable. Check your Helius origin allowlist.");
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

  // Confirm (don’t block forever; rotate endpoints if hot)
  try {
    emitProgress("confirm:start", { sig });
    await confirmSignatureSmart(sig);
    emitProgress("confirm:done", { sig });
  } catch (e) {
    // Non-fatal: the tx likely went through; feed will eventually show it.
    console.error("[Discover] confirm failed:", e);
    warn("Proceeding despite confirm error.");
  }

  (window as any).__lastPublish = { sig, payload, endpoint: (conn as any)?._rpcEndpoint };
  toast.success?.("Published to Discover");
  emitProgress("done", { sig });

  window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig, payload } }));
  return sig;
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
  // Soft fail — return control to caller
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

  const out: FeedItem[] = [];
  const list = sigs.map((s) => s.signature);
  for (let i = 0; i < list.length; i += TX_CHUNK) {
    const chunk = list.slice(i, i + TX_CHUNK);
    let tries = 0;
    for (;;) {
      try {
        await rateLimitPause();
        const txs = await withTimeout(conn.getTransactions(chunk, { maxSupportedTransactionVersion: 0 }), 6000);
        for (let j = 0; j < txs.length; j++) {
          const tx = txs[j];
          const sig = chunk[j];
          if (!tx) continue;

          let memoStr = "";
          const logs = (tx.meta as any)?.logMessages || [];
          const lastLog = logs.filter((m: string) => m?.startsWith("Program log: ")).pop();
          if (lastLog) memoStr = lastLog.slice("Program log: ".length);
          else if ((tx.meta as any)?.memo) memoStr = String((tx.meta as any).memo);

          const p = tryParsePayload(memoStr);
          if (!p) continue;
          out.push({ sig, slot: tx.slot, time: (tx.blockTime || 0) * 1000, p });
        }
        break; // chunk ok
      } catch (e) {
        if (is429(e)) {
          const ep = pool.find((p) => p.url === (conn as any)._rpcEndpoint);
          await sleep(backoff(ep, tries++));
          if (tries > 3) { CACHED_CONN = null; CACHED_URL = null; break; }
        } else {
          await sleep(jitter(500));
          break;
        }
      }
    }
    if (!CACHED_CONN) await pickConn();
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
      toast.error?.("RPC busy / unauthorized. Check your Helius origin allowlist.");
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
