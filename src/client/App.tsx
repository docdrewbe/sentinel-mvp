import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NewTask } from './api.js';
import { CAPA_SEVERITY_LABELS, CAPA_STATUS_LABELS, CONTROL_LABELS, KIND_LABELS, RECURRENCE_LABELS, ROLE_LABELS, STATUS_LABELS, type AuditEvent, type CapaRecord, type CapaStatus, type ComplianceTask, type DemoUser, type Organization, type RegulatoryDomain, type TaskStatus, type TaskTemplate } from '../shared/types.js';
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import { nextDueDate } from '../shared/scheduling.js';
import { capaGateMissing, qualifyingEffectivenessEvidence } from '../shared/capa.js';
import { applySettled, beginContext, canAct, capaReviewBlockReason, initialPanels, panelData, reopenBlockReason, requiredEvidenceFor, resolveOrgId, startBlockReason, startButtonLabel, submitBlockReason, submitStatusReason, verifyBlockReason, verifyEvidenceReason, verifyStatusReason, type Panels } from './dashboard.js';

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
  const [capaId, setCapaId] = useState<string | null>(null);
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
  const capas = panelData(panels.capas, contextKey);
  const tasksReady = canAct(panels.tasks, contextKey);
  const domainsReady = canAct(panels.domains, contextKey);
  const auditReady = canAct(panels.audit, contextKey);
  const templatesReady = canAct(panels.templates, contextKey);
  const capasReady = canAct(panels.capas, contextKey);
  const task = tasks.find((t) => t.id === taskId) ?? null;
  const capa = capas.find((c) => c.id === capaId) ?? null;

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const privilegedIds = useMemo(
    () =>
      users
        .filter((u) => u.role === 'administrator' || u.role === 'compliance_officer')
        .map((u) => u.id),
    [users]
  );
  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const templateById = useMemo(() => new Map(templates.map((x) => [x.id, x])), [templates]);
  const orgIds = useMemo(() => orgs.map((o) => o.id), [orgs]);
  const visibleOrgs = useMemo(
    () => (me ? orgs.filter((o) => visibleOrgIds(me, orgIds).includes(o.id)) : orgs),
    [me, orgs, orgIds]
  );

  const refresh = useCallback(async (oid: string, key: string) => {
    if (!oid) return;
    const mySeq = ++requestSeq.current;
    const [t, d, a, tpl, c] = await Promise.allSettled([
      api.tasks(oid),
      api.domains(oid),
      api.audit(200),
      api.templates(oid),
      api.capas(oid)
    ]);
    setPanels((prev) =>
      applySettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, t, d, a, tpl, c)
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
      setCapaId(null);
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
  const capaTrail = capa ? audit.filter((e) => e.recordId === capa.id) : [];

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
                  {task.submissions && task.submissions.length > 0 && (
                    <div><dt>Submissions</dt><dd>{task.submissions.length} submission{task.submissions.length === 1 ? '' : 's'}</dd></div>
                  )}
                  {task.verifiedBy && (
                    <div><dt>Verified by</dt><dd>{userName.get(task.verifiedBy) ?? task.verifiedBy}{task.verifiedAt ? ` · ${new Date(task.verifiedAt).toLocaleString()}` : ''}</dd></div>
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
                      startBlockReason={startBlockReason(task)}
                      submitBlockReason={submitStatusReason(task) ?? submitBlockReason(task)}
                      verifyBlockReason={verifyStatusReason(task) ?? verifyBlockReason(me, task, privilegedIds) ?? verifyEvidenceReason(task)}
                      reopenBlockReason={reopenBlockReason(task)}
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

        <section className="columns">
          <div className="tasklist panel">
            <div className="panel-head">
              <h3>Corrective and preventive actions (CAPA)</h3>
            </div>
            <PanelNotice panel={panels.capas} contextKey={contextKey} name="CAPAs" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            <table>
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>Severity</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {capas.map((c) => (
                  <tr key={c.id} className={c.id === capaId ? 'selected' : ''} onClick={() => setCapaId(c.id)}>
                    <td className="task-title">{c.finding.length > 80 ? `${c.finding.slice(0, 80)}…` : c.finding}</td>
                    <td>{CAPA_SEVERITY_LABELS[c.severity]}</td>
                    <td>{userName.get(c.ownerId) ?? '—'}</td>
                    <td>{c.dueDate}</td>
                    <td>
                      <span className="status">{CAPA_STATUS_LABELS[c.status]}</span>
                    </td>
                  </tr>
                ))}
                {capas.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">No CAPAs for this organization yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="detail panel">
            <div className="panel-head">
              <h3>CAPA detail</h3>
            </div>
            {!capa && <p className="empty">Select a CAPA to review plans, evidence, and history.</p>}
            {capa && me && (
              <CapaDetail
                key={capa.id}
                me={me}
                capa={capa}
                ready={capasReady}
                privilegedIds={privilegedIds}
                userName={userName}
                domainName={domainById.get(capa.domainId)?.name ?? '—'}
                linkedTaskTitle={capa.taskId ? (taskById.get(capa.taskId)?.title ?? capa.taskId) : null}
                trail={capaTrail}
                onAdvance={(status) => run(async () => api.patchCapa(capa.id, { status }))}
                onAddEvidence={(label, holder, kind) =>
                  run(async () => api.addCapaEvidence(capa.id, { label, holder, ...(kind ? { kind } : {}) }))
                }
                onSaveField={(field, text) => run(async () => api.patchCapa(capa.id, { [field]: text }))}
                onReview={(outcome, rationale, evidenceIds) =>
                  run(async () => api.reviewCapa(capa.id, { outcome, rationale, evidenceIds }))
                }
                onTransfer={(evidenceId, toHolder, reason) =>
                  run(async () => api.transferCapaEvidence(capa.id, { evidenceId, toHolder, ...(reason ? { reason } : {}) }))
                }
              />
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

const CAPA_NEXT: Record<Exclude<CapaStatus, 'closed'>, CapaStatus> = {
  open: 'investigation',
  investigation: 'action_in_progress',
  action_in_progress: 'effectiveness_review',
  effectiveness_review: 'closed'
};

function CapaFieldEditor({ label, value, canEdit, onSave }: { label: string; value: string | undefined; canEdit: boolean; onSave: (text: string) => void }): JSX.Element | null {
  const [text, setText] = useState(value ?? '');
  if (!canEdit) {
    return value ? (<p><strong>{label}:</strong> {value}</p>) : null;
  }
  return (
    <div className="form">
      <label>{label}</label>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`${label} (simulated)…`} />
      <div>
        <button disabled={text.trim() === (value ?? '').trim()} onClick={() => onSave(text)}>
          Save {label.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

function CapaDetail({ me, capa, ready, userName, domainName, linkedTaskTitle, trail, privilegedIds, onAdvance, onAddEvidence, onSaveField, onReview, onTransfer }: {
  me: DemoUser;
  capa: CapaRecord;
  ready: boolean;
  userName: Map<string, string>;
  domainName: string;
  linkedTaskTitle: string | null;
  trail: AuditEvent[];
  privilegedIds: string[];
  onAdvance: (status: CapaStatus) => void;
  onAddEvidence: (label: string, holder: string, kind?: string) => void;
  onSaveField: (field: 'containment' | 'rootCause' | 'correctivePlan' | 'preventivePlan' | 'effectivenessCriteria', text: string) => void;
  onReview: (outcome: string, rationale: string, evidenceIds: string[]) => void;
  onTransfer: (evidenceId: string, toHolder: string, reason?: string) => void;
}): JSX.Element {
  const [outcome, setOutcome] = useState('');
  const [rationale, setRationale] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const next = capa.status === 'closed' ? null : CAPA_NEXT[capa.status];
  const reviewing = capa.status === 'effectiveness_review';
  const gateReason = next && !reviewing ? (capaGateMissing(capa, next)[0] ?? null) : null;
  const reviewReason = reviewing ? capaReviewBlockReason(me, capa, privilegedIds) : null;
  const qualifying = reviewing ? qualifyingEffectivenessEvidence(capa) : [];
  const advanceRoleOk = can(me, 'capa.update', capa);
  const advanceAllowed = ready && advanceRoleOk && gateReason === null && next !== null && !reviewing;
  const advanceTitle = !ready
    ? 'CAPA actions unavailable while data is loading or failed.'
    : !advanceRoleOk
      ? 'Requires: owner / manager / officer / admin'
      : (gateReason ?? '');
  const formReason = !outcome
    ? 'Choose an outcome.'
    : !rationale.trim()
      ? 'Document the rationale.'
      : selected.length === 0
        ? 'Select at least 1 current-cycle effectiveness evidence item.'
        : null;
  const reviewRoleOk = can(me, 'capa.close', capa);
  const reviewAllowed = ready && reviewRoleOk && reviewReason === null && formReason === null;
  const reviewTitle = !ready
    ? 'CAPA actions unavailable while data is loading or failed.'
    : !reviewRoleOk
      ? 'Requires: compliance officer / admin'
      : (reviewReason ?? formReason ?? '');
  const noteRoleOk = reviewing ? reviewRoleOk : advanceRoleOk;
  const note = gateReason ?? reviewReason ?? (reviewing ? formReason : null);
  const toggle = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  return (
    <>
      <h4>{capa.finding}</h4>
      <dl className="meta">
        <div><dt>Domain</dt><dd>{domainName}</dd></div>
        <div><dt>Severity</dt><dd>{CAPA_SEVERITY_LABELS[capa.severity]}</dd></div>
        <div><dt>Owner</dt><dd>{userName.get(capa.ownerId) ?? '—'}</dd></div>
        <div><dt>Due</dt><dd>{capa.dueDate}</dd></div>
        <div><dt>Status</dt><dd>{CAPA_STATUS_LABELS[capa.status]}</dd></div>
        {linkedTaskTitle && <div><dt>Task</dt><dd>{linkedTaskTitle}</dd></div>}
        {capa.closedBy && (
          <div><dt>Closed by</dt><dd>{userName.get(capa.closedBy) ?? capa.closedBy}{capa.closedAt ? ` · ${new Date(capa.closedAt).toLocaleString()}` : ''}</dd></div>
        )}
      </dl>
      {(
        [
          ['containment', 'Containment', capa.containment],
          ['rootCause', 'Root cause', capa.rootCause],
          ['correctivePlan', 'Corrective plan', capa.correctivePlan],
          ['preventivePlan', 'Preventive plan', capa.preventivePlan],
          ['effectivenessCriteria', 'Effectiveness criteria', capa.effectivenessCriteria]
        ] as const
      ).map(([field, label, value]) => (
        <CapaFieldEditor
          key={`${capa.id}-${field}-${value ?? ''}`}
          label={label}
          value={value}
          canEdit={ready && can(me, 'capa.update', capa) && capa.status !== 'closed'}
          onSave={(text) => onSaveField(field, text)}
        />
      ))}
      {capa.effectivenessDecision && <p><strong>Effectiveness decision:</strong> {capa.effectivenessDecision}</p>}
      {next && !reviewing && (
        <div className="status-btns">
          <button disabled={!advanceAllowed} title={advanceTitle} onClick={() => onAdvance(next)}>
            {`Advance to ${CAPA_STATUS_LABELS[next]}`}
          </button>
        </div>
      )}
      {reviewing && (
        <div className="form">
          <h5>Effectiveness review</h5>
          <label>
            Outcome
            <select aria-label="Review outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Choose…</option>
              <option value="effective">Effective — close the CAPA</option>
              <option value="ineffective">Ineffective — return to Action In Progress</option>
            </select>
          </label>
          <label>
            Rationale
            <input
              aria-label="Review rationale"
              placeholder="Document the rationale…"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>Current-cycle effectiveness evidence</legend>
            {qualifying.length === 0 && <p className="empty">None yet — add effectiveness evidence below.</p>}
            {qualifying.map((e) => (
              <label key={e.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(e.id)}
                  onChange={() => toggle(e.id)}
                />{' '}
                {e.label} <span className="holder">({e.holder})</span>
              </label>
            ))}
          </fieldset>
          <div>
            <button
              disabled={!reviewAllowed}
              title={reviewTitle}
              onClick={() => onReview(outcome, rationale.trim(), selected)}
            >
              {outcome === 'ineffective' ? 'Record Ineffective Review' : 'Record Effective Review'}
            </button>
          </div>
        </div>
      )}
      {note && noteRoleOk && ready && <p className="sod-note">{note}</p>}
      {(capa.effectivenessReviews ?? []).length > 0 && (
        <>
          <h5>Review history ({(capa.effectivenessReviews ?? []).length})</h5>
          <ol className="trail">
            {(capa.effectivenessReviews ?? []).map((r) => (
              <li key={r.seq}>
                <code>#{r.seq}</code> {r.outcome} · {userName.get(r.reviewerId) ?? r.reviewerId} ·{' '}
                {new Date(r.at).toLocaleString()}
                <div className="trail-detail">{r.rationale} (evidence: {r.evidenceIds.length})</div>
              </li>
            ))}
          </ol>
        </>
      )}
      <h5>Evidence ({capa.evidence.length})</h5>
      {capa.evidence.length === 0 && <p className="empty">No evidence attached yet.</p>}
      <ul className="evidence">
        {capa.evidence.map((e) => (
          <li key={e.id} className="evidence-item">
            <div className="evidence-row">
              <span>{e.label}</span>
              <span className="holder">Holder: {e.holder} · {e.kind === 'effectiveness' ? 'Effectiveness' : 'Implementation'}</span>
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
      {ready && can(me, 'capa.evidence.add', capa) && capa.status !== 'closed' && (
        <EvidenceForm
          onAdd={onAddEvidence}
          kinds={[
            { value: 'implementation', label: 'Implementation' },
            { value: 'effectiveness', label: 'Effectiveness' }
          ]}
        />
      )}
      {ready && can(me, 'capa.evidence.add', capa) && capa.status !== 'closed' && capa.evidence.length > 0 && (
        <TransferForm evidence={capa.evidence} onTransfer={onTransfer} />
      )}
      <h5>Record history (append-only)</h5>
      {trail.length === 0 && <p className="empty">No audit events for this record yet.</p>}
      <ol className="trail">
        {trail.map((e) => (
          <li key={e.id}>
            <code>#{e.seq}</code> {e.action} · {userName.get(e.actorId) ?? e.actorId} ·{' '}
            {new Date(e.timestamp).toLocaleString()}
            <div className="trail-detail">{e.detail}</div>
          </li>
        ))}
      </ol>
    </>
  );
}

function StatusButtons({ me, task, startBlockReason, submitBlockReason, verifyBlockReason, reopenBlockReason, onChange }: { me: DemoUser; task: ComplianceTask; startBlockReason: string | null; submitBlockReason: string | null; verifyBlockReason: string | null; reopenBlockReason: string | null; onChange: (s: TaskStatus) => void }): JSX.Element {
  // A button is enabled only when the role allows it AND no state reason
  // blocks it. The tooltip names the role gap first, else the state reason.
  const btn = (label: string, status: TaskStatus, action: Action, reason: string | null, need: string): JSX.Element => {
    const roleOk = can(me, action, task);
    const allowed = roleOk && reason === null;
    return (
      <button key={status} disabled={!allowed} title={allowed ? '' : (roleOk ? (reason ?? '') : `Requires: ${need}`)} onClick={() => onChange(status)}>
        {label}
      </button>
    );
  };
  return (
    <div className="status-btns">
      {btn(startButtonLabel(task), 'in_progress', 'task.update', startBlockReason, 'owner / manager / officer / admin')}
      {btn('Submit', 'submitted', 'task.submit', submitBlockReason, 'owner / manager / officer / admin')}
      {btn('Verify', 'verified', 'task.verify', verifyBlockReason, 'compliance officer / admin')}
      {task.status === 'submitted' && verifyBlockReason && can(me, 'task.verify', task) && <p className="sod-note">{verifyBlockReason}</p>}
      {btn('Reopen', 'open', 'task.update', reopenBlockReason, 'owner / manager / officer / admin')}
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

function EvidenceForm({ onAdd, kinds }: { onAdd: (label: string, holder: string, kind?: string) => void; kinds?: Array<{ value: string; label: string }> }): JSX.Element {
  const [label, setLabel] = useState('');
  const [holder, setHolder] = useState('');
  const [kind, setKind] = useState(kinds?.[0]?.value ?? '');
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(label, holder, kinds ? kind : undefined);
        setLabel('');
        setHolder('');
      }}
    >
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Evidence label" required />
      <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Holder" required />
      {kinds && (
        <select aria-label="Evidence kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      )}
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
