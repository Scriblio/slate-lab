import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const client = resolve(import.meta.dirname, 'src/client');

export default defineConfig({
  root: client,
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dj: resolve(client, 'dj.html'),
        display: resolve(client, 'display.html'),
        join: resolve(client, 'join.html'),
      },
    },
  },
});
