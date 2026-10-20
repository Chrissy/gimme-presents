import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare({
    persistState: process.env.GIMME_LOCAL_STATE_DIR
      ? { path: process.env.GIMME_LOCAL_STATE_DIR } : true,
  })],
  server: { port: 5173, strictPort: true },
});
