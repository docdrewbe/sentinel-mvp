import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
    // Anchor to THIS checkout's ignored scratch dir. A loose '**/.tmp/**'
    // also matches ancestor .tmp segments, which would blind the watcher
    // for checkouts nested under .tmp. Absolute + Vite-normalized.
    watch: { ignored: [`${normalizePath(resolve(configDir, '.tmp'))}/**`] }
  }
});
