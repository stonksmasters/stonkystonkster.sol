# .sol Tip Jar + Meme Shrine — Developer README

A single-page, **static** web app that lets visitors:

- **Tip your .sol** using Phantom (desktop & mobile) with **Solana Pay** deep link + **QR** fallback.  
- **See the last 10 on-chain tips** sent to your destination wallet (best-effort with RPC failover).  
- **Swap into SOL** inline via the **Jupiter Plugin** (wallet pass-through).  
- **Make & download memes** (local upload + canvas; optional template API mode).

Built with **TypeScript + Vite**. No servers required. Works on Netlify/Vercel, **Webhash/IPFS**, and Brave’s native `.sol` resolution.

---

## What’s new (Aug 2025)

- **Webhash + SNS flow** documented: GitHub-based deploy, then link `stonkystonkster.sol` via **SNS URL/IPFS** record.  
- **Vite production base** uses relative paths (`'./'`) so gateways (IPFS/SNS) load assets correctly.  
- **Runtime env injection** via `window.__ENV__` in `index.html` for gateway builds.  
- **borsh compat fix** for `@solana/web3.js` bundling: alias `borsh` → `src/vendor/borsh-compat.ts` to provide `serialize/deserialize` named exports expected by web3.js.

> **Contest constraint:** the SNS domain used throughout is **`stonkystonkster.sol`**.

---

## Quickstart

```bash
# 1) Install deps
npm i

# 2) Configure env (see "Environment")
#    For local dev you can use .env or .env.development
#    For prod builds use .env.production
#    Only VITE_* keys are exposed to the client.

# 3) Local dev
npm run dev

# 4) Production build (Netlify/Vercel/Webhash/IPFS)
npm run build

# 5) Preview the built site
npm run preview
If deploying to Webhash/IPFS, ship the contents of dist/ (static bundle).
If deploying to Netlify/Vercel, set build command to vite build and publish directory to dist.

Project structure
This repo uses a “root files” layout for the app code and a tiny src/ folder only for the vendor shim:

graphql
Always show details

Copy
.
├─ index.html                 # App shell (injects runtime env → window.__ENV__)
├─ vite.config.ts             # Vite config (Buffer inject, borsh compat alias, base config)
├─ package.json
├─ main.ts                    # App bootstrap: wallet connect, Tip Jar, Meme, Jupiter widget
├─ polyfills.ts               # Buffer & small browser shims
├─ config.ts                  # Centralized config (reads VITE_* → import.meta.env or window.__ENV__)
├─ solana.ts                  # RPC pool + backoff + SNS resolve + sendTip + recent tips + Solana Pay link
├─ solanapay.ts               # Helpers for deep link + QR
├─ tipjar.ts                  # UI wiring for connect/send/QR modal/feed refresh
├─ meme.ts                    # Meme API mode + local canvas mode
├─ jup.ts                     # Jupiter widget bootstrap
├─ modal.ts                   # Simple modal helpers
├─ toast.ts                   # Tiny toast helper
└─ src/
   └─ vendor/
      └─ borsh-compat.ts      # Provides serialize/deserialize/* named exports for web3.js bundling
If you ever migrate to a classic src/ layout for all code, update index.html script src accordingly (e.g., /src/main.ts).

Core features & how they work
1) RPC pool + failover (solana.ts)
Pool selection: reads MAINNET/DEVNET endpoints from CONFIG, which merges VITE_RPC_* and defaults.

Rotation & backoff: a withFailover() wrapper rotates on HTTP 429, network timeouts, and CORS 403/401, with jittered backoff.

Consistency: uses at least confirmed commitment for signature fetches to satisfy @solana/web3.js.

Recent tips: pulls getSignaturesForAddress(recipient, { limit: 20 }), loads each tx via getTransaction(), computes recipient lamport delta, and returns the latest 10 { sol, sig, from, when }.

Avoid “multichain” proxies for Solana JSON-RPC. Use direct Solana RPCs (Helius, api.mainnet-beta.solana.com, etc.).

2) Tip sending (sendTip)
Builds a versioned transfer transaction to the configured recipient.

Uses the connected wallet’s signAndSendTransaction.

Light confirmation strategy to avoid rate-limit “storms.”

3) SNS (.sol) support
Optional .sol like stonkystonkster.sol is resolved to a public key (Bonfida SNS). If valid, it replaces the configured wallet as the tip destination.

UI displays a shortened recipient (first/last 4).

4) Solana Pay + QR
Generates solana:<pubkey>?amount=...&label=...&message=....

Mobile: deep-links Phantom; Desktop: shows a QR modal (and copy-link).

Canvas QR fallback keeps the dependency footprint minimal.

5) Jupiter Plugin (Swap to SOL inline)
index.html loads https://plugin.jup.ag/plugin-v1.js with defer.

jup.ts mounts the widget with:

integratedTargetId: 'jup-widget'

passThroughWallet: window.solana (uses the same Phantom session)

cluster-appropriate endpoint from config.

6) Meme shrine
Local mode: upload image → add text → render on canvas → download.

API templates (optional): wire a meme API for templates/search if desired.

Environment
We support both:

Build-time: import.meta.env.VITE_* via .env.* files.

Runtime (gateway): window.__ENV__ injected in index.html (Vite replaces %VITE_*% at build).

Required keys (examples shown with contest domain):

ini
Always show details

Copy
# Cluster
VITE_DEFAULT_CLUSTER=mainnet   # or devnet

# Destination wallet (base58) — REQUIRED
VITE_OWNER_WALLET=HeGffZqFhB9euhind4aJFWy8waLCppTkie4gvW8bQhzp

# Optional .sol you display (and try to resolve)
VITE_OWNER_SOL_DOMAIN=stonkystonkster.sol

# Mainnet RPC pool — Helius first (allowlist your gateway), then public
VITE_RPC_MAINNET=https://mainnet.helius-rpc.com/?api-key=<KEY>,https://api.mainnet-beta.solana.com

# Devnet RPC pool (optional)
VITE_RPC_DEVNET=https://api.devnet.solana.com
File names that Vite recognizes

.env (shared), .env.development (dev server), .env.production (build).

Only variables prefixed with VITE_ are exposed to the client.

Avoid wildcard placeholders in comments (e.g., %VITE_*%) — Vite scans HTML and will warn. Use explicit examples (%VITE_DEFAULT_CLUSTER%).

Build & deploy
Local
bash
Always show details

Copy
npm run dev         # Vite dev server
npm run build       # emits /dist
npm run preview     # serves /dist locally
Webhash (GitHub-only host)
Two ways to feed Webhash a static site:

A) Push only the build (dist/) as its own repo (recommended)

npm run build

cd dist && git init && git add -A && git commit -m "webhash static build"

Create an empty GitHub repo, then:
git remote add origin https://github.com/<you>/<repo>.git && git branch -M main && git push -u origin main

In Webhash: select the repo → No build / Static → Publish directory: / → Deploy.

B) Push source and let Webhash build

Build command: npm ci && npm run build

Publish directory: dist

Add your VITE_* env in Webhash. (Your RPC key is public in the bundle either way—see Security.)

Link the SNS domain
After deploy, set SNS URL or IPFS record to your Webhash URL/CID.

Test via https://stonkystonkster.sol-domain.org (SNS gateway) or Brave’s address bar (stonkystonkster.sol).

RPC allowlist (Helius)
Add the exact gateway origin (your final Webhash/SNS URL host) to Helius Allowed Origins to avoid 401/403 in the browser.

Vite config notes
Key lines from vite.config.ts:

ts
Always show details

Copy
import inject from '@rollup/plugin-inject';

export default defineConfig(({ mode }) => {
  const isProd = mode === 'prod' || mode === 'production';
  return {
    base: isProd ? './' : '/',                // relative paths for gateways
    plugins: [inject({ Buffer: ['buffer', 'Buffer'] })],
    define: { 'process.env': {} },
    resolve: {
      alias: [
        // Make CJS borsh look like it has named exports for web3.js
        { find: /^borsh$/, replacement: new URL('src/vendor/borsh-compat.ts', import.meta.url).pathname },
      ],
    },
    optimizeDeps: { include: ['buffer'] },
    build: { sourcemap: false, commonjsOptions: { transformMixedEsModules: true } },
  };
});
And the compat shim at src/vendor/borsh-compat.ts:

ts
Always show details

Copy
// Make borsh's CommonJS exports look like named ESM exports for web3.js.
// @ts-ignore deep path is intentional for borsh@0.7.x
import * as b from 'borsh/lib/index.js';

export const { serialize, deserialize, deserializeUnchecked, BinaryReader, BinaryWriter } = b as any;
export default b as any;
Troubleshooting
Build error: "serialize" is not exported by borsh
→ Keep the borsh compat alias above so @solana/web3.js resolves expected named exports.

Vite warning: %VITE_*% is not defined
→ Add missing keys to .env.production or remove unused placeholders from index.html (even comments trigger warnings).

Vite error: Could not resolve entry module "prod/index.html"
→ Don’t pass a fake “root” to vite build. Use vite build (or --mode production), not vite build prod.

RPC 401/403 / CORS
→ Your RPC (e.g., Helius) needs the final origin in its allowlist. Add your Webhash/SNS gateway host.

429 Too Many Requests
→ Natural when hammering free/public RPCs. We rotate providers and back off; add a paid RPC to smooth tests.

Gateway loads but assets 404
→ Ensure base: './' in prod and you uploaded the built bundle (the dist/ contents).

Jupiter plugin not visible
→ Ensure plugin script tag is present, deferred, and initJupiterPlugin() runs after DOM is ready; also that #jup-widget exists.

Scripts
json
Always show details

Copy
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173"
  }
}
Security notes
This is a client-only app. Never embed private keys.

Treat your RPC key as public once bundled; protect it with Allowed Origins.

Consider rotating keys if ever committed to a public repo.

Roadmap / Ideas
Tip memos (e.g., “from: @handle”) and filtering by memo.

USDC tips (or swap-then-send).

Serverless webhook (Helius) → verified leaderboard.

Theming & light/dark mode; branded QR.

Tailwind via PostCSS build (drop CDN).

What to change first
Set env for mainnet in .env.production:

ini
Always show details

Copy
VITE_DEFAULT_CLUSTER=mainnet
VITE_OWNER_WALLET=<your base58>
VITE_OWNER_SOL_DOMAIN=stonkystonkster.sol
VITE_RPC_MAINNET=https://mainnet.helius-rpc.com/?api-key=<key>,https://api.mainnet-beta.solana.com
npm run build → upload dist/ via Webhash.

Link SNS URL/IPFS to the deployed site.

Add the gateway origin to Helius allowlist.

Smoke test in a normal browser + Phantom in-app browser.

python
Always show details

Copy

# Write the README to the project path
with open('/mnt/data/README.md', 'w', encoding='utf-8') as f:
    f.write(readme)

print("README.md updated at /mnt/data/README.md")