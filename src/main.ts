// src/main.ts

// Polyfills first (Buffer, etc.)
import "./polyfills";
import "./styles/tailwind.css";

// App modules
import { CONFIG } from "./components/config";
import { initConnection } from "./components/solana";
import { initTipJar } from "./components/tipjar";
import { initMemeGen, setMemeWatermark } from "./components/meme";
import { initDiscoverFeed } from "./components/discover";
import { initMemeLibrary } from "./components/library";

// Expose typing for plugin script
declare global {
  interface Window {
    Jupiter?: { init: (opts: any) => void };
    solana?: any; // Phantom provider
    __ENV__?: Record<string, string>;
  }
}

// ---------- Wallet label helpers ----------
function shorten(pk: string) {
  return pk && pk.length > 10 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

async function withTimeout<T>(p: Promise<T>, ms = 2500): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Emit wallet-state for other modules (library, etc.)
function emitWalletChanged(pubkey: string | null, label: string | null) {
  window.dispatchEvent(new CustomEvent("stonky:walletChanged", { detail: { pubkey, label } }));
}

// Best-effort SNS reverse lookup (quietly falls back if anything fails)
async function tryResolveSnsReverse(address: string): Promise<string | null> {
  if (!address) return null;

  // Endpoint A: Bonfida SNS proxy
  const endpointA = `https://sns-sdk-proxy.bonfida.com/resolve_reverse?address=${encodeURIComponent(address)}`;
  // Endpoint B: alt reverse service (shape may vary; we just look for a .sol string)
  const endpointB = `https://names.solana.com/v1/reverse/${encodeURIComponent(address)}`;

  const tryOne = async (url: string) => {
    const r = await withTimeout(fetch(url, { mode: "cors", credentials: "omit" }));
    if (!r.ok) throw new Error(`bad ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    // Try a few likely shapes
    const vals = [
      j?.domain,
      j?.reverse,
      j?.name,
      j?.result,
      typeof j === "string" ? j : null,
    ].filter(Boolean) as string[];
    const hit = vals.find((s) => typeof s === "string" && s.toLowerCase().endsWith(".sol"));
    return hit || null;
  };

  try {
    const a = await tryOne(endpointA);
    if (a) return a;
  } catch {}
  try {
    const b = await tryOne(endpointB);
    if (b) return b;
  } catch {}
  return null;
}

function computeWalletLabelSync(): string {
  try {
    const pk = window.solana?.publicKey?.toBase58?.() ?? "";
    return pk ? shorten(pk) : "";
  } catch {
    return "";
  }
}

// Hook Phantom events to keep the meme watermark + other modules synced with the user
function initWalletWatermarkBinding() {
  // Default watermark (site owner) until a user connects
  setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
  emitWalletChanged(null, null);

  const applyFromWallet = async () => {
    const pk = window.solana?.publicKey?.toBase58?.();
    if (!pk) {
      setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
      emitWalletChanged(null, null);
      return;
    }
    // Try SNS reverse; fallback to shortened pubkey
    const domain = await tryResolveSnsReverse(pk).catch(() => null);
    const label = domain || shorten(pk);
    setMemeWatermark(label);
    emitWalletChanged(pk, label);
  };

  // Support a nicer label pushed from elsewhere (e.g., your own SNS resolver)
  // window.dispatchEvent(new CustomEvent("stonky:walletLabel", { detail: { label: "alice.sol" } }));
  window.addEventListener("stonky:walletLabel", (e: any) => {
    const label = e?.detail?.label;
    if (typeof label === "string" && label.trim()) {
      setMemeWatermark(label.trim());
      const pk = window.solana?.publicKey?.toBase58?.() || null;
      emitWalletChanged(pk, label.trim());
    }
  });

  const wireProvider = (prov: any) => {
    if (!prov) return;

    // If already connected on load
    if (prov.isConnected && prov.publicKey) applyFromWallet();

    // Phantom events
    prov.on?.("connect", applyFromWallet);
    prov.on?.("accountChanged", (pubkey: any) => {
      if (pubkey) applyFromWallet();
      else {
        setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
        emitWalletChanged(null, null);
      }
    });
    prov.on?.("disconnect", () => {
      setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
      emitWalletChanged(null, null);
    });
  };

  // Provider may inject late — poll briefly
  if (window.solana) {
    wireProvider(window.solana);
  } else {
    let tries = 0;
    const t = setInterval(() => {
      if (window.solana || tries++ > 40) {
        clearInterval(t);
        if (window.solana) wireProvider(window.solana);
      }
    }, 250);
  }
}

// ---------- Pick a good RPC for Jupiter (runtime+build friendly) ----------
function chooseJupiterEndpoint(): string | undefined {
  const cluster = CONFIG.DEFAULT_CLUSTER; // "devnet" | "mainnet"
  const list = cluster === "devnet" ? CONFIG.DEVNET_RPCS : CONFIG.MAINNET_RPCS;

  // Filter out endpoints known to break in browsers (CORS / wrong product).
  const filtered = list.filter((u) => {
    const l = u.toLowerCase();
    if (l.includes("solana.drpc.org")) return false;          // blocks custom header
    if (l.includes("rpc.ankr.com/multichain")) return false;  // not a Solana JSON-RPC
    return true;
  });

  // Prefer Helius if present (and you’ve allowed your production origin in Helius dashboard)
  const helius = filtered.find((u) => u.includes("helius-rpc.com"));
  return helius || filtered[0]; // If none, Jupiter will fall back internally if endpoint is undefined
}

// ---------- Jupiter Plugin (integrated mode) ----------
function initJupiterPlugin() {
  const containerId = "jup-widget";
  const el = document.getElementById(containerId);
  if (!el) return;

  const mount = () => {
    if (!window.Jupiter?.init) return false;

    // Label cluster in UI
    const lbl = document.getElementById("jup-cluster-label");
    if (lbl) lbl.textContent = CONFIG.DEFAULT_CLUSTER;

    const endpoint = chooseJupiterEndpoint();

    try {
      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: containerId,

        // Quality-of-life opts
        defaultExplorer: "Solscan",
        endpoint,                    // <- pulled from CONFIG (env or window.__ENV__)
        passThroughWallet: window.solana ?? undefined, // reuse Phantom if connected
      });
    } catch (e) {
      console.warn("[Jupiter] init failed:", e);
    }

    return true;
  };

  // Try now; if script not ready yet, poll for ~10s
  if (!mount()) {
    let tries = 0;
    const t = setInterval(() => {
      if (mount() || ++tries > 40) clearInterval(t);
    }, 250);
  }
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  // Core features
  initConnection();   // RPC pool + backoff (also reads CONFIG lists)
  initTipJar();       // Tip Jar + QR modal
  initMemeGen();      // Meme Shrine
  initJupiterPlugin();

  // New: personal library + community feed (serverless)
  initMemeLibrary();
  initDiscoverFeed();

  // Bind watermark ↔ wallet (+ SNS reverse) + broadcast wallet changes
  initWalletWatermarkBinding();
});
