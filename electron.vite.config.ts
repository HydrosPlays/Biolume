import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { main: resolve(__dirname, 'src/main/main.ts') },
      },
    },
  },
  // The preload lives beside main.ts (src/main/preload.ts) rather than in the
  // electron-vite default src/preload/, so its entry is declared explicitly.
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { preload: resolve(__dirname, 'src/main/preload.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
