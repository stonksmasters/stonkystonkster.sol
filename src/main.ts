// src/main.ts

// Polyfills first (Buffer, etc.)
import "./polyfills";

// App modules
import { CONFIG } from "./components/config";
import { initConnection } from "./components/solana";
import { initTipJar } from "./components/tipjar";
import { initMemeGen } from "./components/meme";

// Expose typing for plugin script
declare global {
  interface Window {
    Jupiter?: { init: (opts: any) => void };
    solana?: any;
    __ENV__?: Record<string, string>;
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
  // Make sure CONFIG has what we expect at runtime (useful on IPFS)
  // console.debug("[ENV] cluster", CONFIG.DEFAULT_CLUSTER, "mainnet RPCs", CONFIG.MAINNET_RPCS, "devnet RPCs", CONFIG.DEVNET_RPCS);

  initConnection();   // RPC pool + backoff (also reads CONFIG lists)
  initTipJar();       // Tip Jar + QR modal
  initMemeGen();      // Meme Shrine
  initJupiterPlugin();
});
