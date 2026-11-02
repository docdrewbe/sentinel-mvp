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
    // Anchor to THIS checkout's ignored scratch dir and its backup/evidence
    // tree. A loose '**/.tmp/**' also matches ancestor .tmp segments, which
    // would blind the watcher for checkouts nested under .tmp. Absolute +
    // Vite-normalized. data/backups holds QA evidence and pre-run backups
    // that are written while the dev server runs (EBUSY crash, 2026-11-02).
    watch: {
      ignored: [
        `${normalizePath(resolve(configDir, '.tmp'))}/**`,
        `${normalizePath(resolve(configDir, 'data', 'backups'))}/**`
      ]
    }
  }
});
