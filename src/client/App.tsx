import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type NewTask } from './api.js';
import { KIND_LABELS, ROLE_LABELS, STATUS_LABELS, type AuditEvent, type ComplianceTask, type DemoUser, type Organization, type RegulatoryDomain, type TaskStatus } from '../shared/types.js';
import { can } from '../shared/rbac.js';

const todayISO = (): string => new Date().toISOString().slice(0, 10);
const isOverdue = (t: ComplianceTask): boolean => t.status !== 'verified' && t.dueDate < todayISO();
const dueSoon = (t: ComplianceTask): boolean => {
  if (t.status === 'verified' || isOverdue(t)) return false;
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  return t.dueDate <= in7.toISOString().slice(0, 10);
};

export default function App(): JSX.Element {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [domains, setDomains] = useState<RegulatoryDomain[]>([]);
  const [tasks, setTasks] = useState<ComplianceTask[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState(() => localStorage.getItem('sentinel-user') ?? '');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');

  const me = users.find((u) => u.id === userId) ?? null;
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const task = tasks.find((t) => t.id === taskId) ?? null;

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);

  const refresh = useCallback(async (oid: string) => {
    if (!oid) return;
    const [t, d, a] = await Promise.all([api.tasks(oid), api.domains(oid), api.audit(200)]);
    setTasks(t);
    setDomains(d);
    setAudit(a);
  }, []);

  useEffect(() => {
    api.orgs()
      .then((o) => {
        setOrgs(o);
        setOrgId((prev) => prev || o[0]?.id || '');
      })
      .catch((e: Error) => setError(e.message));
    api.users()
      .then((u) => {
        setUsers(u);
        setUserId((prev) => {
          if (prev && u.some((x) => x.id === prev)) return prev;
          return u.find((x) => x.role === 'administrator')?.id ?? u[0]?.id ?? '';
        });
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    localStorage.setItem('sentinel-user', userId);
  }, [userId]);

  useEffect(() => {
    setTaskId(null);
    refresh(orgId).catch((e: Error) => setError(e.message));
  }, [orgId, refresh]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('');
    try {
      await fn();
      await refresh(orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    }
  };

  const filtered = tasks.filter((t) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'overdue') return isOverdue(t);
    if (statusFilter === 'dueSoon') return dueSoon(t);
    return t.status === statusFilter;
  });

  const stats = {
    open: tasks.filter((t) => t.status === 'open').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    dueSoon: tasks.filter(dueSoon).length,
    overdue: tasks.filter(isOverdue).length,
    verified: tasks.filter((t) => t.status === 'verified').length
  };

  const recordTrail = task ? audit.filter((e) => e.recordId === task.id) : [];

  return (
    <div className="page">
      <div className="sim-banner">
        Sentinel MVP demo — simulated auth, audit, and compliance data. Not production-ready. No real patient data.
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <h1>Sentinel</h1>
            <p>Compliance management · demo build</p>
          </div>
        </div>
        <div className="pickers">
          <label>
            Organization
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({KIND_LABELS[o.kind]})
                </option>
              ))}
            </select>
          </label>
          <label>
            Demo user (simulated login)
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {ROLE_LABELS[u.role]}
                </option>
              ))}
            </select>
          </label>
          {me && <span className={`role role-${me.role}`}>{ROLE_LABELS[me.role]}</span>}
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Dismiss error">Dismiss</button>
        </div>
      )}

      <main>
        <section className="orgline">
          <h2>{org ? org.name : 'Loading…'}</h2>
          {org && (
            <p>
              {KIND_LABELS[org.kind]}
              {org.beds ? ` · ${org.beds} beds` : ''} · {org.location} · {domains.length} regulatory
              domains · {tasks.length} tasks
            </p>
          )}
        </section>

        <section className="stats" aria-label="Task summary">
          <Stat label="Open" value={stats.open} tone="ink" />
          <Stat label="In progress" value={stats.inProgress} tone="blue" />
          <Stat label="Due within 7 days" value={stats.dueSoon} tone="amber" />
          <Stat label="Overdue" value={stats.overdue} tone="red" />
          <Stat label="Verified" value={stats.verified} tone="green" />
        </section>

        <section className="columns">
          <div className="tasklist panel">
            <div className="panel-head">
              <h3>Compliance tasks</h3>
              <div className="panel-actions">
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="submitted">Submitted</option>
                  <option value="verified">Verified</option>
                  <option value="dueSoon">Due within 7 days</option>
                  <option value="overdue">Overdue</option>
                </select>
                {me && can(me, 'task.create') && (
                  <button className="primary" onClick={() => setShowNew((s) => !s)}>
                    {showNew ? 'Close' : 'New task'}
                  </button>
                )}
              </div>
            </div>
            {showNew && me && org && (
              <NewTaskForm
                orgId={org.id}
                domains={domains}
                users={users.filter((u) => u.orgId === org.id)}
                onSubmit={(t) => run(async () => api.createTask(t)).then(() => setShowNew(false))}
              />
            )}
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Domain</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className={t.id === taskId ? 'selected' : ''} onClick={() => setTaskId(t.id)}>
                    <td className="task-title">{t.title}</td>
                    <td>{domainById.get(t.domainId)?.code ?? '—'}</td>
                    <td>{userName.get(t.ownerId) ?? '—'}</td>
                    <td className={isOverdue(t) ? 'overdue' : ''}>{t.dueDate}</td>
                    <td>
                      <span className={`status status-${t.status}`}>{STATUS_LABELS[t.status]}</span>
                      {isOverdue(t) && <span className="status status-overdue">Overdue</span>}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">No tasks match this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="detail panel">
            <div className="panel-head">
              <h3>Task detail</h3>
            </div>
            {!task && <p className="empty">Select a task to review evidence, custody, and history.</p>}
            {task && me && (
              <>
                <h4>{task.title}</h4>
                <dl className="meta">
                  <div><dt>Domain</dt><dd>{domainById.get(task.domainId)?.name ?? '—'}</dd></div>
                  <div><dt>Owner</dt><dd>{userName.get(task.ownerId) ?? '—'}</dd></div>
                  <div><dt>Due</dt><dd className={isOverdue(task) ? 'overdue' : ''}>{task.dueDate}</dd></div>
                  <div><dt>Status</dt><dd>{STATUS_LABELS[task.status]}</dd></div>
                </dl>
                <StatusButtons
                  me={me}
                  task={task}
                  onChange={(status: TaskStatus) => run(async () => api.patchTask(task.id, { status }))}
                />
                <h5>Evidence & chain of custody ({task.evidence.length})</h5>
                {task.evidence.length === 0 && <p className="empty">No evidence attached yet.</p>}
                <ul className="evidence">
                  {task.evidence.map((e) => (
                    <li key={e.id}>
                      <span>{e.label}</span>
                      <span className="holder">Holder: {e.holder}</span>
                    </li>
                  ))}
                </ul>
                {can(me, 'evidence.add', task) && (
                  <EvidenceForm
                    onAdd={(label, holder) => run(async () => api.addEvidence(task.id, { label, holder }))}
                  />
                )}
                {can(me, 'custody.transfer', task) && task.evidence.length > 0 && (
                  <TransferForm
                    evidence={task.evidence}
                    onTransfer={(evidenceId, toHolder) =>
                      run(async () => api.transfer(task.id, { evidenceId, toHolder }))
                    }
                  />
                )}
                <h5>Record history (append-only)</h5>
                {recordTrail.length === 0 && <p className="empty">No audit events for this record yet.</p>}
                <ol className="trail">
                  {recordTrail.map((e) => (
                    <li key={e.id}>
                      <code>#{e.seq}</code> {e.action} · {userName.get(e.actorId) ?? e.actorId} ·{' '}
                      {new Date(e.timestamp).toLocaleString()}
                      <div className="trail-detail">{e.detail}</div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Audit event log (append-only, hash-chained — simulated)</h3>
          </div>
          <table>
            <thead>
              <tr>
                <th>Seq</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Record</th>
                <th>Timestamp</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit
                .slice()
                .reverse()
                .slice(0, 50)
                .map((e) => (
                  <tr key={e.id}>
                    <td><code>#{e.seq}</code></td>
                    <td>{userName.get(e.actorId) ?? e.actorId}</td>
                    <td><code>{e.action}</code></td>
                    <td><code>{e.recordType}:{e.recordId.slice(0, 8)}</code></td>
                    <td>{new Date(e.timestamp).toLocaleString()}</td>
                    <td>{e.detail}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </main>

      <footer>
        Sentinel MVP · simulated demo build · audit chain is hash-linked but not independently
        anchored — do not treat as legal evidence of compliance.
      </footer>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }): JSX.Element {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function StatusButtons({ me, task, onChange }: { me: DemoUser; task: ComplianceTask; onChange: (s: TaskStatus) => void }): JSX.Element {
  const btn = (label: string, status: TaskStatus, allowed: boolean, need: string): JSX.Element => (
    <button key={status} disabled={!allowed} title={allowed ? '' : `Requires: ${need}`} onClick={() => onChange(status)}>
      {label}
    </button>
  );
  return (
    <div className="status-btns">
      {btn('Start', 'in_progress', can(me, 'task.update', task), 'owner / manager / officer / admin')}
      {btn('Submit', 'submitted', can(me, 'task.submit', task), 'owner / manager / officer / admin')}
      {btn('Verify', 'verified', can(me, 'task.verify', task), 'compliance officer / admin')}
      {btn('Reopen', 'open', can(me, 'task.update', task), 'owner / manager / officer / admin')}
    </div>
  );
}

function NewTaskForm({ orgId, domains, users, onSubmit }: { orgId: string; domains: RegulatoryDomain[]; users: DemoUser[]; onSubmit: (t: NewTask) => void }): JSX.Element {
  const [title, setTitle] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(todayISO());
  useEffect(() => {
    setDomainId(domains[0]?.id ?? '');
  }, [domains]);
  useEffect(() => {
    setOwnerId(users[0]?.id ?? '');
  }, [users]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ orgId, domainId, title, ownerId, dueDate });
        setTitle('');
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" required />
      <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Regulatory domain">
        {domains.map((d) => (
          <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
        ))}
      </select>
      <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
        ))}
      </select>
      <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
      <button className="primary" type="submit">Create task</button>
    </form>
  );
}

function EvidenceForm({ onAdd }: { onAdd: (label: string, holder: string) => void }): JSX.Element {
  const [label, setLabel] = useState('');
  const [holder, setHolder] = useState('');
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(label, holder);
        setLabel('');
        setHolder('');
      }}
    >
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Evidence label" required />
      <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Holder" required />
      <button type="submit">Add evidence</button>
    </form>
  );
}

function TransferForm({ evidence, onTransfer }: { evidence: ComplianceTask['evidence']; onTransfer: (id: string, holder: string) => void }): JSX.Element {
  const [evidenceId, setEvidenceId] = useState(evidence[0]?.id ?? '');
  const [toHolder, setToHolder] = useState('');
  useEffect(() => {
    setEvidenceId(evidence[0]?.id ?? '');
  }, [evidence]);
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        onTransfer(evidenceId, toHolder);
        setToHolder('');
      }}
    >
      <select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} aria-label="Evidence item">
        {evidence.map((x) => (
          <option key={x.id} value={x.id}>{x.label} (now: {x.holder})</option>
        ))}
      </select>
      <input value={toHolder} onChange={(e) => setToHolder(e.target.value)} placeholder="Transfer to (new holder)" required />
      <button type="submit">Transfer custody</button>
    </form>
  );
}
