// Emits a classic (non-module) IIFE bundle that scripts/make-standalone.mjs then inlines into a
// single play.html. file:// refuses ES module <script>, so `format: 'iife'` is the whole point.
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    outDir: '.standalone-build',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'bundle.js', assetFileNames: '[name][extname]' } },
  },
  worker: { format: 'iife' },
});
