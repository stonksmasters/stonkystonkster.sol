// src/main.ts

// Polyfills first (Buffer, etc.)
import "./polyfills";

// App modules
import { CONFIG } from "./components/config";
import { initConnection } from "./components/solana";
import { initTipJar } from "./components/tipjar";
import { initMemeGen, setMemeWatermark } from "./components/meme";

// Expose typing for plugin script
declare global {
  interface Window {
    Jupiter?: { init: (opts: any) => void };
    solana?: any; // Phantom provider
    __ENV__?: Record<string, string>;
  }
}

// ----- Helpers for watermark label from wallet -----
function shorten(pk: string) {
  return pk && pk.length > 10 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

// If you later add an SNS reverse resolver, call setMemeWatermark()
// with the resolved domain and it will override this fallback.
function computeWalletLabel(): string {
  try {
    const pk = window.solana?.publicKey?.toBase58?.() ?? "";
    return pk ? shorten(pk) : "";
  } catch {
    return "";
  }
}

// Hook Phantom events to keep the meme watermark synced with the user
function initWalletWatermarkBinding() {
  // Default watermark (site owner) until a user connects
  setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");

  const applyFromWallet = () => {
    const label = computeWalletLabel();
    if (label) setMemeWatermark(label);
  };

  // Support a nicer label pushed from elsewhere (e.g., SNS resolver)
  // Usage from any module:
  //   window.dispatchEvent(new CustomEvent("stonky:walletLabel", { detail: { label: "alice.sol" } }));
  window.addEventListener("stonky:walletLabel", (e: any) => {
    const label = e?.detail?.label;
    if (typeof label === "string" && label.trim()) {
      setMemeWatermark(label.trim());
    }
  });

  const wireProvider = (prov: any) => {
    if (!prov) return;

    // If already connected on load
    if (prov.isConnected && prov.publicKey) applyFromWallet();

    // Phantom events
    prov.on?.("connect", applyFromWallet);
    prov.on?.("accountChanged", (pubkey: any) => {
      if (pubkey) {
        applyFromWallet();
      } else {
        // Locked / no account available
        setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
      }
    });
    prov.on?.("disconnect", () => {
      setMemeWatermark(CONFIG.OWNER_SOL_DOMAIN || "");
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

// ----- Pick a good RPC for Jupiter (runtime+build friendly) -----
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

// ----- Jupiter Plugin (integrated mode) -----
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
      // Don't let plugin init throw crash the page
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

// ----- Boot -----
document.addEventListener("DOMContentLoaded", () => {
  // Boot order unchanged
  initConnection();   // RPC pool + backoff (also reads CONFIG lists)
  initTipJar();       // Tip Jar + QR modal
  initMemeGen();      // Meme Shrine
  initJupiterPlugin();

  // Bind watermark ↔ wallet
  initWalletWatermarkBinding();
});
