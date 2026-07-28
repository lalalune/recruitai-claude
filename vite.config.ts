import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/renderer',
  // Absolute '/assets/...' breaks under the app:// protocol in production.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // Matches Electron 43's Chromium; no needless downlevelling.
    target: 'chrome150',
    sourcemap: false,
  },
  server: { port: 5183, strictPort: true },
});
