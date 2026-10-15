/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative paths, so the built site works under any folder (e.g. github.io/GoWander/).
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // scripts/postbuild.mjs reads this to write the offline cache list into sw.js.
    manifest: true,
    sourcemap: true,
    target: 'es2020',
  },
  server: { port: 8090, strictPort: true },
  preview: { port: 8090, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
