// src/components/config.ts
//
// Central app config with sensible defaults.
// You can override these via .env (VITE_*), or at runtime via window.__ENV__.
//
// New in this version:
// - OWNER_WALLET: alias of TIP_DEST_SOL for modules that expect a generic owner pubkey
// - PUBLISH_REGISTRY: on-chain registry address (pubkey) for Discover feed;
//   falls back to OWNER_WALLET if not provided.

const env = (k: string, d = "") =>
  (import.meta as any).env?.[k] ?? (window as any).__ENV__?.[k] ?? d;

const parseList = (s: string) =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export type Cluster = "devnet" | "mainnet";

export const CONFIG = {
  // cluster: "devnet" or "mainnet"
  DEFAULT_CLUSTER: (env("VITE_DEFAULT_CLUSTER", "mainnet") as Cluster),

  // Destination wallet for tips (REQUIRED – base58)
  // If you also set VITE_OWNER_SOL_DOMAIN, we’ll try to resolve it and replace in the UI where applicable.
  TIP_DEST_SOL: env("VITE_OWNER_WALLET", "HeGffZqFhB9euhind4aJFWy8waLCppTkie4gvW8bQhzp"),

  // Back-compat/alias so other modules can refer to a single "owner" pubkey
  OWNER_WALLET: env("VITE_OWNER_WALLET", "HeGffZqFhB9euhind4aJFWy8waLCppTkie4gvW8bQhzp"),

  // Optional .sol name to show in the UI; main.ts attempts reverse lookups for connected users.
  OWNER_SOL_DOMAIN: env("VITE_OWNER_SOL_DOMAIN", ""),

  // **Discover**: public registry address (base58) to which creators publish a 0 SOL + Memo tx.
  // If unset, we read from OWNER_WALLET so you get a working default.
  PUBLISH_REGISTRY: env("VITE_PUBLISH_REGISTRY", ""),

  // Public RPC pools (free). You can override with comma-separated lists.
  DEVNET_RPCS: (() => {
    const v = env("VITE_RPC_DEVNET", "");
    return v
      ? parseList(v)
      : [
          "https://rpc.ankr.com/solana_devnet",
          "https://api.devnet.solana.com",
        ];
  })(),

  MAINNET_RPCS: (() => {
    const v = env("VITE_RPC_MAINNET", "");
    return v
      ? parseList(v)
      : [
          "https://rpc.ankr.com/solana",
          "https://solana.drpc.org",
          "https://api.mainnet-beta.solana.com",
          "https://solana-api.projectserum.com",
        ];
  })(),

  // Meme API key if you add one (optional)
  MEMEGEN_API_KEY: env("VITE_MEMEGEN_API_KEY", ""),
};

// Provide a sensible runtime fallback for PUBLISH_REGISTRY if not set
if (!CONFIG.PUBLISH_REGISTRY) {
  (CONFIG as any).PUBLISH_REGISTRY = CONFIG.OWNER_WALLET;
}
