// src/components/config.ts
//
// Central app config with sensible defaults.
// Override via .env (VITE_*) or runtime via window.__ENV__.
// This unifies TipJar, Meme Shrine, and Discover feed.

const env = (k: string, d = "") =>
  (import.meta as any).env?.[k] ?? (window as any).__ENV__?.[k] ?? d;

const parseList = (s: string) =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export type Cluster = "devnet" | "mainnet";

export const CONFIG = {
  // -------- Network ----------
  DEFAULT_CLUSTER: (env("VITE_DEFAULT_CLUSTER", "mainnet") as Cluster),

  // -------- Owner / Tips ----------
  // Primary destination wallet for tips & fees (REQUIRED – base58)
  TIP_DEST_SOL: env(
    "VITE_OWNER_WALLET",
    "HeGffZqFhB9euhind4aJFWy8waLCppTkie4gvW8bQhzp"
  ),
  OWNER_WALLET: env(
    "VITE_OWNER_WALLET",
    "HeGffZqFhB9euhind4aJFWy8waLCppTkie4gvW8bQhzp"
  ),
  OWNER_SOL_DOMAIN: env("VITE_OWNER_SOL_DOMAIN", "stonkystonkster.sol"),

  // -------- Discover registry ----------
  // Single public registry address (base58) that receives a memo for each publish/like.
  // If unset, falls back to OWNER_WALLET.
  PUBLISH_REGISTRY: env("VITE_PUBLISH_REGISTRY", ""),

  // Manifest + sharding knobs (registry-of-registries)
  MANIFEST_TAG: env("VITE_MANIFEST_TAG", "registry.v1"),
  WRITE_SHARDING: env("VITE_WRITE_SHARDING", "1") === "1",
  MAX_REGISTRIES: Number(env("VITE_MAX_REGISTRIES", "4")) || 4,

  // -------- RPC pools ----------
  DEVNET_RPCS: (() => {
    const v = env("VITE_RPC_DEVNET", "");
    return v ? parseList(v) : ["https://api.devnet.solana.com"];
  })(),
  MAINNET_RPCS: (() => {
    const v = env("VITE_RPC_MAINNET", "");
    return v
      ? parseList(v)
      : [
          // Replace api-key in .env.production for deployment
          "https://mainnet.helius-rpc.com/?api-key=41701dab-24cf-4c52-8583-b60a3a8ddaac",
          "https://api.mainnet-beta.solana.com",
        ];
  })(),

  // -------- Meme API ----------
  MEMEGEN_API_KEY: env("VITE_MEMEGEN_API_KEY", ""),

  // -------- Likes / Superlikes economics (lamports) ----------
  LIKE_LAMPORTS: Number(env("VITE_LIKE_LAMPORTS", "5000")) || 5000,
  SUPERLIKE_LAMPORTS:
    Number(env("VITE_SUPERLIKE_LAMPORTS", "")) || 5000 * 10,
  LIKE_FEE_BPS: Number(env("VITE_LIKE_FEE_BPS", "1000")) || 1000, // 10% = 1000 bps

  // -------- Debug / rate limiting ----------
  DEBUG: env("VITE_DEBUG", "0") === "1",
  MIN_CALL_SPACING: Number(env("VITE_MIN_CALL_SPACING", "250")) || 250,
};

// Runtime fallback: always ensure a registry exists
if (!CONFIG.PUBLISH_REGISTRY) {
  (CONFIG as any).PUBLISH_REGISTRY = CONFIG.OWNER_WALLET;
}
