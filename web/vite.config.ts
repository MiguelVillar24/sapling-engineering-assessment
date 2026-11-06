import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000 (npm run dev); in the demo build the server serves this app itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
