# Sentinel — Compliance Management MVP (Demo)

Working vertical slice for a critical access hospital + outpatient clinic demo,
with a secondary cannabis-microbusiness configuration showing model portability.

> **Simulated build. Not production-ready.** Auth, authorization, audit
> tamper-evidence, and all compliance content are simulated for demonstration.
> No real patient data — the seed data is entirely synthetic.

## Stack (all free, local-only)

- TypeScript + React 18 + Vite (dashboard)
- Express API + local JSON document store (`./data/sentinel.json`, created on first run)
- Node built-in test runner via `tsx --test` (no test framework dependency)

## Commands

```bash
npm install
npm run dev      # API on :4000 + dashboard with hot reload on :5173
npm test         # append-only audit, RBAC, and seed-data tests
npm run typecheck
npm start        # production-style single-port launch (builds, serves :4000)
```

Open the dashboard: **http://localhost:5173** (after `npm run dev`),
or **http://localhost:4000** (after `npm start`).

Reset demo data: stop the server and delete `./data/sentinel.json`.

## Demo guide

1. Pick an organization: **North Pine Critical Access Hospital** (25 beds),
   **North Pine Outpatient Clinic**, or the **cannabis microbusiness** config.
2. Switch demo users to feel role differences (simulated login):
   - Staff can only submit their own tasks.
   - Managers can manage org tasks but cannot verify.
   - Only the Compliance Officer / Administrator can verify.
3. Open a task to add evidence, transfer custody, and see its append-only
   record history. Every change lands in the hash-chained audit log below.

## Tenant isolation (simulated demo rules)

- Managers and staff see and change only their own organization (enforced by the API, not just the dashboard).
- Administrators and compliance officers have documented cross-organization demo access.
- Every audit event carries its organization's id; pre-existing events are backfilled on load.
- Audit hash versions: pre-F1 (v1) events carry a backfilled, **unhashed** `orgId`; new (v2) events bind `orgId` into the hash. Accepted for the demo — the data will be reset before judging, making every event v2.

## API sketch

- `GET /api/health|orgs|users` (public, for demo bootstrap)
- `GET /api/tasks?orgId=`, `POST /api/tasks`, `PATCH /api/tasks/:id`
- `POST /api/tasks/:id/evidence`, `POST /api/tasks/:id/transfer`
- `GET /api/templates?orgId=&controlType=`, `POST /api/templates`, `PATCH /api/templates/:id`
- `POST /api/templates/:id/instantiate` — create a task from a template
- `GET /api/audit?recordId=&limit=` — read-only; no write routes exist

Authenticated routes require an `x-demo-user-id` header (simulated).
