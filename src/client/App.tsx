import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NewTask } from './api.js';
import { CONTROL_LABELS, KIND_LABELS, RECURRENCE_LABELS, ROLE_LABELS, STATUS_LABELS, type AuditEvent, type ComplianceTask, type DemoUser, type Organization, type RegulatoryDomain, type TaskStatus, type TaskTemplate } from '../shared/types.js';
import { can, visibleOrgIds } from '../shared/rbac.js';
import { nextDueDate } from '../shared/scheduling.js';
import { applySettled, beginContext, canAct, initialPanels, panelData, requiredEvidenceFor, resolveOrgId, submitBlockReason, verifyBlockReason, type Panels } from './dashboard.js';

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
  const [panels, setPanels] = useState<Panels>(initialPanels);
  const requestSeq = useRef(0);
  const contextKeyRef = useRef('');
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState(() => localStorage.getItem('sentinel-user') ?? '');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [controlFilter, setControlFilter] = useState('all');
  const [instantiateFor, setInstantiateFor] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');

  const me = users.find((u) => u.id === userId) ?? null;
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const contextKey = `${userId}|${orgId}`;
  // Guarded rows: only loaded panels of the current context ever render.
  const tasks = panelData(panels.tasks, contextKey);
  const domains = panelData(panels.domains, contextKey);
  const audit = panelData(panels.audit, contextKey);
  const templates = panelData(panels.templates, contextKey);
  const tasksReady = canAct(panels.tasks, contextKey);
  const domainsReady = canAct(panels.domains, contextKey);
  const auditReady = canAct(panels.audit, contextKey);
  const templatesReady = canAct(panels.templates, contextKey);
  const task = tasks.find((t) => t.id === taskId) ?? null;

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const privilegedIds = useMemo(
    () =>
      users
        .filter((u) => u.role === 'administrator' || u.role === 'compliance_officer')
        .map((u) => u.id),
    [users]
  );
  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);
  const templateById = useMemo(() => new Map(templates.map((x) => [x.id, x])), [templates]);
  const orgIds = useMemo(() => orgs.map((o) => o.id), [orgs]);
  const visibleOrgs = useMemo(
    () => (me ? orgs.filter((o) => visibleOrgIds(me, orgIds).includes(o.id)) : orgs),
    [me, orgs, orgIds]
  );

  const refresh = useCallback(async (oid: string, key: string) => {
    if (!oid) return;
    const mySeq = ++requestSeq.current;
    const [t, d, a, tpl] = await Promise.allSettled([
      api.tasks(oid),
      api.domains(oid),
      api.audit(200),
      api.templates(oid)
    ]);
    setPanels((prev) =>
      applySettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, t, d, a, tpl)
    );
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
    const current = users.find((u) => u.id === userId) ?? null;
    if (!current || orgs.length === 0 || !orgId) return;
    const resolved = resolveOrgId(orgs, current, orgId);
    if (resolved !== orgId) {
      setOrgId(resolved);
      return;
    }
    const nextKey = `${userId}|${orgId}`;
    const prevKey = contextKeyRef.current;
    contextKeyRef.current = nextKey;
    // Synchronous clear before fetching: no previous-context rows survive.
    setPanels((prev) => beginContext(prevKey, nextKey, prev));
    if (prevKey !== nextKey) {
      setTaskId(null);
      setInstantiateFor(null);
      setShowNew(false);
      setError('');
    }
    refresh(orgId, nextKey).catch((e: Error) => setError(e.message));
  }, [userId, orgId, users, orgs, refresh]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('');
    try {
      await fn();
      await refresh(orgId, contextKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    }
  };

  const retry = (): void => {
    refresh(orgId, contextKey).catch((e: Error) => setError(e.message));
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
              {visibleOrgs.map((o) => (
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
              {org.beds ? ` · ${org.beds} beds` : ''} · {org.location}
              {domainsReady && tasksReady
                ? <> · {domains.length} regulatory domains · {tasks.length} tasks</>
                : null}
            </p>
          )}
        </section>

        <section className="stats" aria-label="Task summary">
          <Stat label="Open" value={tasksReady ? stats.open : '—'} tone="ink" />
          <Stat label="In progress" value={tasksReady ? stats.inProgress : '—'} tone="blue" />
          <Stat label="Due within 7 days" value={tasksReady ? stats.dueSoon : '—'} tone="amber" />
          <Stat label="Overdue" value={tasksReady ? stats.overdue : '—'} tone="red" />
          <Stat label="Verified" value={tasksReady ? stats.verified : '—'} tone="green" />
        </section>

        <section className="columns">
          <div className="tasklist panel">
            <div className="panel-head">
              <h3>Compliance tasks</h3>
              <div className="panel-actions">
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" disabled={!tasksReady}>
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="submitted">Submitted</option>
                  <option value="verified">Verified</option>
                  <option value="dueSoon">Due within 7 days</option>
                  <option value="overdue">Overdue</option>
                </select>
                {me && can(me, 'task.create') && (
                  <button className="primary" onClick={() => setShowNew((s) => !s)} disabled={!tasksReady}>
                    {showNew ? 'Close' : 'New task'}
                  </button>
                )}
              </div>
            </div>
            <PanelNotice panel={panels.tasks} contextKey={contextKey} name="tasks" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            <PanelNotice panel={panels.domains} contextKey={contextKey} name="regulatory domains" orgName={org?.name ?? 'this organization'} onRetry={retry} />
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
                  {task.templateId && (
                    <div><dt>Template</dt><dd>{templateById.get(task.templateId)?.title ?? task.templateId}</dd></div>
                  )}
                  <div><dt>Owner</dt><dd>{userName.get(task.ownerId) ?? '—'}</dd></div>
                  {task.submittedBy && (
                    <div><dt>Submitted by</dt><dd>{userName.get(task.submittedBy) ?? task.submittedBy}</dd></div>
                  )}
                  <div><dt>Due</dt><dd className={isOverdue(task) ? 'overdue' : ''}>{task.dueDate}</dd></div>
                  <div><dt>Status</dt><dd>{STATUS_LABELS[task.status]}</dd></div>
                </dl>
                <EvidenceRequirement task={task} />
                {tasksReady ? (
                  <>
                    <StatusButtons
                      me={me}
                      task={task}
                      submitBlockReason={submitBlockReason(task)}
                      verifyBlockReason={verifyBlockReason(me, task, privilegedIds)}
                      onChange={(status: TaskStatus) => run(async () => api.patchTask(task.id, { status }))}
                    />
                    <h5>Evidence & chain of custody ({task.evidence.length})</h5>
                    {task.evidence.length === 0 && <p className="empty">No evidence attached yet.</p>}
                    <ul className="evidence">
                      {task.evidence.map((e) => (
                        <li key={e.id} className="evidence-item">
                          <div className="evidence-row">
                            <span>{e.label}</span>
                            <span className="holder">Holder: {e.holder}</span>
                          </div>
                          {(e.custody ?? []).length > 0 && (
                            <ol className="custody">
                              {(e.custody ?? []).map((c) => (
                                <li key={c.seq}>
                                  {c.fromHolder ?? '—'} → {c.toHolder} ·{' '}
                                  {userName.get(c.byUserId) ?? c.byUserId} ·{' '}
                                  {new Date(c.at).toLocaleString()}
                                  {c.reason ? ` — ${c.reason}` : ''}
                                </li>
                              ))}
                            </ol>
                          )}
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
                        onTransfer={(evidenceId, toHolder, reason) =>
                          run(async () => api.transfer(task.id, { evidenceId, toHolder, reason }))
                        }
                      />
                    )}
                  </>
                ) : (
                  <p className="panel-error" role="alert">
                    Task actions unavailable while task data is loading or failed.
                  </p>
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
            <h3>Compliance task templates (synthetic — illustrative references, not legal advice)</h3>
            <div className="panel-actions">
              <select value={controlFilter} onChange={(e) => setControlFilter(e.target.value)} aria-label="Filter by control type" disabled={!templatesReady}>
                <option value="all">All controls</option>
                <option value="legally_required">Legally required</option>
                <option value="best_practice">Best practice (voluntary)</option>
              </select>
            </div>
          </div>
          <PanelNotice panel={panels.templates} contextKey={contextKey} name="templates" orgName={org?.name ?? 'this organization'} onRetry={retry} />
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Domain</th>
                <th>Control</th>
                <th>Recurrence</th>
                <th>Responsible roles</th>
                <th>Evidence required</th>
                <th>Escalation</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates
                .filter((x) => controlFilter === 'all' || x.controlType === controlFilter)
                .map((x) => (
                  <tr key={x.id}>
                    <td className="task-title">
                      {x.title}
                      {!x.active && <span className="status">Inactive</span>}
                      <div className="trail-detail">{x.description}</div>
                      <div className="trail-detail">
                        {x.regulatoryRefs.map((r) => `${r.source} — ${r.citation}`).join(' · ') || 'No source refs'}
                      </div>
                    </td>
                    <td>{domainById.get(x.domainId)?.code ?? '—'}</td>
                    <td><span className={`status ${x.controlType === 'legally_required' ? 'status-submitted' : 'status-in_progress'}`}>{CONTROL_LABELS[x.controlType]}</span></td>
                    <td>{RECURRENCE_LABELS[x.recurrence.frequency]}</td>
                    <td>{x.responsibleRoles.map((r) => ROLE_LABELS[r]).join(', ')}</td>
                    <td>{x.evidenceRequired.map((e) => e.label).join('; ') || '—'}</td>
                    <td>
                      {x.escalation
                        .slice()
                        .sort((a, b) => a.afterDaysOverdue - b.afterDaysOverdue)
                        .map((e) => `${e.afterDaysOverdue}d → ${ROLE_LABELS[e.escalateTo]}`)
                        .join('; ') || '—'}
                    </td>
                    <td>
                      {me && can(me, 'task.create') && x.active && (
                        <button onClick={() => setInstantiateFor(instantiateFor === x.id ? null : x.id)} disabled={!templatesReady}>
                          {instantiateFor === x.id ? 'Cancel' : 'New task'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              {templates.filter((x) => controlFilter === 'all' || x.controlType === controlFilter).length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">No templates for this organization yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {instantiateFor && me && org && (
            <InstantiateForm
              template={templates.find((x) => x.id === instantiateFor) as TaskTemplate}
              users={users.filter((u) => u.orgId === org.id)}
              onSubmit={(ownerId, dueDate) =>
                run(async () => {
                  const created = await api.instantiate(instantiateFor, { ownerId, dueDate });
                  setTaskId(created.id);
                }).then(() => setInstantiateFor(null))
              }
            />
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Audit event log (append-only, hash-chained — simulated)</h3>
          </div>
          <PanelNotice panel={panels.audit} contextKey={contextKey} name="audit events" orgName={org?.name ?? 'this organization'} onRetry={retry} />
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

function PanelNotice({ panel, contextKey, name, orgName, onRetry }: {
  panel: { key: string; status: string; error?: string };
  contextKey: string;
  name: string;
  orgName: string;
  onRetry: () => void;
}): JSX.Element | null {
  if (panel.key !== contextKey) return null;
  if (panel.status === 'loading') return <p className="panel-loading">Loading {name}…</p>;
  if (panel.status === 'error') {
    return (
      <div className="panel-alert" role="alert">
        <p>Couldn't load {name} for {orgName}.</p>
        <p className="panel-error-detail">{panel.error}</p>
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (panel.error) {
    return (
      <p className="panel-error" role="alert">
        {name} may be out of date: {panel.error} <button onClick={onRetry}>Retry</button>
      </p>
    );
  }
  return null;
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: string }): JSX.Element {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function EvidenceRequirement({ task }: { task: ComplianceTask }): JSX.Element | null {
  if (task.status !== 'open' && task.status !== 'in_progress') return null;
  const required = requiredEvidenceFor(task);
  if (required === null) {
    return (
      <p className="panel-error" role="alert">
        Evidence requirement unavailable — submission will be checked by the server.
      </p>
    );
  }
  const short = required - task.evidence.length;
  return short > 0 ? (
    <p className="panel-error" role="alert">
      Evidence: {task.evidence.length} of {required} required — add {short} more before submitting.
    </p>
  ) : (
    <p className="req-ok">
      Evidence: {task.evidence.length} of {required} required — ready to submit.
    </p>
  );
}

function StatusButtons({ me, task, submitBlockReason, verifyBlockReason, onChange }: { me: DemoUser; task: ComplianceTask; submitBlockReason: string | null; verifyBlockReason: string | null; onChange: (s: TaskStatus) => void }): JSX.Element {
  // D4d: an explicit title wins over the generic "Requires: ..." prefix, so
  // the evidence block reason is never doubled up.
  const btn = (label: string, status: TaskStatus, allowed: boolean, need: string, title?: string): JSX.Element => (
    <button key={status} disabled={!allowed} title={allowed ? '' : (title ?? `Requires: ${need}`)} onClick={() => onChange(status)}>
      {label}
    </button>
  );
  return (
    <div className="status-btns">
      {btn('Start', 'in_progress', can(me, 'task.update', task), 'owner / manager / officer / admin')}
      {btn('Submit', 'submitted', can(me, 'task.submit', task) && submitBlockReason === null, 'owner / manager / officer / admin', submitBlockReason ?? undefined)}
      {btn('Verify', 'verified', can(me, 'task.verify', task) && verifyBlockReason === null, 'compliance officer / admin', verifyBlockReason ?? undefined)}
      {verifyBlockReason && can(me, 'task.verify', task) && <p className="sod-note">{verifyBlockReason}</p>}
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

function TransferForm({ evidence, onTransfer }: { evidence: ComplianceTask['evidence']; onTransfer: (id: string, holder: string, reason?: string) => void }): JSX.Element {
  const [evidenceId, setEvidenceId] = useState(evidence[0]?.id ?? '');
  const [toHolder, setToHolder] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setEvidenceId(evidence[0]?.id ?? '');
  }, [evidence]);
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        onTransfer(evidenceId, toHolder, reason.trim() || undefined);
        setToHolder('');
        setReason('');
      }}
    >
      <select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} aria-label="Evidence item">
        {evidence.map((x) => (
          <option key={x.id} value={x.id}>{x.label} (now: {x.holder})</option>
        ))}
      </select>
      <input value={toHolder} onChange={(e) => setToHolder(e.target.value)} placeholder="Transfer to (new holder)" required />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
      <button type="submit">Transfer custody</button>
    </form>
  );
}

function InstantiateForm({ template, users, onSubmit }: { template: TaskTemplate; users: DemoUser[]; onSubmit: (ownerId: string, dueDate: string) => void }): JSX.Element {
  const defaultDue =
    nextDueDate(todayISO(), template.recurrence.frequency) ??
    new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(defaultDue);
  useEffect(() => {
    setOwnerId(users[0]?.id ?? '');
  }, [users]);
  useEffect(() => {
    setDueDate(
      nextDueDate(todayISO(), template.recurrence.frequency) ??
        new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    );
  }, [template]);
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(ownerId, dueDate);
      }}
    >
      <span className="task-title">New task from “{template.title}”</span>
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
