// vite.config.ts
import { defineConfig } from 'vite'
import inject from '@rollup/plugin-inject'

export default defineConfig(({ mode }) => {
  const isProd = mode === 'prod' || mode === 'production'

  return {
    // Use relative paths in prod for IPFS/SNS gateways
    base: isProd ? './' : '/',
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
        // borsh compat shim so web3.js named imports work
        { find: /^borsh$/, replacement: new URL('src/vendor/borsh-compat.ts', import.meta.url).pathname },
      ],
    },
    optimizeDeps: {
      include: ['buffer'],
    },
    build: {
      commonjsOptions: { transformMixedEsModules: true },
      sourcemap: false,
    },
  }
})
