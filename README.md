# Sentinel: evidence-first compliance management for small, regulated organizations

**Meta x Cerebral Valley Global Hackathon. Startup track. Problem statement: Build for Your World.**
**Built during the hackathon:** every commit in this repository, from the first ("Sentinel MVP - Day 1 Foundation", 2026-10-26 12:32 CT, after kickoff) to the submission.
**Demo video:** [youtu.be/qxsAhNRAH84](https://youtu.be/qxsAhNRAH84) · **How we use Meta models:** [docs/META-MODEL-USAGE.md](docs/META-MODEL-USAGE.md)

© 2026 Drew Duffy. Source available for review and evaluation (including by Meta Global Hackathon judges) under the PolyForm Strict License 1.0.0. No commercial use, modification or redistribution without written permission.

## The problem
- The United States has more than 1,300 critical access hospitals ([Flex Monitoring Team](https://www.flexmonitoring.org/node/12286)): small rural hospitals of 25 beds or fewer.
- They answer to the same regulators as large systems (CMS conditions of participation, HIPAA, OSHA, accreditation), usually with a compliance team of one or two people and spreadsheets.
- The hard part isn't knowing the rules. It's **proving** the work was done, by the right person, on time, with evidence that holds up when a surveyor asks.
- Sentinel's founder has spent 23 years in healthcare and regulatory compliance and built Sentinel for those teams.

## What Sentinel does
1. **Tracks compliance work with real accountability:**
   - recurring obligations and calendars in each organization's local time zone;
   - evidence required before submission;
   - an independent verifier who can't be the person who did the work;
   - verified records locked against later edits.
2. **Keeps evidence defensible:** chain of custody for every piece of evidence, and a hash-chained audit log that shows tampering.
3. **Uses Meta's Muse Spark Open model to find what changed between policy versions.** Every finding quotes its source word for word, the server verifies each quote, and a person decides before anything becomes a task. [Details](docs/META-MODEL-USAGE.md).
4. **Closes the loop:**
   - corrective and preventive actions (CAPA) with effectiveness reviews;
   - staff concern reporting;
   - safety notices with human review;
   - read-only survey and inspection packets with printable integrity checks.
5. **Works for other regulated industries.** The same engine runs a Minnesota cannabis microbusiness under the Office of Cannabis Management. A Minnesota security-and-access checklist uses Muse Spark to suggest the policy sentence for each requirement. Every quote is verified on the server, and the reviewer decides every item.

## Built to hold up
- Crash-safe saves (atomic write and rename) and strict organization isolation.
- Separation of duties enforced on the server.
- An independent QA log with reproducible evidence for every slice.
- 632 product tests, all passing.
- A 164-check verification suite for the real-model launcher. It runs in an isolated scratch folder against temporary databases. QA runs it under a network guard that blocks all non-local connections.
- All demo data is synthetic. No patient data. Sign-in is simulated in this MVP.
- Sentinel does not give medical advice.

## Limits (stated honestly)
- Authentication is simulated, and the audit chain isn't yet anchored externally.
- The AI features give leads for a person to review. They don't certify compliance.

---
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
- Legacy events whose record is gone are marked `unknown` (fail-closed: admins/officers only); genuine system events stay `system`.
- Only database-level events may use the `system` marker visibly to all: legacy mis-tagged events are reclassified from their records on load (v1 only — v2 hashes are never rewritten), and forged `system` tags on tenant records are contained to privileged roles.
- Known prototype limit: the audit chain detects edits to stored events, but a fully recomputed chain (every hash redone after tampering) still verifies. Until the head hash is anchored outside the data file, fully recomputed chains are outside the tamper-detection guarantees.
- Audit hash versions: pre-F1 (v1) events carry a backfilled, **unhashed** `orgId`; new (v2) events bind `orgId` into the hash. Accepted for the demo — the data will be reset before judging, making every event v2.

## API sketch

- `GET /api/health|orgs|users` (public, for demo bootstrap)
- `GET /api/tasks?orgId=`, `POST /api/tasks`, `PATCH /api/tasks/:id`
- `POST /api/tasks/:id/evidence`, `POST /api/tasks/:id/transfer`
- `GET /api/templates?orgId=&controlType=`, `POST /api/templates`, `PATCH /api/templates/:id`
- `POST /api/templates/:id/instantiate` — create a task from a template
- `GET /api/audit?recordId=&limit=` — read-only; no write routes exist

Authenticated routes require an `x-demo-user-id` header (simulated).
