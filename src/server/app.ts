// Express API for the Sentinel MVP.
//
// SIMULATED authentication (x-demo-user-id header; demo user switcher in the
// UI) and SIMULATED authorization. Not production-ready.
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import {
  ValidationError,
  addEvidence,
  appendAudit,
  assertLegalCapaTransition,
  capaAddEvidence,
  capaTransferCustody,
  createCapa,
  createObligation,
  createTask,
  createTemplate,
  generateObligationInstance,
  instantiateTemplate,
  mutateDb,
  monotonicNow,
  transferCustody,
  updateCapa,
  updateObligation,
  updateTask,
  updateTemplate,
  verifyAuditChain,
  type DbShape
} from './store.js';
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import {
  NO_MATCHING_PASSAGE,
  PROVIDER_NOT_CONFIGURED,
  ProviderError,
  checkDocAuditThrottle,
  currentTimeoutMs,
  resolveProvider,
  validateCompareInput,
  validateProviderOutput
} from './docaudit.js';
import { requiredEvidenceCount } from '../shared/evidence.js';
import {
  capaGateMissing,
  capaNoEligibleReviewer,
  capaReviewIneligible,
  nonStringField,
  qualifyingEffectivenessEvidence
} from '../shared/capa.js';
import { ineligibleVerifiers, missingSubmissionHistory, noEligibleVerifier } from '../shared/verification.js';
import type { CapaRecord, CapaStatus, ComplianceTask, DemoUser } from '../shared/types.js';
import { CAPA_CLOSE_SOD_MESSAGE, CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE, NO_ELIGIBLE_VERIFIER_MESSAGE, SEPARATION_OF_DUTIES_MESSAGE, SUBMITTER_UNKNOWN_MESSAGE, SYSTEM_AUDIT_ORG, UNKNOWN_AUDIT_ORG } from '../shared/types.js';

export interface AuthRequest extends Request {
  user?: DemoUser;
  task?: ComplianceTask;
}

function sendError(req: Request, res: Response, e: unknown): void {
  if (e instanceof ValidationError) {
    res.status(400).json({ error: e.message });
    return;
  }
  // Provider failures carry fixed messages only (never comparison content),
  // so they answer directly without touching the error log.
  if (e instanceof ProviderError) {
    res.status(e.status).json({ error: e.message });
    return;
  }
  console.error(`[sentinel] ${req.method} ${req.path} failed:`, e);
  res.status(500).json({ error: 'Internal error.' });
}

function forbidden(res: Response, user: DemoUser, action: string): void {
  res.status(403).json({ error: `Role '${user.role}' may not perform '${action}' here.` });
}

/** P2: non-string text input is a 400 naming the field, never a 500. */
function rejectBadText(res: Response, body: unknown, fields: string[]): boolean {
  const bad = nonStringField(body as Record<string, unknown>, fields);
  if (!bad) return false;
  res.status(400).json({ error: `${bad} must be text.` });
  return true;
}

export function createApp(db: DbShape): express.Express {
  const app = express();
  app.use(cors());
  // WM1-1: explicit body limit (the previous effective default), so the 413
  // path below is a defined contract rather than an accident of defaults.
  app.use(express.json({ limit: '100kb' }));

  // Public demo endpoints (org/user pickers need these before login).
  app.get('/api/health', (_req, res) => {
    const chain = verifyAuditChain(db.audit);
    res.json({
      ok: true,
      service: 'sentinel-mvp',
      simulated: true,
      orgs: db.orgs.length,
      tasks: db.tasks.length,
      auditEvents: db.audit.length,
      auditChainOk: chain.ok
    });
  });
  app.get('/api/orgs', (_req, res) => res.json(db.orgs));
  app.get('/api/users', (_req, res) => res.json(db.users));

  // Simulated auth for everything below.
  app.use('/api', (req: AuthRequest, res: Response, next: NextFunction) => {
    const id = req.header('x-demo-user-id') ?? '';
    const user = db.users.find((u) => u.id === id);
    if (!user) {
      res.status(401).json({ error: 'Missing or unknown x-demo-user-id (simulated demo auth).' });
      return;
    }
    req.user = user;
    next();
  });

  const need =
    (action: Action) =>
    (req: AuthRequest, res: Response, next: NextFunction): void => {
      const user = req.user as DemoUser;
      const task = db.tasks.find((t) => t.id === req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }
      if (!can(user, action, task)) {
        forbidden(res, user, action);
        return;
      }
      req.task = task;
      next();
    };

  /** Resolve which orgs a read may return; 403 with no records when forbidden. */
  const readScope = (req: AuthRequest, res: Response): string[] | null => {
    const user = req.user as DemoUser;
    const allowed = visibleOrgIds(user, db.orgs.map((o) => o.id));
    const requested = String(req.query.orgId ?? '');
    if (requested && !allowed.includes(requested)) {
      res.status(403).json({ error: `Organization not visible to role '${user.role}'.` });
      return null;
    }
    return requested ? [requested] : allowed;
  };

  const orgForbidden = (req: AuthRequest, res: Response): void => {
    const user = req.user as DemoUser;
    res.status(403).json({ error: `Organization not visible to role '${user.role}'.` });
  };

  // D4c: attach the authoritative evidence requirement to task responses.
  // Computed per response from live templates, never written to the store.
  const presentTask = (task: ComplianceTask): ComplianceTask => ({
    ...task,
    requiredEvidence: requiredEvidenceCount(task, db.templates)
  });

  // C3: SoD message, or the deadlock variant when nobody privileged remains.
  const capaReviewerMessage = (capa: CapaRecord): string => {
    const privileged = db.users
      .filter((u) => u.role === 'administrator' || u.role === 'compliance_officer')
      .map((u) => u.id);
    return capaNoEligibleReviewer(capa, privileged)
      ? CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE
      : CAPA_CLOSE_SOD_MESSAGE;
  };

  app.get('/api/domains', (req: AuthRequest, res) => {
    const scope = readScope(req, res);
    if (!scope) return;
    res.json(db.domains.filter((d) => scope.includes(d.orgId)));
  });

  app.get('/api/tasks', (req: AuthRequest, res) => {
    const scope = readScope(req, res);
    if (!scope) return;
    const status = String(req.query.status ?? '');
    const ownerId = String(req.query.ownerId ?? '');
    res.json(
      db.tasks
        .filter(
          (t) =>
            scope.includes(t.orgId) &&
            (!status || t.status === status) &&
            (!ownerId || t.ownerId === ownerId)
        )
        .map(presentTask)
    );
  });

  app.post('/api/tasks', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const input = req.body as {
      orgId: string;
      domainId: string;
      title: string;
      ownerId: string;
      dueDate: string;
    };
    if ((user.role === 'department_manager' || user.role === 'staff') && input.orgId !== user.orgId) {
      forbidden(res, user, 'task.create');
      return;
    }
    if (!can(user, 'task.create')) {
      forbidden(res, user, 'task.create');
      return;
    }
    try {
      const task = mutateDb(db, () => {
        const created = createTask(db, input);
        appendAudit(db, {
          actorId: user.id,
          action: 'task.created',
          recordType: 'task',
          recordId: created.id,
          orgId: created.orgId,
          detail: created.title
        });
        return created;
      });
      res.status(201).json(presentTask(task));
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // Phase 1: document-audit comparison. Pasted inputs and provider output are
  // response-only; only metadata (counts, provider name) reaches the audit
  // log. Nothing here persists comparison content or logs it.
  app.post('/api/docaudit/compare', async (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    if (rejectBadText(res, req.body, ['orgId', 'textA', 'textB'])) return;
    const input = req.body as { orgId: string; textA: string; textB: string };
    if ((user.role === 'department_manager' || user.role === 'staff') && input.orgId !== user.orgId) {
      forbidden(res, user, 'docaudit.run');
      return;
    }
    if (!can(user, 'docaudit.run', { orgId: input.orgId, ownerId: '' })) {
      forbidden(res, user, 'docaudit.run');
      return;
    }
    if (!db.orgs.some((o) => o.id === input.orgId)) {
      res.status(400).json({ error: 'Unknown organization.' });
      return;
    }
    try {
      const clean = validateCompareInput(input);
      // WM1-1: availability before quota — refused requests must not consume
      // throttle budget. Auth and authorization checks above stay first.
      const provider = resolveProvider();
      if (!provider) {
        res.status(503).json({ error: PROVIDER_NOT_CONFIGURED });
        return;
      }
      if (!checkDocAuditThrottle(user.id)) {
        res.status(429).json({ error: 'Comparison limit reached. Try again later.' });
        return;
      }
      const signal = AbortSignal.timeout(currentTimeoutMs());
      let raw: unknown;
      try {
        raw = await provider.compare({ textA: clean.textA, textB: clean.textB }, signal);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (signal.aborted) throw new ProviderError(504, 'Comparison timed out.');
        throw new ProviderError(502, 'Comparison failed.');
      }
      const findings = validateProviderOutput(raw, clean.textA, clean.textB);
      const runId = randomUUID();
      const byKind = (kind: string): number => findings.filter((f) => f.kind === kind).length;
      mutateDb(db, () => {
        appendAudit(db, {
          actorId: user.id,
          action: 'docaudit.completed',
          recordType: 'docaudit',
          recordId: runId,
          orgId: input.orgId,
          detail:
            `${findings.length} findings ` +
            `(difference ${byKind('difference')}, missing_in_a ${byKind('missing_in_a')}, ` +
            `missing_in_b ${byKind('missing_in_b')}) via ${provider.name}`
        });
      });
      res.json({
        provider: provider.name,
        ...(provider.notice ? { notice: provider.notice } : {}),
        runId,
        missingLabel: NO_MATCHING_PASSAGE,
        findings
      });
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.patch('/api/tasks/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const task = db.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(task.orgId)) {
      orgForbidden(req, res);
      return;
    }
    const patch = req.body as {
      title?: string;
      ownerId?: string;
      dueDate?: string;
      domainId?: string;
      status?: 'open' | 'in_progress' | 'submitted' | 'verified';
    };
    try {
      if (patch.status !== undefined && patch.status !== task.status) {
        const action: Action =
          patch.status === 'verified'
            ? 'task.verify'
            : patch.status === 'submitted'
              ? 'task.submit'
              : 'task.update';
        if (!can(user, action, task)) {
          forbidden(res, user, action);
          return;
        }
        // D5/D5a: separation of duties lives here, outside can(), so the
        // role matrix stays simple. Eligibility comes from the full
        // submission/ownership history, not just the current owner.
        if (action === 'task.verify' && task.status === 'submitted') {
          // D5c: fail closed — without a recorded submission there is no
          // trustworthy submitter, so nobody may verify until a send-back
          // and resubmit establish one. Checked before membership, since
          // membership cannot be evaluated without history.
          if (missingSubmissionHistory(task)) {
            res.status(409).json({ error: SUBMITTER_UNKNOWN_MESSAGE });
            return;
          }
          if (ineligibleVerifiers(task).includes(user.id)) {
            // D5b: say so explicitly when the history excludes every
            // privileged user, so the deadlock is diagnosable. No override.
            const privileged = db.users
              .filter((u) => u.role === 'administrator' || u.role === 'compliance_officer')
              .map((u) => u.id);
            res.status(403).json({
              error: noEligibleVerifier(task, privileged)
                ? NO_ELIGIBLE_VERIFIER_MESSAGE
                : SEPARATION_OF_DUTIES_MESSAGE
            });
            return;
          }
        }
      }
      const touchesFields =
        patch.title !== undefined ||
        patch.ownerId !== undefined ||
        patch.dueDate !== undefined ||
        patch.domainId !== undefined;
      if (touchesFields && !can(user, 'task.update', task)) {
        forbidden(res, user, 'task.update');
        return;
      }
      const oldStatus = task.status;
      const ownerBefore = task.ownerId;
      const statusChanged = patch.status !== undefined && patch.status !== oldStatus;
      const updated = mutateDb(db, () => {
        const next = updateTask(db, task.id, patch);
        const now = new Date().toISOString();
        // D5/D5a: record the submission atomically with the transition into
        // `submitted`: latest submitter plus an append-only history entry.
        if (next.status === 'submitted' && oldStatus !== 'submitted') {
          next.submittedBy = user.id;
          next.submissions = [
            ...(next.submissions ?? []),
            {
              seq: (next.submissions ?? []).length + 1,
              submittedBy: user.id,
              ownerAtSubmission: next.ownerId,
              at: now
            }
          ];
        }
        // D5a: reassigning submitted work stays allowed (legitimate cover),
        // but both sides join the ownership-while-submitted record, so the
        // move can never make anyone eligible to verify.
        if (next.ownerId !== ownerBefore && oldStatus === 'submitted') {
          const seen = new Set(next.ownersWhileSubmitted ?? []);
          seen.add(ownerBefore);
          seen.add(next.ownerId);
          next.ownersWhileSubmitted = [...seen];
        }
        // D5d: record the verifier atomically with the transition into
        // `verified`, in the same closure as the status change and audit.
        if (next.status === 'verified' && oldStatus !== 'verified') {
          next.verifiedBy = user.id;
          next.verifiedAt = now;
        }
        const reassigned = next.ownerId !== ownerBefore;
        appendAudit(db, {
          actorId: user.id,
          action: statusChanged ? `task.${next.status}` : 'task.updated',
          recordType: 'task',
          recordId: task.id,
          orgId: task.orgId,
          detail:
            `${next.title} [${oldStatus} -> ${next.status}]` +
            (reassigned ? ` (owner ${ownerBefore} -> ${next.ownerId})` : '')
        });
        return next;
      });
      res.json(presentTask(updated));
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.post('/api/tasks/:id/evidence', need('evidence.add'), (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const target = req.task;
    if (!target) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    try {
      const ref = mutateDb(db, () => {
        const added = addEvidence(
          db,
          req.params.id,
          {
            label: String(req.body.label ?? ''),
            holder: String(req.body.holder ?? '')
          },
          user.id
        );
        appendAudit(db, {
          actorId: user.id,
          action: 'evidence.added',
          recordType: 'task',
          recordId: req.params.id,
          orgId: target.orgId,
          detail: `${added.label} (holder: ${added.holder})`
        });
        return added;
      });
      res.status(201).json(ref);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.post('/api/tasks/:id/transfer', need('custody.transfer'), (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const target = req.task;
    if (!target) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    try {
      const ref = mutateDb(db, () => {
        const reason = String(req.body.reason ?? '').trim() || undefined;
        const { ref: moved, fromHolder } = transferCustody(
          db,
          req.params.id,
          {
            evidenceId: String(req.body.evidenceId ?? ''),
            toHolder: String(req.body.toHolder ?? ''),
            ...(reason ? { reason } : {})
          },
          user.id
        );
        appendAudit(db, {
          actorId: user.id,
          action: 'custody.transferred',
          recordType: 'task',
          recordId: req.params.id,
          orgId: target.orgId,
          detail: `${moved.label}: ${fromHolder} -> ${moved.holder}${reason ? ` — ${reason}` : ''}`
        });
        return moved;
      });
      res.json(ref);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // ---------------------------------------------------------------------------
  // CAPA records (first slice). Tenant isolation, authorization, atomic
  // persistence, and audit chaining reuse the task-route machinery.
  // ---------------------------------------------------------------------------

  app.get('/api/capas', (req: AuthRequest, res) => {
    const scope = readScope(req, res);
    if (!scope) return;
    const status = String(req.query.status ?? '');
    res.json(db.capas.filter((c) => scope.includes(c.orgId) && (!status || c.status === status)));
  });

  app.post('/api/capas', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const input = req.body as {
      orgId: string;
      domainId: string;
      taskId?: string;
      finding: string;
      severity: string;
      ownerId: string;
      dueDate: string;
      containment?: string;
      rootCause?: string;
      correctivePlan?: string;
      preventivePlan?: string;
      effectivenessCriteria?: string;
    };
    if ((user.role === 'department_manager' || user.role === 'staff') && input.orgId !== user.orgId) {
      forbidden(res, user, 'capa.create');
      return;
    }
    if (!can(user, 'capa.create')) {
      forbidden(res, user, 'capa.create');
      return;
    }
    if (
      rejectBadText(res, req.body, [
        'orgId',
        'domainId',
        'taskId',
        'finding',
        'severity',
        'ownerId',
        'dueDate',
        'containment',
        'rootCause',
        'correctivePlan',
        'preventivePlan',
        'effectivenessCriteria'
      ])
    ) {
      return;
    }
    try {
      const capa = mutateDb(db, () => {
        const created = createCapa(db, {
          orgId: input.orgId,
          domainId: input.domainId,
          taskId: input.taskId,
          finding: String(input.finding ?? ''),
          severity: input.severity as CapaRecord['severity'],
          ownerId: input.ownerId,
          dueDate: input.dueDate,
          containment: input.containment,
          rootCause: input.rootCause,
          correctivePlan: input.correctivePlan,
          preventivePlan: input.preventivePlan,
          effectivenessCriteria: input.effectivenessCriteria
        });
        // C3: the creator and initial owner join the involvement record.
        created.createdBy = user.id;
        created.ownerHistory = [
          { ownerId: created.ownerId, from: 'initial', byUserId: user.id, at: monotonicNow() }
        ];
        created.statusHistory = [{ status: 'open', at: monotonicNow(), byUserId: user.id }];
        // P1: criteria supplied at creation open the criteria history.
        if (created.effectivenessCriteria) {
          created.criteriaHistory = [
            {
              seq: 1,
              text: created.effectivenessCriteria,
              byUserId: user.id,
              at: monotonicNow(),
              cycle: 1
            }
          ];
        }
        appendAudit(db, {
          actorId: user.id,
          action: 'capa.created',
          recordType: 'capa',
          recordId: created.id,
          orgId: created.orgId,
          detail: created.finding.slice(0, 120)
        });
        return created;
      });
      res.status(201).json(capa);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.patch('/api/capas/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const capa = db.capas.find((c) => c.id === req.params.id);
    if (!capa) {
      res.status(404).json({ error: 'CAPA not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(capa.orgId)) {
      orgForbidden(req, res);
      return;
    }
    const patch = req.body as {
      finding?: string;
      severity?: string;
      containment?: string;
      rootCause?: string;
      ownerId?: string;
      dueDate?: string;
      domainId?: string;
      correctivePlan?: string;
      preventivePlan?: string;
      effectivenessCriteria?: string;
      status?: CapaStatus;
    };
    try {
      if (patch.status !== undefined && patch.status !== capa.status) {
        // C5: requesting effectiveness review needs manager-or-above
        // authority; owner-staff may advance only as far as Action In
        // Progress. Unknown statuses fall through to updateCapa.
        const action: Action =
          patch.status === 'closed'
            ? 'capa.close'
            : patch.status === 'effectiveness_review'
              ? 'capa.review.request'
              : 'capa.update';
        if (!can(user, action, capa)) {
          forbidden(res, user, action);
          return;
        }
        // C5: transition legality reports before the closure checks, so an
        // illegal jump never surfaces a gate or independence error.
        assertLegalCapaTransition(capa.status, patch.status);
        if (action === 'capa.close') {
          // C2/C3: closure happens only through an effectiveness review, but
          // an ineligible reviewer is still told so (checked before any
          // mutation, so combined owner+close requests change nothing).
          if (capaReviewIneligible(capa).includes(user.id)) {
            res.status(403).json({ error: capaReviewerMessage(capa) });
            return;
          }
          res.status(400).json({ error: 'Close via an effectiveness review.' });
          return;
        }
      }
      const editedFields = (
        [
          'finding',
          'severity',
          'containment',
          'rootCause',
          'ownerId',
          'dueDate',
          'domainId',
          'correctivePlan',
          'preventivePlan',
          'effectivenessCriteria'
        ] as const
      ).filter((field) => patch[field] !== undefined);
      if (editedFields.length > 0 && !can(user, 'capa.update', capa)) {
        forbidden(res, user, 'capa.update');
        return;
      }
      // P2: type validation sits after authorization but before no-op
      // detection, so unauthorized callers still get 403 first.
      if (
        rejectBadText(res, req.body, [
          'finding',
          'severity',
          'containment',
          'rootCause',
          'ownerId',
          'dueDate',
          'domainId',
          'correctivePlan',
          'preventivePlan',
          'effectivenessCriteria',
          'status'
        ])
      ) {
        return;
      }
      const oldStatus = capa.status;
      const ownerBefore = capa.ownerId;
      const statusChanged = patch.status !== undefined && patch.status !== oldStatus;
      // Polish: a request carrying only ignored or unchanged fields changes
      // nothing, so return the record without an audit event or a save.
      // Authorization above still applies: unauthorized no-ops are rejected.
      const textChanged = (current: string | undefined, incoming: string | undefined): boolean =>
        incoming !== undefined && incoming.trim() !== (current ?? '');
      const fieldChanged =
        textChanged(capa.finding, patch.finding) ||
        (patch.severity !== undefined && patch.severity !== capa.severity) ||
        textChanged(capa.containment, patch.containment) ||
        textChanged(capa.rootCause, patch.rootCause) ||
        (patch.ownerId !== undefined && patch.ownerId !== capa.ownerId) ||
        (patch.dueDate !== undefined && patch.dueDate !== capa.dueDate) ||
        (patch.domainId !== undefined && patch.domainId !== capa.domainId) ||
        textChanged(capa.correctivePlan, patch.correctivePlan) ||
        textChanged(capa.preventivePlan, patch.preventivePlan) ||
        textChanged(capa.effectivenessCriteria, patch.effectivenessCriteria);
      if (!statusChanged && !fieldChanged) {
        res.json(capa);
        return;
      }
      // P1: a real criteria change is a contribution (C3 ineligibility) and
      // extends the append-only criteria history.
      const criteriaChanged =
        typeof patch.effectivenessCriteria === 'string' &&
        patch.effectivenessCriteria.trim() !== (capa.effectivenessCriteria ?? '');
      const updated = mutateDb(db, () => {
        const next = updateCapa(db, capa.id, {
          ...(patch.finding !== undefined ? { finding: patch.finding } : {}),
          ...(patch.severity !== undefined ? { severity: patch.severity as CapaRecord['severity'] } : {}),
          ...(patch.containment !== undefined ? { containment: patch.containment } : {}),
          ...(patch.rootCause !== undefined ? { rootCause: patch.rootCause } : {}),
          ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
          ...(patch.domainId !== undefined ? { domainId: patch.domainId } : {}),
          ...(patch.correctivePlan !== undefined ? { correctivePlan: patch.correctivePlan } : {}),
          ...(patch.preventivePlan !== undefined ? { preventivePlan: patch.preventivePlan } : {}),
          ...(patch.effectivenessCriteria !== undefined
            ? { effectivenessCriteria: patch.effectivenessCriteria }
            : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {})
        });
        if (statusChanged) {
          next.statusHistory = [
            ...(next.statusHistory ?? []),
            { status: next.status, at: monotonicNow(), byUserId: user.id }
          ];
        }
        // C3: reassignment appends (never rewrites) ownership; advancing a
        // phase or editing work content marks the actor as involved.
        if (patch.ownerId !== undefined && next.ownerId !== ownerBefore) {
          next.ownerHistory = [
            ...(next.ownerHistory ?? []),
            { ownerId: next.ownerId, from: 'reassignment', byUserId: user.id, at: monotonicNow() }
          ];
        }
        if (
          statusChanged ||
          patch.containment !== undefined ||
          patch.rootCause !== undefined ||
          patch.correctivePlan !== undefined ||
          patch.preventivePlan !== undefined ||
          criteriaChanged
        ) {
          const actors = new Set(next.actionsBy ?? []);
          actors.add(user.id);
          next.actionsBy = [...actors];
        }
        if (criteriaChanged) {
          const history = next.criteriaHistory ?? [];
          next.criteriaHistory = [
            ...history,
            {
              seq: history.length + 1,
              text: next.effectivenessCriteria ?? '',
              byUserId: user.id,
              at: monotonicNow(),
              cycle: (next.effectivenessReviews ?? []).length + 1
            }
          ];
        }
        appendAudit(db, {
          actorId: user.id,
          action: statusChanged ? `capa.${next.status}` : 'capa.updated',
          recordType: 'capa',
          recordId: capa.id,
          orgId: capa.orgId,
          detail:
            `${next.finding.slice(0, 80)} [${oldStatus} -> ${next.status}]` +
            (editedFields.length > 0 ? ` (fields: ${editedFields.join(', ')})` : '')
        });
        return next;
      });
      res.json(updated);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.post('/api/capas/:id/evidence', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const capa = db.capas.find((c) => c.id === req.params.id);
    if (!capa) {
      res.status(404).json({ error: 'CAPA not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(capa.orgId)) {
      orgForbidden(req, res);
      return;
    }
    if (!can(user, 'capa.evidence.add', capa)) {
      forbidden(res, user, 'capa.evidence.add');
      return;
    }
    if (rejectBadText(res, req.body, ['label', 'holder', 'kind'])) return;
    const kind = req.body.kind;
    if (kind !== undefined && kind !== 'implementation' && kind !== 'effectiveness') {
      res.status(400).json({ error: 'Unknown evidence kind.' });
      return;
    }
    try {
      const ref = mutateDb(db, () => {
        const added = capaAddEvidence(
          db,
          req.params.id,
          {
            label: String(req.body.label ?? ''),
            holder: String(req.body.holder ?? ''),
            ...(kind !== undefined ? { kind } : {})
          },
          user.id
        );
        // C3: adding implementation evidence marks the actor as involved.
        if ((added.kind ?? 'implementation') === 'implementation') {
          const target = db.capas.find((c) => c.id === req.params.id);
          if (target) {
            const actors = new Set(target.actionsBy ?? []);
            actors.add(user.id);
            target.actionsBy = [...actors];
          }
        }
        appendAudit(db, {
          actorId: user.id,
          action: 'evidence.added',
          recordType: 'capa',
          recordId: req.params.id,
          orgId: capa.orgId,
          detail: `${added.label} (holder: ${added.holder})`
        });
        return added;
      });
      res.status(201).json(ref);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // C4: authorized CAPA evidence custody transfers, mirroring the task
  // route (same validation, atomicity, and audit shape).
  app.post('/api/capas/:id/transfer', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const capa = db.capas.find((c) => c.id === req.params.id);
    if (!capa) {
      res.status(404).json({ error: 'CAPA not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(capa.orgId)) {
      orgForbidden(req, res);
      return;
    }
    if (!can(user, 'capa.evidence.add', capa)) {
      forbidden(res, user, 'capa.evidence.add');
      return;
    }
    if (rejectBadText(res, req.body, ['toHolder', 'reason'])) return;
    try {
      const ref = mutateDb(db, () => {
        const reason = String(req.body.reason ?? '').trim() || undefined;
        const { ref: moved, fromHolder } = capaTransferCustody(
          db,
          req.params.id,
          {
            evidenceId: String(req.body.evidenceId ?? ''),
            toHolder: String(req.body.toHolder ?? ''),
            ...(reason ? { reason } : {})
          },
          user.id
        );
        appendAudit(db, {
          actorId: user.id,
          action: 'custody.transferred',
          recordType: 'capa',
          recordId: req.params.id,
          orgId: capa.orgId,
          detail: `${moved.label}: ${fromHolder} -> ${moved.holder}${reason ? ` — ${reason}` : ''}`
        });
        return moved;
      });
      res.json(ref);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // C2: the only way to close a CAPA. An effective review closes it; an
  // ineffective one returns it to Action In Progress with history intact.
  app.post('/api/capas/:id/effectiveness-review', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const capa = db.capas.find((c) => c.id === req.params.id);
    if (!capa) {
      res.status(404).json({ error: 'CAPA not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(capa.orgId)) {
      orgForbidden(req, res);
      return;
    }
    if (!can(user, 'capa.close', capa)) {
      forbidden(res, user, 'capa.close');
      return;
    }
    if (capa.status !== 'effectiveness_review') {
      res.status(400).json({ error: 'Only CAPAs in effectiveness review can be reviewed.' });
      return;
    }
    // C3: nobody involved in the work may approve it.
    if (capaReviewIneligible(capa).includes(user.id)) {
      res.status(403).json({ error: capaReviewerMessage(capa) });
      return;
    }
    // P2: evidenceIds is validated structurally below (array of known ids);
    // only the plain-text inputs are type-checked here.
    if (rejectBadText(res, req.body, ['outcome', 'rationale'])) return;
    const outcome = req.body.outcome;
    if (outcome !== 'effective' && outcome !== 'ineffective') {
      res.status(400).json({ error: 'Review outcome must be effective or ineffective.' });
      return;
    }
    const rationale = String(req.body.rationale ?? '').trim();
    if (!rationale) {
      res.status(400).json({ error: 'An effectiveness review requires a documented rationale.' });
      return;
    }
    const evidenceIds = req.body.evidenceIds;
    const qualifying = new Set(qualifyingEffectivenessEvidence(capa).map((e) => e.id));
    if (
      !Array.isArray(evidenceIds) ||
      evidenceIds.length < 1 ||
      !evidenceIds.every((id: unknown) => typeof id === 'string' && qualifying.has(id))
    ) {
      res.status(400).json({
        error: 'Each referenced evidence item must be current-cycle effectiveness evidence.'
      });
      return;
    }
    // C1 gates still hold at closure.
    const missing = capaGateMissing(capa, 'closed');
    if (missing.length > 0) {
      res.status(400).json({ error: missing.join(' ') });
      return;
    }
    try {
      const updated = mutateDb(db, () => {
        const now = monotonicNow();
        const seq = (capa.effectivenessReviews ?? []).length + 1;
        capa.effectivenessReviews = [
          ...(capa.effectivenessReviews ?? []),
          {
            seq,
            outcome,
            rationale,
            reviewerId: user.id,
            at: now,
            evidenceIds: [...new Set(evidenceIds as string[])],
            // P1: judged-against criteria, copied server-side. Anything the
            // client sends as criteriaSnapshot is ignored.
            criteriaSnapshot: capa.effectivenessCriteria ?? ''
          }
        ];
        appendAudit(db, {
          actorId: user.id,
          action: 'capa.effectiveness_review.recorded',
          recordType: 'capa',
          recordId: capa.id,
          orgId: capa.orgId,
          detail: `#${seq} ${outcome}: ${rationale.slice(0, 80)}`
        });
        if (outcome === 'effective') {
          capa.status = 'closed';
          capa.closedBy = user.id;
          capa.closedAt = now;
          capa.effectivenessDecision = rationale;
          capa.statusHistory = [...(capa.statusHistory ?? []), { status: 'closed', at: now, byUserId: user.id }];
          appendAudit(db, {
            actorId: user.id,
            action: 'capa.closed',
            recordType: 'capa',
            recordId: capa.id,
            orgId: capa.orgId,
            detail: `${capa.finding.slice(0, 80)} [effectiveness_review -> closed]`
          });
        } else {
          capa.status = 'action_in_progress';
          capa.statusHistory = [
            ...(capa.statusHistory ?? []),
            { status: 'action_in_progress', at: now, byUserId: user.id }
          ];
          appendAudit(db, {
            actorId: user.id,
            action: 'capa.returned_to_action',
            recordType: 'capa',
            recordId: capa.id,
            orgId: capa.orgId,
            detail: `#${seq} ineffective: returned to Action In Progress`
          });
        }
        capa.updatedAt = now;
        return capa;
      });
      res.status(201).json(updated);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.get('/api/templates', (req: AuthRequest, res) => {
    const scope = readScope(req, res);
    if (!scope) return;
    const domainId = String(req.query.domainId ?? '');
    const controlType = String(req.query.controlType ?? '');
    res.json(
      db.templates.filter(
        (t) =>
          scope.includes(t.orgId) &&
          (!domainId || t.domainId === domainId) &&
          (!controlType || t.controlType === controlType)
      )
    );
  });

  app.post('/api/templates', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    if (!can(user, 'template.manage')) {
      forbidden(res, user, 'template.manage');
      return;
    }
    try {
      const template = mutateDb(db, () => {
        const created = createTemplate(db, req.body);
        appendAudit(db, {
          actorId: user.id,
          action: 'template.created',
          recordType: 'template',
          recordId: created.id,
          orgId: created.orgId,
          detail: `${created.title} [${created.controlType}]`
        });
        return created;
      });
      res.status(201).json(template);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.patch('/api/templates/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    if (!can(user, 'template.manage')) {
      forbidden(res, user, 'template.manage');
      return;
    }
    try {
      const template = mutateDb(db, () => {
        const next = updateTemplate(db, req.params.id, req.body);
        appendAudit(db, {
          actorId: user.id,
          action: 'template.updated',
          recordType: 'template',
          recordId: next.id,
          orgId: next.orgId,
          detail: next.title
        });
        return next;
      });
      res.json(template);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.post('/api/templates/:id/instantiate', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const template = db.templates.find((t) => t.id === req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }
    if (
      (user.role === 'department_manager' || user.role === 'staff') &&
      template.orgId !== user.orgId
    ) {
      forbidden(res, user, 'task.create');
      return;
    }
    if (!can(user, 'task.create')) {
      forbidden(res, user, 'task.create');
      return;
    }
    try {
      const task = mutateDb(db, () => {
        const created = instantiateTemplate(db, template.id, {
          ownerId: String(req.body.ownerId ?? ''),
          dueDate: req.body.dueDate ? String(req.body.dueDate) : undefined
        });
        appendAudit(db, {
          actorId: user.id,
          action: 'task.created',
          recordType: 'task',
          recordId: created.id,
          orgId: template.orgId,
          detail: `From template: ${template.title}`
        });
        return created;
      });
      res.status(201).json(presentTask(task));
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // ---------------------------------------------------------------------------
  // Recurring obligations (calendar slice 1): template cadences bound to
  // organization-selected target dates. Reads are tenant-scoped; creation
  // and generation reuse task.create, schedule edits need
  // obligation.manage plus a reason (CAL4); generation is atomic with its
  // audit events. Target dates are illustrative, never legal mandates.
  // ---------------------------------------------------------------------------
  app.get('/api/obligations', (req: AuthRequest, res) => {
    const scope = readScope(req, res);
    if (!scope) return;
    const active = String(req.query.active ?? '');
    res.json(
      db.obligations.filter(
        (o) => scope.includes(o.orgId) && (!active || String(o.active) === active)
      )
    );
  });

  app.post('/api/obligations', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const input = req.body as {
      orgId: string;
      templateId: string;
      nextDueDate: string;
      assigneeId?: string;
    };
    if ((user.role === 'department_manager' || user.role === 'staff') && input.orgId !== user.orgId) {
      forbidden(res, user, 'task.create');
      return;
    }
    if (!can(user, 'task.create')) {
      forbidden(res, user, 'task.create');
      return;
    }
    if (rejectBadText(res, req.body, ['orgId', 'templateId', 'nextDueDate', 'assigneeId'])) return;
    try {
      const obligation = mutateDb(db, () => {
        const created = createObligation(db, {
          orgId: input.orgId,
          templateId: input.templateId,
          nextDueDate: input.nextDueDate,
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {})
        });
        const template = db.templates.find((t) => t.id === created.templateId);
        appendAudit(db, {
          actorId: user.id,
          action: 'obligation.created',
          recordType: 'obligation',
          recordId: created.id,
          orgId: created.orgId,
          detail: `From template: ${template?.title ?? created.templateId}; target ${created.nextDueDate} (illustrative)`
        });
        return created;
      });
      res.status(201).json(obligation);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.patch('/api/obligations/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const obligation = db.obligations.find((o) => o.id === req.params.id);
    if (!obligation) {
      res.status(404).json({ error: 'Obligation not found.' });
      return;
    }
    if (!visibleOrgIds(user, db.orgs.map((o) => o.id)).includes(obligation.orgId)) {
      orgForbidden(req, res);
      return;
    }
    // CAL4: schedule changes need manager/officer/admin authority — staff
    // cannot postpone, deactivate, or reassign, even as the assignee.
    if (!can(user, 'obligation.manage', { orgId: obligation.orgId, ownerId: '' })) {
      forbidden(res, user, 'obligation.manage');
      return;
    }
    if (rejectBadText(res, req.body, ['nextDueDate', 'assigneeId', 'reason'])) return;
    const patch = req.body as { nextDueDate?: string; assigneeId?: string; active?: boolean; reason?: string };
    if (patch.active !== undefined && typeof patch.active !== 'boolean') {
      res.status(400).json({ error: 'active must be true or false.' });
      return;
    }
    const oldTarget = obligation.nextDueDate;
    const oldAssignee = obligation.assigneeId ?? '';
    const oldActive = obligation.active;
    const targetChanged = patch.nextDueDate !== undefined && patch.nextDueDate !== oldTarget;
    const assigneeChanged = patch.assigneeId !== undefined && patch.assigneeId !== oldAssignee;
    const activeChanged = patch.active !== undefined && patch.active !== oldActive;
    // M-CAL2: true no-op — reason-only, forged-only, or unchanged values change
    // nothing, so return without a write, audit event, or updatedAt bump.
    // Authorization and type checks above still apply.
    if (!targetChanged && !assigneeChanged && !activeChanged) {
      res.json(obligation);
      return;
    }
    const reason = (patch.reason ?? '').trim();
    if (!reason) {
      res.status(400).json({ error: 'A reason is required to change the schedule.' });
      return;
    }
    try {
      const updated = mutateDb(db, () => {
        const next = updateObligation(db, obligation.id, {
          ...(targetChanged ? { nextDueDate: patch.nextDueDate as string } : {}),
          ...(assigneeChanged ? { assigneeId: patch.assigneeId as string } : {}),
          ...(activeChanged ? { active: patch.active as boolean } : {})
        });
        // One history entry per field that actually changed, atomically
        // with the update and its audit event.
        const changes: Array<{ change: 'target' | 'assignee' | 'active'; oldValue: string; newValue: string }> = [];
        if (next.nextDueDate !== oldTarget) {
          changes.push({ change: 'target', oldValue: oldTarget, newValue: next.nextDueDate });
        }
        if ((next.assigneeId ?? '') !== oldAssignee) {
          changes.push({ change: 'assignee', oldValue: oldAssignee, newValue: next.assigneeId ?? '' });
        }
        if (next.active !== oldActive) {
          changes.push({ change: 'active', oldValue: String(oldActive), newValue: String(next.active) });
        }
        const history = next.scheduleHistory ?? [];
        if (changes.length > 0) {
          const at = monotonicNow();
          next.scheduleHistory = [
            ...history,
            ...changes.map((c, i) => ({ seq: history.length + i + 1, ...c, byUserId: user.id, at, reason }))
          ];
        }
        const show = (v: string): string => (v === '' ? 'none' : v);
        const parts = changes.map((c) =>
          c.change === 'target'
            ? `target ${c.oldValue} -> ${c.newValue}`
            : c.change === 'assignee'
              ? `assignee ${show(c.oldValue)} -> ${show(c.newValue)}`
              : `active ${c.oldValue} -> ${c.newValue}`
        );
        appendAudit(db, {
          actorId: user.id,
          action: 'obligation.updated',
          recordType: 'obligation',
          recordId: obligation.id,
          orgId: obligation.orgId,
          detail:
            parts.length > 0
              ? `${parts.join('; ')} (reason: ${reason})`
              : `No changes (reason: ${reason || 'n/a'})`
        });
        return next;
      });
      res.json(updated);
    } catch (e) {
      sendError(req, res, e);
    }
  });

  app.post('/api/obligations/:id/generate', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const obligation = db.obligations.find((o) => o.id === req.params.id);
    if (!obligation) {
      res.status(404).json({ error: 'Obligation not found.' });
      return;
    }
    if (
      (user.role === 'department_manager' || user.role === 'staff') &&
      obligation.orgId !== user.orgId
    ) {
      forbidden(res, user, 'task.create');
      return;
    }
    if (!can(user, 'task.create')) {
      forbidden(res, user, 'task.create');
      return;
    }
    try {
      const { task, obligation: advanced } = mutateDb(db, () => {
        const out = generateObligationInstance(db, obligation.id, user.id);
        const template = db.templates.find((t) => t.id === out.obligation.templateId);
        appendAudit(db, {
          actorId: user.id,
          action: 'task.created',
          recordType: 'task',
          recordId: out.task.id,
          orgId: out.task.orgId,
          detail: `From obligation: ${template?.title ?? out.obligation.templateId} (${out.task.periodKey}, due ${out.task.dueDate})`
        });
        appendAudit(db, {
          actorId: user.id,
          action: 'obligation.instance.generated',
          recordType: 'obligation',
          recordId: out.obligation.id,
          orgId: out.obligation.orgId,
          detail: out.obligation.active
            ? `Generated ${out.task.id} for ${out.task.periodKey} (due ${out.task.dueDate}); next target ${out.obligation.nextDueDate}`
            : `Generated ${out.task.id} for ${out.task.periodKey} (due ${out.task.dueDate}); schedule complete`
        });
        return out;
      });
      res.status(201).json({ task: presentTask(task), obligation: advanced });
    } catch (e) {
      sendError(req, res, e);
    }
  });

  // Append-only: read-only audit endpoint by design. No write routes exist.
  app.get('/api/audit', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const allIds = db.orgs.map((o) => o.id);
    const allowed = visibleOrgIds(user, allIds);
    const seesAllOrgs = allIds.every((id) => allowed.includes(id));
    const recordType = String(req.query.recordType ?? '');
    const recordId = String(req.query.recordId ?? '');
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const events = db.audit
      .filter((e) => {
        // Only genuine database-level events are globally visible. A 'system'
        // tag on any other record type is forged or stale: contain it like
        // 'unknown' (privileged eyes only) instead of leaking it to tenants.
        const genuineSystem = e.orgId === SYSTEM_AUDIT_ORG && e.recordType === 'database';
        const privilegedOnly =
          e.orgId === UNKNOWN_AUDIT_ORG || (e.orgId === SYSTEM_AUDIT_ORG && !genuineSystem);
        return (
          (allowed.includes(e.orgId) || genuineSystem || (seesAllOrgs && privilegedOnly)) &&
          (!recordType || e.recordType === recordType) &&
          (!recordId || e.recordId === recordId)
        );
      })
      .slice(-limit);
    res.json(events);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // WM1-1: application-wide error boundary. Body-parser failures answer with
  // fixed JSON and never reach Express's default handler; nothing
  // request-supplied (content, parser messages, stacks, paths) is echoed or
  // logged here. Must stay the last middleware in createApp. Express
  // recognizes error middleware by its four parameters; _next is unused.
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const type = err?.type as string | undefined;
    const status = (err?.status ?? err?.statusCode) as number | undefined;
    if (type === 'entity.parse.failed' || (status === 400 && err?.name === 'SyntaxError' && 'body' in err)) {
      res.status(400).json({ error: 'Malformed JSON body.' });
      return;
    }
    if (type === 'entity.too.large' || status === 413) {
      res.status(413).json({ error: 'Request body too large.' });
      return;
    }
    console.error(`[sentinel] ${req.method} ${req.path} failed in error middleware.`);
    res.status(500).json({ error: 'Internal error.' });
  });
  return app;
}
