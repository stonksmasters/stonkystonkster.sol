// vite.config.ts
import { defineConfig } from 'vite'
import inject from '@rollup/plugin-inject'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const r = (p: string) => path.resolve(__dirname, p)

export default defineConfig(async ({ command }) => {
  const plugins: any[] = [
    inject({
      Buffer: ['buffer', 'Buffer'],
    }),
  ]

  // No need for @vitejs/plugin-basic-ssl; skip entirely to avoid peer conflicts

  return {
    plugins,
    define: {
      'process.env': {}, // some libs check this
    },
    resolve: {
      alias: {
        // Force ANY `import 'borsh'` (including from node_modules) to use our shim
        borsh: r('src/shims/borsh.ts'),
      },
    },
    optimizeDeps: {
      include: ['buffer'],
    },
    build: {
      // make sure CJS interop is fully enabled; harmless but helpful
      commonjsOptions: {
        transformMixedEsModules: true,
      },
      sourcemap: false,
    },
  }
})
