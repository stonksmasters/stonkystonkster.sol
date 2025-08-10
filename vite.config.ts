// vite.config.ts
import { defineConfig } from 'vite';
import inject from '@rollup/plugin-inject';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';

  return {
    plugins: [
      // Provides global Buffer in browser bundles
      inject({
        Buffer: ['buffer', 'Buffer'],
      }),
    ],
    define: {
      // Some deps check this; stub it for browser
      'process.env': {},
    },
    resolve: {
      alias: {
        // Force ANY `import 'borsh'` (even inside node_modules) to use our shim
        borsh: r('src/shims/borsh.ts'),
      },
    },
    optimizeDeps: {
      include: ['buffer'],
    },
    build: {
      target: 'es2020', // web3.js & modern libs play nice here
      sourcemap: !isBuild ? true : false, // set to `true` if you need prod debugging
      minify: true, // set to false temporarily if you need readable stacks
      commonjsOptions: {
        transformMixedEsModules: true,
      },
      // treeshake: true, // (enabled by default)
    },
    server: {
      https: false, // no @vitejs/plugin-basic-ssl needed
    },
    preview: {
      https: false,
    },
  };
});
