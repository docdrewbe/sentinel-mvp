// Express API for the Sentinel MVP.
//
// SIMULATED authentication (x-demo-user-id header; demo user switcher in the
// UI) and SIMULATED authorization. Not production-ready.
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  ValidationError,
  addEvidence,
  appendAudit,
  createTask,
  createTemplate,
  instantiateTemplate,
  mutateDb,
  transferCustody,
  updateTask,
  updateTemplate,
  verifyAuditChain,
  type DbShape
} from './store.js';
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import type { ComplianceTask, DemoUser } from '../shared/types.js';
import { SYSTEM_AUDIT_ORG, UNKNOWN_AUDIT_ORG } from '../shared/types.js';

export interface AuthRequest extends Request {
  user?: DemoUser;
  task?: ComplianceTask;
}

function sendError(req: Request, res: Response, e: unknown): void {
  if (e instanceof ValidationError) {
    res.status(400).json({ error: e.message });
    return;
  }
  console.error(`[sentinel] ${req.method} ${req.path} failed:`, e);
  res.status(500).json({ error: 'Internal error.' });
}

function forbidden(res: Response, user: DemoUser, action: string): void {
  res.status(403).json({ error: `Role '${user.role}' may not perform '${action}' here.` });
}

export function createApp(db: DbShape): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

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
      db.tasks.filter(
        (t) =>
          scope.includes(t.orgId) &&
          (!status || t.status === status) &&
          (!ownerId || t.ownerId === ownerId)
      )
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
      res.status(201).json(task);
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
      const statusChanged = patch.status !== undefined && patch.status !== oldStatus;
      const updated = mutateDb(db, () => {
        const next = updateTask(db, task.id, patch);
        appendAudit(db, {
          actorId: user.id,
          action: statusChanged ? `task.${next.status}` : 'task.updated',
          recordType: 'task',
          recordId: task.id,
          orgId: task.orgId,
          detail: `${next.title} [${oldStatus} -> ${next.status}]`
        });
        return next;
      });
      res.json(updated);
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
      res.status(201).json(task);
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
  return app;
}
