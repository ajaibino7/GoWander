/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Tells the browser to fetch what every start needs alongside the app code, instead of only once
// the code asks for it:
//   - Firebase, loaded with import() (src/lib/cloud.ts) but needed at once (sign-in, trip list);
//   - the main font files, which the browser otherwise finds only after applying the CSS.
function preloadCritical(): Plugin {
  return {
    name: 'gowander-preload-critical',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.values(ctx.bundle || {});
        const firebase = files.filter((c) => c.type === 'chunk' && c.name === 'firebase')
          .map((c) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: '', href: `./${c.fileName}` }, injectTo: 'head' as const }));
        // Lato's three Latin font files (regular, bold, black) that every page uses: fetched with
        // the stylesheet, so the first paint already has the right font (no visible swap).
        const fonts = files.filter((a) => a.type === 'asset' && /^assets\/lato-latin-(400|700|900)-normal-.*\.woff2$/.test(a.fileName))
          .map((a) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `./${a.fileName}` }, injectTo: 'head-prepend' as const }));
        return [...fonts, ...firebase];
      },
    },
  };
}

export default defineConfig({
  // Relative paths, so the built site works under any folder (e.g. github.io/GoWander/).
  base: './',
  plugins: [react(), preloadCritical()],
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
