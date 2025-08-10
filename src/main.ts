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
    Jupiter?: {
      init: (opts: any) => void;
    };
    solana?: any;
  }
}

// ----- Jupiter Plugin (integrated mode) -----
function initJupiterPlugin() {
  const containerId = "jup-widget";
  const el = document.getElementById(containerId);
  if (!el) return;

  const mount = () => {
    if (!window.Jupiter?.init) return false;

    // Label cluster
    const lbl = document.getElementById("jup-cluster-label");
    if (lbl) lbl.textContent = CONFIG.DEFAULT_CLUSTER;

    // Optional: pass devnet/mainnet RPC + Phantom if present
    const endpoint =
      CONFIG.DEFAULT_CLUSTER === "devnet"
        ? "https://rpc.ankr.com/solana_devnet"
        : "https://rpc.ankr.com/solana";

    window.Jupiter.init({
      displayMode: "integrated",
      integratedTargetId: containerId,

      // Nice-to-haves:
      defaultExplorer: "Solscan",
      endpoint,
      passThroughWallet: window.solana, // lets plugin use the already-connected wallet (Phantom, etc.)
    });

    return true;
  };

  // Try now; if script not ready, poll briefly
  if (!mount()) {
    let tries = 0;
    const t = setInterval(() => {
      if (mount() || ++tries > 40) clearInterval(t); // ~10s
    }, 250);
  }
}

// Boot
document.addEventListener("DOMContentLoaded", () => {
  initConnection();   // RPC pool + backoff
  initTipJar();       // Tip Jar + QR modal
  initMemeGen();      // Meme Shrine
  initJupiterPlugin();
});
