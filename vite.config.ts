import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The dev server and an e2e run must be able to coexist, so the ports can be moved out of the way.
const apiPort = Number(process.env.API_PORT || 4310);
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
