// Sentinel MVP entry point: loads (or seeds) the local JSON store, serves the
// API, and serves the built dashboard from ./dist when it exists.
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadDb, saveDb } from './store.js';
import { seedDatabase } from './seed.js';

const db = loadDb();
if (db.orgs.length === 0) {
  Object.assign(db, seedDatabase());
  saveDb(db);
  console.log('Seeded synthetic demo data (simulated; no real patient data).');
}

const app = createApp(db);
const port = Number(process.env.PORT ?? 4000);

const dist = join(process.cwd(), 'dist');
if (existsSync(join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Sentinel API listening on http://localhost:${port}`);
});
