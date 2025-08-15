// src/components/discover.ts
// Serverless "Discover" feed via on-chain Memo, + publish handler with CORS-safe RPC selection.

import { CONFIG } from "./config";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

// ---------- Constants ----------
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const REGISTRY_PK = new PublicKey((CONFIG as any).PUBLISH_REGISTRY || (CONFIG as any).OWNER_WALLET);
const enc = new TextEncoder();

type PublishPayload = { v: 1; t: "api"; k: string; l: string[]; wm?: string; c: string };
type FeedItem = { sig: string; slot: number; time: number; p: PublishPayload };

// ---------- Utils ----------
function withTimeout<T>(p: Promise<T>, ms = 2500): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

function corsFriendly(u: string) {
  const l = u.toLowerCase();
  // Exclude endpoints that commonly break CORS in browsers
  if (l.includes("publicnode.com")) return false;
  if (l.includes("solana.drpc.org")) return false;
  if (l.includes("rpc.ankr.com/multichain")) return false; // not Solana JSON-RPC
  return true;
}

// Build a probe list: your configured list first, then safe fallbacks
function buildProbeList(): string[] {
  const { DEFAULT_CLUSTER, DEVNET_RPCS, MAINNET_RPCS } = CONFIG as any;
  const base = (DEFAULT_CLUSTER === "devnet" ? DEVNET_RPCS : MAINNET_RPCS) || [];
  const extra = [
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://api.devnet.solana.com", // harmless if mainnet; just filtered out by cluster usage
  ];
  const seen = new Set<string>();
  return [...base, ...extra]
    .filter(Boolean)
    .filter((u) => corsFriendly(u))
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

let CACHED_ENDPOINT: string | null = null;
let CACHED_CONN: Connection | null = null;

// Probe endpoints until one responds to getLatestBlockhash; cache the winner
async function getConn(): Promise<Connection> {
  if (CACHED_CONN) return CACHED_CONN;
  const candidates = buildProbeList();
  for (const url of candidates) {
    try {
      const c = new Connection(url, { commitment: "confirmed" });
      await withTimeout(c.getLatestBlockhash("finalized"), 3000); // probe
      CACHED_ENDPOINT = url;
      CACHED_CONN = c;
      // console.debug("[Discover] Using RPC:", url);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error("No CORS-friendly Solana RPC available");
}

// ---------- Payload helpers ----------
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

// ---------- Public: publish API meme ----------
export async function publishMemeApi(opts: { key: string; lines: string[]; wm?: string }) {
  const provider = (window as any).solana;
  if (!provider?.publicKey) throw new Error("Connect wallet first");

  const creator = provider.publicKey.toBase58();
  const payload: PublishPayload = { v: 1, t: "api", k: opts.key, l: opts.lines, wm: opts.wm, c: creator };

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(encodePayload(payload))), // Uint8Array -> Buffer
  });
  const zeroIx = SystemProgram.transfer({
    fromPubkey: provider.publicKey,
    toPubkey: REGISTRY_PK,
    lamports: 0,
  });

  const c = await getConn();
  const tx = new Transaction().add(zeroIx, memoIx);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash("finalized")).blockhash;

  // Prefer wallet sending (handles RPC nuances), but still confirm via our conn
  if (typeof provider.signAndSendTransaction === "function") {
    const { signature } = await provider.signAndSendTransaction(tx);
    await c.confirmTransaction(signature, "confirmed");
    (window as any)?.toast?.success?.("Published to Discover");
    window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig: signature, payload } }));
    return signature;
  } else {
    const signed = await provider.signTransaction(tx);
    const sig = await c.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    await c.confirmTransaction(sig, "confirmed");
    (window as any)?.toast?.success?.("Published to Discover");
    window.dispatchEvent(new CustomEvent("stonky:published", { detail: { sig, payload } }));
    return sig;
  }
}

// ---------- Discover feed ----------
async function fetchPage(before?: string, limit = 24): Promise<FeedItem[]> {
  const c = await getConn();
  const sigs = await c.getSignaturesForAddress(REGISTRY_PK, before ? { before, limit } : { limit });
  if (!sigs.length) return [];
  const sigList = sigs.map((s) => s.signature);
  const txs = await c.getTransactions(sigList, { maxSupportedTransactionVersion: 0 });

  const out: FeedItem[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const sig = sigList[i];
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
      const page = await fetchPage(lastSig, 24);
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
          (window as any)?.toast?.success?.("Loaded into editor");
        });
      });
    } catch (err) {
      console.error("[Discover] Failed to load page:", err);
      (window as any)?.toast?.error?.("RPC unavailable. Trying again…");
      // Drop cached endpoint so next click will probe anew
      CACHED_ENDPOINT = null; CACHED_CONN = null;
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
    try { await publishMemeApi({ key, lines, wm }); }
    catch (err) {
      console.error("[Discover] Publish failed:", err);
      (window as any)?.toast?.error?.("Publish failed (RPC).");
      // Invalidate cache so next attempt re-probes RPCs
      CACHED_ENDPOINT = null; CACHED_CONN = null;
    }
  });
}
