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
  transferCustody,
  updateTask,
  updateTemplate,
  verifyAuditChain,
  type DbShape
} from './store.js';
import { can, type Action } from '../shared/rbac.js';
import type { DemoUser } from '../shared/types.js';

export interface AuthRequest extends Request {
  user?: DemoUser;
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof ValidationError) {
    res.status(400).json({ error: e.message });
    return;
  }
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
      next();
    };

  app.get('/api/domains', (req: AuthRequest, res) => {
    const orgId = String(req.query.orgId ?? '');
    res.json(db.domains.filter((d) => !orgId || d.orgId === orgId));
  });

  app.get('/api/tasks', (req: AuthRequest, res) => {
    const orgId = String(req.query.orgId ?? '');
    const status = String(req.query.status ?? '');
    const ownerId = String(req.query.ownerId ?? '');
    res.json(
      db.tasks.filter(
        (t) =>
          (!orgId || t.orgId === orgId) &&
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
      const task = createTask(db, input);
      appendAudit(db, {
        actorId: user.id,
        action: 'task.created',
        recordType: 'task',
        recordId: task.id,
        detail: task.title
      });
      res.status(201).json(task);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.patch('/api/tasks/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    const task = db.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
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
      const updated = updateTask(db, task.id, patch);
      appendAudit(db, {
        actorId: user.id,
        action: statusChanged ? `task.${updated.status}` : 'task.updated',
        recordType: 'task',
        recordId: task.id,
        detail: `${updated.title} [${oldStatus} -> ${updated.status}]`
      });
      res.json(updated);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/tasks/:id/evidence', need('evidence.add'), (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    try {
      const ref = addEvidence(db, req.params.id, {
        label: String(req.body.label ?? ''),
        holder: String(req.body.holder ?? '')
      });
      appendAudit(db, {
        actorId: user.id,
        action: 'evidence.added',
        recordType: 'task',
        recordId: req.params.id,
        detail: `${ref.label} (holder: ${ref.holder})`
      });
      res.status(201).json(ref);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/tasks/:id/transfer', need('custody.transfer'), (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    try {
      const before = db.tasks
        .find((t) => t.id === req.params.id)
        ?.evidence.find((e) => e.id === String(req.body.evidenceId ?? ''));
      const ref = transferCustody(db, req.params.id, {
        evidenceId: String(req.body.evidenceId ?? ''),
        toHolder: String(req.body.toHolder ?? '')
      });
      appendAudit(db, {
        actorId: user.id,
        action: 'custody.transferred',
        recordType: 'task',
        recordId: req.params.id,
        detail: `${ref.label}: ${before?.holder ?? '?'} -> ${ref.holder}`
      });
      res.json(ref);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/templates', (req: AuthRequest, res) => {
    const orgId = String(req.query.orgId ?? '');
    const domainId = String(req.query.domainId ?? '');
    const controlType = String(req.query.controlType ?? '');
    res.json(
      db.templates.filter(
        (t) =>
          (!orgId || t.orgId === orgId) &&
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
      const template = createTemplate(db, req.body);
      appendAudit(db, {
        actorId: user.id,
        action: 'template.created',
        recordType: 'template',
        recordId: template.id,
        detail: `${template.title} [${template.controlType}]`
      });
      res.status(201).json(template);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.patch('/api/templates/:id', (req: AuthRequest, res) => {
    const user = req.user as DemoUser;
    if (!can(user, 'template.manage')) {
      forbidden(res, user, 'template.manage');
      return;
    }
    try {
      const template = updateTemplate(db, req.params.id, req.body);
      appendAudit(db, {
        actorId: user.id,
        action: 'template.updated',
        recordType: 'template',
        recordId: template.id,
        detail: template.title
      });
      res.json(template);
    } catch (e) {
      sendError(res, e);
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
      const task = instantiateTemplate(db, template.id, {
        ownerId: String(req.body.ownerId ?? ''),
        dueDate: req.body.dueDate ? String(req.body.dueDate) : undefined
      });
      appendAudit(db, {
        actorId: user.id,
        action: 'task.created',
        recordType: 'task',
        recordId: task.id,
        detail: `From template: ${template.title}`
      });
      res.status(201).json(task);
    } catch (e) {
      sendError(res, e);
    }
  });

  // Append-only: read-only audit endpoint by design. No write routes exist.
  app.get('/api/audit', (req: AuthRequest, res) => {
    const recordType = String(req.query.recordType ?? '');
    const recordId = String(req.query.recordId ?? '');
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const events = db.audit
      .filter(
        (e) =>
          (!recordType || e.recordType === recordType) && (!recordId || e.recordId === recordId)
      )
      .slice(-limit);
    res.json(events);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}
