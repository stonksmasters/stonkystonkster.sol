// src/jup.ts
import { CONFIG } from "./components/config";

declare global {
  interface Window {
    Jupiter?: {
      init: (opts: any) => void;
      resume?: () => void;
      close?: () => void;
      syncProps?: (p: any) => void;
    };
  }
}

export function initJupiterWidget() {
  const containerId = "jup-widget";
  if (!document.getElementById(containerId)) return;

  const mount = () => {
    if (!window.Jupiter?.init) return false;

    const endpoint =
      CONFIG.DEFAULT_CLUSTER === "devnet"
        ? "https://rpc.ankr.com/solana_devnet"
        : "https://rpc.ankr.com/solana";

    // Show the current cluster label
    const lbl = document.getElementById("jup-cluster-label");
    if (lbl) lbl.textContent = CONFIG.DEFAULT_CLUSTER;

    window.Jupiter.init({
      containerId,                 // where to render
      displayMode: "integrated",   // embed in container
      endpoint,                    // public (free) RPC per cluster
      defaultExplorer: "Solscan",
      containerClassName: "w-full",                 // tailwind hooks
      containerStyles: { width: "100%", maxHeight: "560px" },
      // If you later wire wallet adapter, you can enable passthrough:
      // enableWalletPassthrough: true
    });

    return true;
  };

  // Try now; if script not ready yet, poll briefly
  if (!mount()) {
    let tries = 0;
    const t = setInterval(() => {
      if (mount() || ++tries > 40) clearInterval(t);
    }, 250);
  }
}

document.addEventListener("DOMContentLoaded", initJupiterWidget);
export {};
