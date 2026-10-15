/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Firebase is loaded with import() (src/lib/cloud.ts), so normally the browser only asks for it
// once the app's own code has downloaded and run. Every start needs it straight away (sign-in and
// the trip list), so this tells the browser to fetch it alongside the app code instead.
function preloadFirebase(): Plugin {
  return {
    name: 'gowander-preload-firebase',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const chunks = Object.values(ctx.bundle || {}).filter((c) => c.type === 'chunk' && c.name === 'firebase');
        return chunks.map((c) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: '', href: `./${c.fileName}` }, injectTo: 'head' as const }));
      },
    },
  };
}

export default defineConfig({
  // Relative paths, so the built site works under any folder (e.g. github.io/GoWander/).
  base: './',
  plugins: [react(), preloadFirebase()],
  build: {
    outDir: 'dist',
    // scripts/postbuild.mjs reads this to write the offline cache list into sw.js.
    manifest: true,
    sourcemap: true,
    target: 'es2020',
    // The Firebase file is big (about 155 kB compressed) but loads alongside the app; see above.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // One Firebase file (app + sign-in + database), named so it can be preloaded.
        manualChunks: (id) => (/[\\/]node_modules[\\/](@?firebase)[\\/]/.test(id) ? 'firebase' : undefined),
      },
    },
  },
  server: { port: 8090, strictPort: true },
  preview: { port: 8090, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
