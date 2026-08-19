import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN || 'http://localhost:3100';

// During development Vite serves the UI and proxies API + WebSocket traffic to
// the Node server. In production the Node server serves ./dist itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same network while developing
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: true },
      '/socket.io': { target: SERVER_ORIGIN, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
