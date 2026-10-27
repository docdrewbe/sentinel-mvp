import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NewTask } from './api.js';
import { CAPA_SEVERITY_LABELS, CAPA_STATUS_LABELS, CONTROL_LABELS, KIND_LABELS, RECURRENCE_LABELS, ROLE_LABELS, STATUS_LABELS, type AuditEvent, type CapaRecord, type CapaStatus, type ComplianceTask, type DemoUser, type Organization, type RecurringObligation, type RegulatoryDomain, type TaskStatus, type TaskTemplate } from '../shared/types.js';
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import { addDaysISO, isValidIsoDate, nextDueDate, orgToday, periodKeyFor } from '../shared/scheduling.js';
import { capaCriteriaLocked, qualifyingEffectivenessEvidence } from '../shared/capa.js';
import { CAPA_NEXT, applySettled, beginContext, calendarBucket, canAct, capaAdvanceBlockReason, capaReviewBlockReason, evidenceLockedReason, initialPanels, isDueSoonWork, isOverdueWork, newObligationBlockReason, overdueBadgeLabel, panelData, reopenBlockReason, requiredEvidenceFor, resolveOrgId, reviewEvidenceLabels, startBlockReason, startButtonLabel, submitBlockReason, submitStatusReason, verifyBlockReason, verifyEvidenceReason, verifyStatusReason, type Panels } from './dashboard.js';

// CAL3: overdue/due-soon compare against the org-local civil day, passed in
// by the dashboard (orgToday). Pure string comparison — no local time zone.
// isOverdue flags any past-target date (including submitted awaiting
// verification) for red styling and due-soon exclusion; the local dueSoon
// feeds only the inline badge. The KPI cards and filters use isOverdueWork
// and isDueSoonWork (open/in-progress only) so counts match rows.
const isOverdue = (t: ComplianceTask, today: string): boolean => t.status !== 'verified' && t.dueDate < today;
const dueSoon = (t: ComplianceTask, today: string): boolean => {
  if (t.status === 'verified' || isOverdue(t, today)) return false;
  const edge = addDaysISO(today, 7);
  return edge !== null && t.dueDate <= edge;
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
  const [calDomain, setCalDomain] = useState('all');
  const [calPerson, setCalPerson] = useState('all');
  const [calBucket, setCalBucket] = useState('all');
  const [showNewObligation, setShowNewObligation] = useState(false);
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
  const obligations = panelData(panels.obligations, contextKey);
  const tasksReady = canAct(panels.tasks, contextKey);
  const domainsReady = canAct(panels.domains, contextKey);
  const auditReady = canAct(panels.audit, contextKey);
  const templatesReady = canAct(panels.templates, contextKey);
  const capasReady = canAct(panels.capas, contextKey);
  const obligationsReady = canAct(panels.obligations, contextKey);
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
  const orgUsers = useMemo(() => users.filter((u) => !orgId || u.orgId === orgId), [users, orgId]);
  const today = orgToday(org?.timeZone ?? 'UTC');
  const calendarTasks = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            (calDomain === 'all' || t.domainId === calDomain) &&
            (calPerson === 'all' || t.ownerId === calPerson) &&
            (calBucket === 'all' || calendarBucket(t, today) === calBucket)
        )
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [tasks, calDomain, calPerson, calBucket, today]
  );
  const orgIds = useMemo(() => orgs.map((o) => o.id), [orgs]);
  const visibleOrgs = useMemo(
    () => (me ? orgs.filter((o) => visibleOrgIds(me, orgIds).includes(o.id)) : orgs),
    [me, orgs, orgIds]
  );

  const refresh = useCallback(async (oid: string, key: string) => {
    if (!oid) return;
    const mySeq = ++requestSeq.current;
    const [t, d, a, tpl, c, o] = await Promise.allSettled([
      api.tasks(oid),
      api.domains(oid),
      api.audit(200),
      api.templates(oid),
      api.capas(oid),
      api.obligations(oid)
    ]);
    setPanels((prev) =>
      applySettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, t, d, a, tpl, c, o)
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
      setShowNewObligation(false);
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
    if (statusFilter === 'overdue') return isOverdueWork(t, today);
    if (statusFilter === 'dueSoon') return isDueSoonWork(t, today);
    return t.status === statusFilter;
  });

  const stats = {
    open: tasks.filter((t) => t.status === 'open').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    dueSoon: tasks.filter((t) => isDueSoonWork(t, today)).length,
    overdue: tasks.filter((t) => isOverdueWork(t, today)).length,
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

        <section className="panel">
          <div className="panel-head">
            <h3>Compliance calendar (illustrative targets — org-selected, not legal mandates)</h3>
            <div className="panel-actions">
              <select value={calDomain} onChange={(e) => setCalDomain(e.target.value)} aria-label="Filter calendar by domain" disabled={!tasksReady}>
                <option value="all">All domains</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.code}</option>
                ))}
              </select>
              <select value={calPerson} onChange={(e) => setCalPerson(e.target.value)} aria-label="Filter calendar by responsible person" disabled={!tasksReady}>
                <option value="all">All people</option>
                {orgUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              <select value={calBucket} onChange={(e) => setCalBucket(e.target.value)} aria-label="Filter calendar by status" disabled={!tasksReady}>
                <option value="all">All work</option>
                <option value="upcoming">Upcoming</option>
                <option value="dueSoon">Due within 7 days</option>
                <option value="overdue">Overdue</option>
                <option value="submitted">Submitted (completed)</option>
                <option value="verified">Verified</option>
              </select>
            </div>
          </div>
          {org && <p className="trail-detail">Dates in {org.timeZone} (org-local).</p>}
          <PanelNotice panel={panels.tasks} contextKey={contextKey} name="calendar tasks" orgName={org?.name ?? 'this organization'} onRetry={retry} />
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Task</th>
                <th>Domain</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {calendarTasks.map((t) => (
                <tr key={t.id} className={t.id === taskId ? 'selected' : ''} onClick={() => setTaskId(t.id)}>
                  <td className={isOverdue(t, today) ? 'overdue' : ''}>{t.dueDate}</td>
                  <td className="task-title">{t.title}</td>
                  <td>{domainById.get(t.domainId)?.code ?? '—'}</td>
                  <td>{userName.get(t.ownerId) ?? '—'}</td>
                  <td>
                    <span className={`status status-${t.status}`}>{STATUS_LABELS[t.status]}</span>
                    {overdueBadgeLabel(t, today) && <span className="status status-overdue">{overdueBadgeLabel(t, today)}</span>}
                    {!isOverdue(t, today) && dueSoon(t, today) && <span className="status status-submitted">Due soon</span>}
                  </td>
                </tr>
              ))}
              {calendarTasks.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">No work matches these calendar filters.</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="panel-head">
            <h3>Recurring obligations (synthetic schedules — illustrative)</h3>
            <div className="panel-actions">
              {me && can(me, 'task.create') && (
                <button
                  className="primary"
                  onClick={() => setShowNewObligation((s) => !s)}
                  disabled={!obligationsReady || !templatesReady || newObligationBlockReason(templates) !== null}
                  title={templatesReady && obligationsReady ? (newObligationBlockReason(templates) ?? '') : ''}
                >
                  {showNewObligation ? 'Close' : 'New obligation'}
                </button>
              )}
            </div>
          </div>
          <PanelNotice panel={panels.obligations} contextKey={contextKey} name="obligations" orgName={org?.name ?? 'this organization'} onRetry={retry} />
          {showNewObligation && me && org && (
            <NewObligationForm
              orgId={org.id}
              timeZone={org.timeZone}
              templates={templates.filter((x) => x.active)}
              users={orgUsers}
              onSubmit={(o) => run(async () => api.createObligation(o)).then(() => setShowNewObligation(false))}
            />
          )}
          <table>
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Cadence</th>
                <th>Control</th>
                <th>Next target</th>
                <th>Assignee</th>
                <th>Generated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => (
                <ObligationRow
                  key={o.id}
                  obligation={o}
                  template={templateById.get(o.templateId)}
                  ready={obligationsReady && tasksReady && templatesReady}
                  today={today}
                  userName={userName}
                  canGenerate={!!me && can(me, 'task.create')}
                  onGenerate={() => {
                    setError('');
                    api.generateObligation(o.id)
                      .then((out) => {
                        setTaskId(out.task.id);
                        return refresh(orgId, contextKey);
                      })
                      .catch((e: Error) => setError(e.message));
                  }}
                />
              ))}
              {obligations.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">No recurring obligations for this organization yet.</td>
                </tr>
              )}
            </tbody>
          </table>
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
                timeZone={org.timeZone}
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
                    <td className={isOverdue(t, today) ? 'overdue' : ''}>{t.dueDate}</td>
                    <td>
                      <span className={`status status-${t.status}`}>{STATUS_LABELS[t.status]}</span>
                      {overdueBadgeLabel(t, today) && <span className="status status-overdue">{overdueBadgeLabel(t, today)}</span>}
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
                  {task.obligationId && (
                    <div><dt>Obligation</dt><dd>Due period {task.periodKey ?? '—'} (recurring schedule)</dd></div>
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
                  <div><dt>Due</dt><dd className={isOverdue(task, today) ? 'overdue' : ''}>{task.dueDate}</dd></div>
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
                        lockedTitle={evidenceLockedReason(task) ?? undefined}
                      />
                    )}
                    {can(me, 'custody.transfer', task) && task.evidence.length > 0 && (
                      <TransferForm
                        evidence={task.evidence}
                        onTransfer={(evidenceId, toHolder, reason) =>
                          run(async () => api.transfer(task.id, { evidenceId, toHolder, reason }))
                        }
                        lockedTitle={evidenceLockedReason(task) ?? undefined}
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
              timeZone={org.timeZone}
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

function CapaFieldEditor({ label, value, canEdit, lockedTitle, onSave }: { label: string; value: string | undefined; canEdit: boolean; lockedTitle?: string; onSave: (text: string) => void }): JSX.Element | null {
  const [text, setText] = useState(value ?? '');
  // P1: a locked field renders disabled with its explanation for every role.
  if (lockedTitle) {
    return (
      <div className="form">
        <label>{label}</label>
        <input value={text} disabled title={lockedTitle} onChange={(e) => setText(e.target.value)} placeholder={`${label} (simulated)…`} />
        <div>
          <button disabled title={lockedTitle}>
            Save {label.toLowerCase()}
          </button>
        </div>
      </div>
    );
  }
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
  const advanceBlock = next && !reviewing ? capaAdvanceBlockReason(me, capa) : null;
  const reviewReason = reviewing ? capaReviewBlockReason(me, capa, privilegedIds) : null;
  const qualifying = reviewing ? qualifyingEffectivenessEvidence(capa) : [];
  const advanceAction = next === 'effectiveness_review' ? 'capa.review.request' : 'capa.update';
  const advanceRoleOk = can(me, advanceAction, capa);
  const advanceAllowed = ready && advanceBlock === null && next !== null && !reviewing;
  const advanceTitle = !ready
    ? 'CAPA actions unavailable while data is loading or failed.'
    : (advanceBlock ?? '');
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
  const note = (advanceRoleOk ? advanceBlock : null) ?? reviewReason ?? (reviewing ? formReason : null);
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
          lockedTitle={
            field === 'effectivenessCriteria' && reviewing && capaCriteriaLocked(capa.status)
              ? 'Locked during effectiveness review'
              : undefined
          }
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
              {!outcome ? 'Record review' : outcome === 'ineffective' ? 'Record Ineffective Review' : 'Record Effective Review'}
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
                <div className="trail-detail">{r.rationale} (evidence: {reviewEvidenceLabels(capa.evidence, r.evidenceIds).join('; ') || 'none'})</div>
                <div className="trail-detail">Judged against: {r.criteriaSnapshot}</div>
              </li>
            ))}
          </ol>
        </>
      )}
      {(capa.criteriaHistory ?? []).length > 0 && (
        <>
          <h5>Criteria history ({(capa.criteriaHistory ?? []).length})</h5>
          <ol className="trail">
            {(capa.criteriaHistory ?? []).map((h) => (
              <li key={h.seq}>
                <code>#{h.seq}</code> cycle {h.cycle} · {userName.get(h.byUserId) ?? h.byUserId} ·{' '}
                {new Date(h.at).toLocaleString()}
                <div className="trail-detail">{h.text}</div>
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

function ObligationRow({ obligation: o, template, ready, today, userName, canGenerate, onGenerate }: {
  obligation: RecurringObligation;
  template: TaskTemplate | undefined;
  ready: boolean;
  today: string;
  userName: Map<string, string>;
  canGenerate: boolean;
  onGenerate: () => void;
}): JSX.Element {
  // CAL2: mirror the server's period check; the server still decides.
  const period = template ? periodKeyFor(o.nextDueDate, template.recurrence.frequency) : null;
  const duplicate = period !== null && o.generatedPeriods.includes(period);
  const allowed = ready && canGenerate && o.active && !duplicate;
  const reason = !ready
    ? 'Unavailable while data is loading or failed.'
    : !canGenerate
      ? 'Requires: manager / compliance officer / admin'
      : !o.active
        ? 'Obligation is inactive.'
        : duplicate
          ? 'Instance already exists for this due period.'
          : `Generate the ${o.nextDueDate} instance.`;
  const targetLate = o.active && o.nextDueDate < today;
  return (
    <tr>
      <td className="task-title">
        {template?.title ?? o.templateId}
        {!o.active && <span className="status">Inactive</span>}
        <div className="trail-detail">
          {template?.regulatoryRefs.map((r) => `${r.source} — ${r.citation}`).join(' · ') || 'No source refs'}
        </div>
        {(o.scheduleHistory ?? []).map((h) => (
          <div key={h.seq} className="trail-detail">
            #{h.seq} {h.change}: {h.oldValue || 'none'} → {h.newValue || 'none'} — {h.reason}{' '}
            ({userName.get(h.byUserId) ?? h.byUserId})
          </div>
        ))}
      </td>
      <td>{template ? RECURRENCE_LABELS[template.recurrence.frequency] : '—'}</td>
      <td>
        {template ? (
          <span className={`status ${template.controlType === 'legally_required' ? 'status-submitted' : 'status-in_progress'}`}>
            {CONTROL_LABELS[template.controlType]}
          </span>
        ) : '—'}
      </td>
      <td className={targetLate ? 'overdue' : ''}>
        {o.nextDueDate}
        {targetLate && <span className="status status-overdue">Target passed</span>}
      </td>
      <td>{o.assigneeId ? (userName.get(o.assigneeId) ?? '—') : 'Unassigned'}</td>
      <td>{o.generatedPeriods.length}</td>
      <td>
        <button disabled={!allowed} title={reason} onClick={onGenerate}>
          Generate
        </button>
      </td>
    </tr>
  );
}

function NewObligationForm({ orgId, timeZone, templates, users, onSubmit }: {
  orgId: string;
  timeZone: string;
  templates: TaskTemplate[];
  users: DemoUser[];
  onSubmit: (o: { orgId: string; templateId: string; nextDueDate: string; assigneeId?: string }) => void;
}): JSX.Element {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [nextDueDate, setNextDueDate] = useState(orgToday(timeZone));
  const [assigneeId, setAssigneeId] = useState('');
  useEffect(() => {
    setTemplateId(templates[0]?.id ?? '');
  }, [templates]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ orgId, templateId, nextDueDate, ...(assigneeId ? { assigneeId } : {}) });
      }}
    >
      <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Source template">
        {templates.map((x) => (
          <option key={x.id} value={x.id}>{x.title} ({RECURRENCE_LABELS[x.recurrence.frequency]})</option>
        ))}
      </select>
      <input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} aria-label="Next target date (illustrative)" required />
      <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-label="Assignee">
        <option value="">Unassigned (instances fall back to you)</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
        ))}
      </select>
      <button className="primary" type="submit" disabled={!templateId || !isValidIsoDate(nextDueDate)} title={isValidIsoDate(nextDueDate) ? '' : 'Enter a real calendar date (YYYY-MM-DD).'}>
        Create obligation
      </button>
    </form>
  );
}

function NewTaskForm({ orgId, timeZone, domains, users, onSubmit }: { orgId: string; timeZone: string; domains: RegulatoryDomain[]; users: DemoUser[]; onSubmit: (t: NewTask) => void }): JSX.Element {
  const [title, setTitle] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(orgToday(timeZone));
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

function EvidenceForm({ onAdd, kinds, lockedTitle }: { onAdd: (label: string, holder: string, kind?: string) => void; kinds?: Array<{ value: string; label: string }>; lockedTitle?: string }): JSX.Element {
  const [label, setLabel] = useState('');
  const [holder, setHolder] = useState('');
  const [kind, setKind] = useState(kinds?.[0]?.value ?? '');
  // M-UI1: a locked form renders every control disabled with the explanation,
  // mirroring CapaFieldEditor. Callers keep their own role gates.
  const locked = lockedTitle !== undefined;
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
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Evidence label" required disabled={locked} title={lockedTitle} />
      <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Holder" required disabled={locked} title={lockedTitle} />
      {kinds && (
        <select aria-label="Evidence kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={locked} title={lockedTitle}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      )}
      <button type="submit" disabled={locked} title={lockedTitle}>Add evidence</button>
    </form>
  );
}

function TransferForm({ evidence, onTransfer, lockedTitle }: { evidence: ComplianceTask['evidence']; onTransfer: (id: string, holder: string, reason?: string) => void; lockedTitle?: string }): JSX.Element {
  const [evidenceId, setEvidenceId] = useState(evidence[0]?.id ?? '');
  const [toHolder, setToHolder] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setEvidenceId(evidence[0]?.id ?? '');
  }, [evidence]);
  // M-UI1: locked forms disable every control with the explanation (see EvidenceForm).
  const locked = lockedTitle !== undefined;
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
      <select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} aria-label="Evidence item" disabled={locked} title={lockedTitle}>
        {evidence.map((x) => (
          <option key={x.id} value={x.id}>{x.label} (now: {x.holder})</option>
        ))}
      </select>
      <input value={toHolder} onChange={(e) => setToHolder(e.target.value)} placeholder="Transfer to (new holder)" required disabled={locked} title={lockedTitle} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" disabled={locked} title={lockedTitle} />
      <button type="submit" disabled={locked} title={lockedTitle}>Transfer custody</button>
    </form>
  );
}

function InstantiateForm({ template, timeZone, users, onSubmit }: { template: TaskTemplate; timeZone: string; users: DemoUser[]; onSubmit: (ownerId: string, dueDate: string) => void }): JSX.Element {
  const defaultDue =
    nextDueDate(orgToday(timeZone), template.recurrence.frequency) ??
    (addDaysISO(orgToday(timeZone), 30) ?? orgToday(timeZone));
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(defaultDue);
  useEffect(() => {
    setOwnerId(users[0]?.id ?? '');
  }, [users]);
  useEffect(() => {
    setDueDate(
      nextDueDate(orgToday(timeZone), template.recurrence.frequency) ??
        (addDaysISO(orgToday(timeZone), 30) ?? orgToday(timeZone))
    );
  }, [template, timeZone]);
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
