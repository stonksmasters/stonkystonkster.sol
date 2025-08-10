// vite.config.ts
import { defineConfig } from 'vite'
import inject from '@rollup/plugin-inject'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const r = (p: string) => path.resolve(__dirname, p)

export default defineConfig({
  plugins: [
    inject({
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
  define: {
    'process.env': {},
  },
  resolve: {
    alias: [
      // 👇 exact-match only, so "borsh/lib/..." is NOT aliased
      { find: /^borsh$/, replacement: r('src/shims/borsh.ts') },
    ],
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  build: {
    commonjsOptions: { transformMixedEsModules: true },
    sourcemap: false,
  },
})
