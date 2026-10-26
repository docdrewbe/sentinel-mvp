// Sentinel MVP entry point: loads (or seeds) the local JSON store, serves the
// API, and serves the built dashboard from ./dist when it exists.
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { findOrphanedTempFiles, findTasksMissingSubmissionHistory, loadDb, saveDb } from './store.js';
import { seedDatabase } from './seed.js';
import { UNKNOWN_AUDIT_ORG } from '../shared/types.js';

for (const orphan of findOrphanedTempFiles()) {
  console.warn(
    `[sentinel] WARNING: orphaned temp file from an interrupted save (NOT auto-applied): ${orphan}`
  );
}

const db = loadDb();
if (db.orgs.length === 0) {
  Object.assign(db, seedDatabase());
  saveDb(db);
  console.log('Seeded synthetic demo data (simulated; no real patient data).');
}

const unknownCount = db.audit.filter((e) => e.orgId === UNKNOWN_AUDIT_ORG).length;
if (unknownCount > 0) {
  console.warn(
    `[sentinel] WARNING: ${unknownCount} audit event(s) with unknown organization (visible to admins/officers only).`
  );
}

const untrusted = findTasksMissingSubmissionHistory(db);
if (untrusted.length > 0) {
  console.warn(
    `[sentinel] WARNING: ${untrusted.length} submitted task(s) without trustworthy submission history (verification refused until send-back + resubmit): ${untrusted.join(', ')}`
  );
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
