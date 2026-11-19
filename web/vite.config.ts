import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020', sourcemap: false, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://localhost:8080' }, fs: { allow: ['..'] } },
});
