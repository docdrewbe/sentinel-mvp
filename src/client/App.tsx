import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type DocAuditCompareResult,
  type DocAuditFinding,
  type DocAuditFollowupPayload,
  type NewNotice,
  type NewTask,
  type NoticeFollowupPayload
} from './api.js';
import { CAPA_SEVERITY_LABELS, CAPA_STATUS_LABELS, CONCERN_CATEGORY_LABELS, CONCERN_CLOSED_MEANING_NOTICE, CONCERN_DESCRIPTION_MAX, CONCERN_EMERGENCY_NOTICE, CONCERN_IDENTIFIED_NOTICE, CONCERN_LOCATION_MAX, CONCERN_MESSAGE_MAX, CONCERN_NO_SENSITIVE_DETAILS_HINT, CONCERN_REVIEWER_ACCESS_NOTICE, CONCERN_STATUS_LABELS, CONCERN_TITLE_MAX, CONTROL_LABELS, KIND_LABELS, NOTICE_APPLICABLE_MEANING_NOTICE, NOTICE_FINALITY_NOTICE, NOTICE_RATIONALE_MAX, NOTICE_SOURCE_MAX, NOTICE_STATUS_LABELS, NOTICE_SYNTHETIC_NOTICE, NOTICE_TEXT_MAX, NOTICE_TITLE_MAX, RECURRENCE_LABELS, ROLE_LABELS, STATUS_LABELS, type AuditEvent, type CapaRecord, type CapaStatus, type ComplianceTask, type ConcernCategory, type ConcernRecord, type ConcernStatus, type DemoUser, type MyUpdateEntry, type NoticeRecord, type NoticeStatus, type Organization, type RecurringObligation, type RegulatoryDomain, type TaskStatus, type TaskTemplate } from '../shared/types.js';
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import { addDaysISO, isValidIsoDate, nextDueDate, orgToday, periodKeyFor } from '../shared/scheduling.js';
import { capaCriteriaLocked, qualifyingEffectivenessEvidence } from '../shared/capa.js';
import { CONCERN_CATEGORIES, nextConcernStatus } from '../shared/concerns.js';
import { CAPA_NEXT, DOCAUDIT_KEYS_UNAVAILABLE_CODE, DOCAUDIT_SAMPLE_A, DOCAUDIT_SAMPLE_B, DOCAUDIT_SUMMARY_MAX, DOCAUDIT_TASK_TITLE_MAX, DOCAUDIT_TEXT_MAX, FOLLOWUP_EVIDENCE_NOTE, applyFeedSettled, applyOneSettled, applySettled, auditEventDomId, beginContext, concernStatusDomId, concernUpdateDomId, buildFollowupPreview, calendarBucket, canAct, capaAdvanceBlockReason, capaReviewBlockReason, evidenceLockedReason, findingBlockers, findingKindLabel, followupSettleAction, initialPanels, linkedCapaLine, STAT_KEYS, STAT_LABELS, FILTER_LABELS, filterBarState, previewToggleIdForRegion, statPreviewRegionId, statPreviewToggleId, statPreviewTasks, statTasks, contextOpObsolete, creationResponseSuperseded, resolveInstantiateTemplate, resolvePendingCreation, retainSelection, selectionSurvivesReconcile, shouldCloseFormOnCompletion, endSubmit, tryBeginSubmit, statusFilterMatches, navFallbackNotice, newObligationBlockReason, shortDisplayId, occurrenceLabel, occurrencesTruncated, overdueBadgeLabel, panelData, reopenBlockReason, requiredEvidenceFor, resolveFollowupKey, resolveOrgId, reviewEvidenceLabels, shouldApplyDocAuditResponse, startBlockReason, startButtonLabel, submitBlockReason, submitStatusReason, triageUsersFor, updateNavTarget, updatesViewState, verifyBlockReason, verifyEvidenceReason, verifyStatusReason, verifiedLockNoteId, type DocAuditVerdict, type FollowupKeyBinding, type ConcernDetailView, type FollowupPreviewRow, type PanelState, type Panels, type PendingCreation, type RunOutcome, type StatKey, type SubmitGuard, type UpdateNavTarget } from './dashboard.js';

// CAL3: overdue/due-soon compare against the org-local civil day, passed in
// by the dashboard (orgToday). Pure string comparison — no local time zone.
// isOverdue flags any past-target date (including submitted awaiting
// verification) for red styling and due-soon exclusion; the local dueSoon
// feeds only the inline badge. The KPI cards and filters use statMatches
// (over isOverdueWork/isDueSoonWork, open/in-progress only) so counts,
// previews, and rows share one matcher.
const STAT_TONES: Record<StatKey, string> = {
  open: 'ink',
  in_progress: 'blue',
  dueSoon: 'amber',
  overdue: 'red',
  verified: 'green'
};
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
  // N-3/N-4/S-1: creation-intent identity (bumped by every newer selection,
  // navigation, filter action, creation click, and context switch) and the
  // request seq that produced the current tasks data (null before any).
  // P-2: context generation, bumped ONLY by context switches, so stale
  // completions can be told apart from same-context superseded ones.
  // R-2: per-form instance counters, bumped on every open, so a late
  // completion closes only the instance that submitted.
  const creationSeq = useRef(0);
  const contextSeq = useRef(0);
  const newTaskFormSeq = useRef(0);
  const newObligationFormSeq = useRef(0);
  const instantiateFormSeq = useRef(0);
  const lastTasksLoadSeq = useRef<number | null>(null);
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState(() => localStorage.getItem('sentinel-user') ?? '');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [capaId, setCapaId] = useState<string | null>(null);
  // Slice-1 concerns: triage queue + personal list, context-keyed like Panels.
  const [concernQueue, setConcernQueue] = useState<PanelState<ConcernRecord>>({ key: '', status: 'loading', data: [] });
  const [myConcerns, setMyConcerns] = useState<PanelState<ConcernRecord>>({ key: '', status: 'loading', data: [] });
  const [concernId, setConcernId] = useState<string | null>(null);
  const [myConcernId, setMyConcernId] = useState<string | null>(null);
  const [concernReceipt, setConcernReceipt] = useState<{ key: string; concern: ConcernRecord } | null>(null);
  // Slice-1 safety notices: org-scoped list + selected detail, context-keyed
  // like the concern panels. All readers in the org may view; intake,
  // review, and follow-up creation need notice.manage (manager+).
  const [noticePanel, setNoticePanel] = useState<PanelState<NoticeRecord>>({ key: '', status: 'loading', data: [] });
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [showNoticeIntake, setShowNoticeIntake] = useState(false);
  // N-2: every intake opening is a distinct instance; only its own
  // completed submission may close it (R-2, like the task forms).
  const noticeIntakeSeq = useRef(0);
  // My recent updates: personal feed panel + pending exact-target navigation.
  const [updatesPanel, setUpdatesPanel] = useState<PanelState<MyUpdateEntry>>({ key: '', status: 'loading', data: [] });
  const [pendingNav, setPendingNav] = useState<{ key: string; target: UpdateNavTarget } | null>(null);
  const [navNotice, setNavNotice] = useState<{ key: string; recordId: string; message: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  // Summary-card previews: one pinned (disclosure) at a time plus one
  // transient hover/focus preview. Never stale-context: cleared on switch.
  const [pinnedPreview, setPinnedPreview] = useState<StatKey | null>(null);
  const [hoverPreview, setHoverPreview] = useState<StatKey | null>(null);
  // N-3/N-4: creation id awaiting a follow-up load that started after
  // the creation response (afterSeq bound), context-bound like pendingNav.
  // Resolves once; superseded or switch-cancelled after that.
  const [pendingCreatedTask, setPendingCreatedTask] = useState<PendingCreation | null>(null);
  const [controlFilter, setControlFilter] = useState('all');
  const [calDomain, setCalDomain] = useState('all');
  const [calPerson, setCalPerson] = useState('all');
  const [calBucket, setCalBucket] = useState('all');
  const [showNewObligation, setShowNewObligation] = useState(false);
  // P-1: bound to its originating context; the form renders only when the
  // template resolves in the current context's loaded templates (below).
  const [instantiateFor, setInstantiateFor] = useState<{ key: string; templateId: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  // WM2 client: document-audit review state. Findings, verdicts, selections,
  // previews, and pending attempts all belong to one user+org context and
  // are cleared synchronously whenever it changes (see the context effect).
  const [docaTextA, setDocaTextA] = useState('');
  const [docaTextB, setDocaTextB] = useState('');
  const [docaResult, setDocaResult] = useState<{ key: string; seq: number; result: DocAuditCompareResult } | null>(null);
  const [docaBusy, setDocaBusy] = useState(false);
  const [docaPosting, setDocaPosting] = useState(false);
  const [docaError, setDocaError] = useState('');
  const [docaPending, setDocaPending] = useState<{ findingId: string; payload: DocAuditFollowupPayload; busy: boolean } | null>(null);
  const [docaCompleted, setDocaCompleted] = useState<Record<string, { taskId: string; title: string; duplicate: boolean }>>({});
  const docaSeq = useRef(0);
  const docaBusyRef = useRef(false);
  /** Which compare send owns the busy flag (-1 = none). */
  const docaBusySeq = useRef(-1);

  const me = users.find((u) => u.id === userId) ?? null;
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const contextKey = `${userId}|${orgId}`;
  // Guarded rows: only loaded panels of the current context ever render.
  const tasks = panelData(panels.tasks, contextKey);
  const domains = panelData(panels.domains, contextKey);
  const audit = panelData(panels.audit, contextKey);
  const templates = panelData(panels.templates, contextKey);
  const instantiateTemplate = resolveInstantiateTemplate(instantiateFor, contextKey, templates);
  const capas = panelData(panels.capas, contextKey);
  const obligations = panelData(panels.obligations, contextKey);
  const tasksReady = canAct(panels.tasks, contextKey);
  const domainsReady = canAct(panels.domains, contextKey);
  const auditReady = canAct(panels.audit, contextKey);
  const templatesReady = canAct(panels.templates, contextKey);
  const capasReady = canAct(panels.capas, contextKey);
  const obligationsReady = canAct(panels.obligations, contextKey);
  const queueRows = panelData(concernQueue, contextKey);
  const myRows = panelData(myConcerns, contextKey);
  const queueReady = canAct(concernQueue, contextKey);
  const myReady = canAct(myConcerns, contextKey);
  const noticeRows = panelData(noticePanel, contextKey);
  const noticesReady = canAct(noticePanel, contextKey);
  const selectedNotice = noticeRows.find((n) => n.id === noticeId) ?? null;
  const canNoticeManage =
    me !== null && orgId !== '' && can(me, 'notice.manage', { orgId, ownerId: '' });
  const updateRows = panelData(updatesPanel, contextKey);
  const updatesView = updatesViewState(updatesPanel, contextKey);
  const canTriageHere =
    me !== null && orgId !== '' && can(me, 'concern.triage', { orgId, ownerId: '' });
  const task = tasks.find((t) => t.id === taskId) ?? null;
  const capa = capas.find((c) => c.id === capaId) ?? null;
  const queueConcern = queueRows.find((c) => c.id === concernId) ?? null;
  const myConcern = myRows.find((c) => c.id === myConcernId) ?? null;
  const receipt = concernReceipt !== null && concernReceipt.key === contextKey ? concernReceipt.concern : null;
  // M-UI1: id of the visible verified-lock explanation; locked detail-panel
  // controls reference it via aria-describedby. Null unless verified.
  const taskLockNoteId = task ? verifiedLockNoteId(task) : null;

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
    const [t, d, a, tpl, c, o, cq, mc, up, nt] = await Promise.allSettled([
      api.tasks(oid),
      api.domains(oid),
      api.audit(200),
      api.templates(oid),
      api.capas(oid),
      api.obligations(oid),
      api.concerns(oid),
      api.myConcerns(oid),
      api.myUpdates(oid),
      api.notices(oid)
    ]);
    setPanels((prev) =>
      applySettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, t, d, a, tpl, c, o)
    );
    // N-3/N-4: record which request produced the current tasks data, using
    // applySettled's exact guard, so pending creation resolves only
    // against loads that started after the creation response. Older
    // in-flight responses are dropped by the guard and never recorded.
    if (t.status === 'fulfilled' && key === contextKeyRef.current && mySeq === requestSeq.current) {
      lastTasksLoadSeq.current = mySeq;
    }
    setConcernQueue((prev) =>
      applyOneSettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, cq)
    );
    setMyConcerns((prev) =>
      applyOneSettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, mc)
    );
    setUpdatesPanel((prev) =>
      applyFeedSettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, up)
    );
    setNoticePanel((prev) =>
      applyOneSettled(prev, key, mySeq, contextKeyRef.current, requestSeq.current, nt)
    );
  }, []);

  /** Synchronous review-state clear for user/org switches; never async. */
  const clearDocAudit = useCallback((): void => {
    docaSeq.current += 1;
    docaBusySeq.current = -1;
    setDocaTextA('');
    setDocaTextB('');
    setDocaResult(null);
    setDocaBusy(false);
    setDocaPosting(false);
    setDocaError('');
    setDocaPending(null);
    setDocaCompleted({});
    docaBusyRef.current = false;
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
      clearDocAudit();
      // Concern selections, receipt, and rows never survive a user/org switch.
      setConcernId(null);
      setMyConcernId(null);
      setConcernReceipt(null);
      setConcernQueue({ key: nextKey, status: 'loading', data: [] });
      setMyConcerns({ key: nextKey, status: 'loading', data: [] });
      // Notice selection, intake draft, and rows never survive a user/org switch.
      setNoticeId(null);
      setShowNoticeIntake(false);
      setNoticePanel({ key: nextKey, status: 'loading', data: [] });
      // Feed entries and pending navigation never survive a user/org switch.
      setUpdatesPanel({ key: nextKey, status: 'loading', data: [] });
      setPendingNav(null);
      setNavNotice(null);
      // The card filter, pinned/hover previews, and any pending focus reset
      // on a user/org switch so no stale-context titles can display.
      setStatusFilter('all');
      setPinnedPreview(null);
      setHoverPreview(null);
      setPendingCreatedTask(null);
      creationSeq.current += 1;
      contextSeq.current += 1;
    }
    refresh(orgId, nextKey).catch((e: Error) => setError(e.message));
  }, [userId, orgId, users, orgs, refresh, clearDocAudit]);

  const run = async (fn: () => Promise<unknown>): Promise<RunOutcome> => {
    setError('');
    // P-2: bind the operation to its originating context generation.
    const gen = contextSeq.current;
    try {
      await fn();
      // Obsolete completion (switch, incl. away-and-back): skip the
      // refresh — a stale key would bump the shared sequence and
      // invalidate the current context's in-flight load.
      if (contextOpObsolete(gen, contextSeq.current)) return 'obsolete';
      await refresh(orgId, contextKey);
    } catch (e) {
      if (contextOpObsolete(gen, contextSeq.current)) return 'obsolete';
      setError(e instanceof Error ? e.message : 'Action failed.');
      return 'failed';
    }
    // R-2: re-check after the refresh — a switch during the load must not
    // report success into the new context.
    if (contextOpObsolete(gen, contextSeq.current)) return 'obsolete';
    return 'completed';
  };

  const retry = (): void => {
    refresh(orgId, contextKey).catch((e: Error) => setError(e.message));
  };

  /**
   * Source-text edits invalidate findings, verdicts, selections, previews,
   * and completions (finding cards unmount with the result). The sequence
   * bump additionally discards any late compare response.
   */
  const invalidateDocAuditResults = useCallback((): void => {
    docaSeq.current += 1;
    setDocaResult(null);
    setDocaError('');
    setDocaCompleted({});
  }, []);

  const setDocaInput = useCallback(
    (side: 'A' | 'B', value: string): void => {
      if (side === 'A') setDocaTextA(value);
      else setDocaTextB(value);
      invalidateDocAuditResults();
    },
    [invalidateDocAuditResults]
  );

  const runCompare = useCallback(async (): Promise<void> => {
    if (docaBusyRef.current || docaPending || docaPosting) return;
    docaBusyRef.current = true;
    const key = `${userId}|${orgId}`;
    const seq = ++docaSeq.current;
    docaBusySeq.current = seq;
    setDocaBusy(true);
    setDocaError('');
    try {
      const result = await api.docauditCompare({ orgId, textA: docaTextA, textB: docaTextB });
      if (!shouldApplyDocAuditResponse(key, seq, contextKeyRef.current, docaSeq.current)) return;
      setDocaResult({ key, seq, result });
      setDocaCompleted({});
    } catch (e) {
      if (!shouldApplyDocAuditResponse(key, seq, contextKeyRef.current, docaSeq.current)) return;
      setDocaError(e instanceof Error ? e.message : 'Comparison failed.');
    } finally {
      // Only the owning send clears the flag: text edits invalidate the
      // response but must not strand the spinner, while a newer send or a
      // context switch owns the flag afterwards.
      if (docaBusySeq.current === seq) {
        docaBusyRef.current = false;
        setDocaBusy(false);
      }
    }
  }, [docaPending, docaPosting, userId, orgId, docaTextA, docaTextB]);

  const sendFollowup = useCallback(
    async (findingId: string, payload: DocAuditFollowupPayload, isRetry: boolean): Promise<void> => {
      if (docaPosting) return;
      const key = `${userId}|${orgId}`;
      const seq = ++docaSeq.current;
      setDocaPosting(true);
      if (isRetry) setDocaPending((p) => (p ? { ...p, busy: true } : p));
      setDocaError('');
      try {
        const res = await api.docauditFollowup(payload);
        const action = followupSettleAction(key, seq, contextKeyRef.current, docaSeq.current);
        // Abandoned context: do nothing — no refresh, no alerts, no state.
        if (action === 'ignore') return;
        if (action === 'refresh') {
          // Same context, superseded request: the server may have committed,
          // so reload the current org's panels — and nothing else.
          refresh(orgId, contextKeyRef.current).catch(() => {});
          return;
        }
        setDocaPending(null);
        setDocaCompleted((prev) => ({
          ...prev,
          [findingId]: { taskId: res.task.id, title: res.task.title, duplicate: res.duplicate }
        }));
        refresh(orgId, contextKey).catch((e: Error) => {
          // Never alert an abandoned context: the current view already loaded.
          if (contextKeyRef.current === key) setDocaError(e.message);
        });
      } catch (e) {
        const action = followupSettleAction(key, seq, contextKeyRef.current, docaSeq.current);
        if (action === 'ignore') return;
        if (action === 'refresh') {
          refresh(orgId, contextKeyRef.current).catch(() => {});
          return;
        }
        // Certain failures: the server created nothing, so the reviewer may
        // edit the draft and try again with a freshly minted key.
        const apiErr = e instanceof ApiError ? e : null;
        const certain =
          apiErr !== null &&
          (apiErr.status === 400 ||
            apiErr.status === 403 ||
            apiErr.status === 409 ||
            (apiErr.status === 503 && apiErr.code === DOCAUDIT_KEYS_UNAVAILABLE_CODE));
        if (certain && apiErr) {
          setDocaPending(null);
          setDocaError(
            apiErr.status === 409
              ? `${apiErr.message} Edit any field to mint a new key, or open the existing task instead.`
              : apiErr.status === 503
                ? `${apiErr.message} Other features are unaffected.`
                : apiErr.message
          );
        } else {
          // Ambiguous outcome (network drop, timeout, 500): preserve the
          // exact payload and key for retry; edited replacements stay
          // blocked until this attempt resolves.
          setDocaPending({ findingId, payload, busy: false });
          setDocaError('Unknown outcome — the task may or may not have been created. Retry with the same key.');
        }
      } finally {
        // Only the latest request may clear loading state: a superseded or
        // abandoned request must not touch the current view's flags.
        if (docaSeq.current === seq) {
          setDocaPosting(false);
          setDocaPending((p) => (p ? { ...p, busy: false } : p));
        }
      }
    },
    [docaPosting, userId, orgId, contextKey, refresh]
  );

  const retryFollowup = useCallback((): void => {
    if (!docaPending || docaPending.busy || docaPosting) return;
    sendFollowup(docaPending.findingId, docaPending.payload, true).catch(() => {});
  }, [docaPending, docaPosting, sendFollowup]);

  // Dropdown and card activation share one matcher, so counts, previews,
  // and rows always agree. Card keys double as filter values.
  const filtered = tasks.filter((t) => statusFilterMatches(statusFilter, t, today));
  const filterBar = filterBarState(statusFilter, tasksReady, tasks.length > 0);

  const statCounts = (stat: StatKey): number => statTasks(stat, tasks, today).length;

  /** Filter activation from a card, the dropdown, or Clear: replace the
   * filter and drop a task selection the new filter excludes, so an
   * unrelated detail never stays open. An explicit filter action also
   * supersedes any pending creation navigation. */
  const applyStatusFilter = (value: string): void => {
    setStatusFilter(value);
    creationSeq.current += 1;
    setPendingCreatedTask(null);
    if (taskId !== null && !tasks.some((t) => t.id === taskId && statusFilterMatches(value, t, today))) {
      setTaskId(null);
    }
  };

  /** N-1/N-2: explicit navigation from the calendar or the feed resets the
   * task-list filter to All (calendar filters untouched) and closes card
   * previews before opening the task. All updates batch in one handler, so
   * the F-5 effect reconciles the new selection against 'all' — never the
   * previous filter. */
  const openTaskFromOutside = (id: string): void => {
    setHoverPreview(null);
    setPinnedPreview(null);
    creationSeq.current += 1;
    setPendingCreatedTask(null);
    setStatusFilter('all');
    setTaskId(id);
  };

  /** F-4: Summary-card activation closes every preview first, then filters
   * and lands on the results heading. The heading always renders, so no
   * pending state. "View all N" shares this action. */
  const activateStatCard = (stat: StatKey): void => {
    setHoverPreview(null);
    setPinnedPreview(null);
    applyStatusFilter(stat);
    const el = document.getElementById('tasks-heading');
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  };

  // F-2/F-3: Escape dismisses an open preview wherever focus is. The
  // listener exists only while a preview is open, so other controls'
  // Escape behavior is untouched otherwise. If dismissal removes the
  // focused element (inside the preview), focus returns to that card's
  // Preview toggle — focusing the toggle reopens nothing; focus elsewhere
  // is left alone.
  useEffect(() => {
    if (pinnedPreview === null && hoverPreview === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      const region = active instanceof HTMLElement ? active.closest('.stat-preview') : null;
      const toggleId = region?.id ? previewToggleIdForRegion(region.id) : null;
      setHoverPreview(null);
      setPinnedPreview(null);
      if (toggleId) document.getElementById(toggleId)?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pinnedPreview, hoverPreview]);

  // F-5/N-2: reconcile the selection whenever successful current-context
  // task data changes — a selected task that no longer matches the active
  // filter (after an action or refresh) loses its detail. Loading and
  // failure are not successful datasets: they never clear valid detail.
  useEffect(() => {
    if (!selectionSurvivesReconcile(taskId, tasks, statusFilter, today, tasksReady)) {
      setTaskId(null);
    }
  }, [tasksReady, taskId, tasks, statusFilter, today]);

  // N-3/N-4/§5ay: resolve a pending creation selection only against a
  // successful task load that started after the creation response
  // (lastTasksLoadSeq, recorded at the settle site). Older snapshots and
  // older in-flight responses wait — they never declare the task
  // unavailable — as do loading and failed loads with their honest
  // reporting. The first qualifying load selects the task, reports it
  // unavailable once, or cancels on a context mismatch.
  useEffect(() => {
    if (!pendingCreatedTask) return;
    const outcome = resolvePendingCreation(
      pendingCreatedTask,
      contextKey,
      tasksReady,
      lastTasksLoadSeq.current,
      tasks.some((t) => t.id === pendingCreatedTask.id)
    );
    if (outcome === 'wait') return;
    setPendingCreatedTask(null);
    if (outcome === 'select') setTaskId(pendingCreatedTask.id);
    else if (outcome === 'unavailable') setError('The created task is not available.');
  }, [pendingCreatedTask, contextKey, tasksReady, tasks]);

  const updateStatusLabel = (entry: MyUpdateEntry): string =>
    entry.recordKind === 'task'
      ? (STATUS_LABELS[entry.recordStatus as TaskStatus] ?? entry.recordStatus)
      : (CONCERN_STATUS_LABELS[entry.recordStatus as ConcernStatus] ?? entry.recordStatus);

  /** Feed navigation: select the record first; the effect below focuses the exact target. */
  const openUpdate = (entry: MyUpdateEntry): void => {
    setNavNotice(null);
    const target = updateNavTarget(entry);
    if (target.recordKind === 'task') {
      // Stale entry (record gone from this context): open nothing else.
      if (!tasks.some((t) => t.id === target.recordId)) return;
      openTaskFromOutside(target.recordId);
    } else {
      if (!myRows.some((c) => c.id === target.recordId)) return;
      setMyConcernId(target.recordId);
    }
    setPendingNav({ key: contextKey, target });
  };

  const scrollToMyReports = (): void => {
    const el = document.getElementById('my-reports-heading');
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  };

  // Selection commits (render) before this effect runs, so targets resolve
  // against the freshly rendered detail. First available candidate wins;
  // unavailable targets clear silently without opening another record.
  // A heading landing (no exact target in the loaded window) raises the
  // outside-history notice in the detail panel.
  useEffect(() => {
    if (!pendingNav) return;
    if (pendingNav.key !== contextKey) {
      setPendingNav(null);
      return;
    }
    const target = pendingNav.target;
    const el = target.focusIds
      .map((id) => document.getElementById(id))
      .find((node): node is HTMLElement => node !== null) ?? null;
    setPendingNav(null);
    const notice = navFallbackNotice(el ? el.id : null, target.focusIds);
    setNavNotice(notice ? { key: contextKey, recordId: target.recordId, message: notice } : null);
    if (!el) return;
    // R-4: fallback landings center the heading so the explanation above it
    // is visible too; exact targets keep minimal scrolling.
    el.scrollIntoView({ block: notice ? 'center' : 'nearest' });
    el.focus({ preventScroll: true });
  }, [pendingNav, contextKey, taskId, myConcernId]);

  const recordTrail = task ? audit.filter((e) => e.recordId === task.id) : [];
  const capaTrail = capa ? audit.filter((e) => e.recordId === capa.id) : [];
  const queueConcernTrail = queueConcern ? audit.filter((e) => e.recordId === queueConcern.id) : [];
  const myConcernTrail = myConcern ? audit.filter((e) => e.recordId === myConcern.id) : [];

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
          {STAT_KEYS.map((stat) => {
            const total = tasksReady ? statCounts(stat) : 0;
            const previewId = statPreviewRegionId(stat);
            const visible = tasksReady && (hoverPreview === stat || pinnedPreview === stat);
            const pinned = pinnedPreview === stat;
            const shown = visible ? statPreviewTasks(stat, tasks, today) : [];
            return (
              <div
                key={stat}
                className="stat-cell"
                onMouseLeave={() => setHoverPreview((h) => (h === stat ? null : h))}
              >
                <button
                  type="button"
                  className={`stat stat-${STAT_TONES[stat]}${statusFilter === stat ? ' stat-active' : ''}`}
                  aria-pressed={statusFilter === stat}
                  aria-describedby={visible ? previewId : undefined}
                  disabled={!tasksReady}
                  onClick={() => activateStatCard(stat)}
                  onMouseEnter={() => setHoverPreview(stat)}
                  onFocus={() => setHoverPreview(stat)}
                  onBlur={() => setHoverPreview((h) => (h === stat ? null : h))}
                >
                  <span className="stat-value">{tasksReady ? total : '—'}</span>
                  <span className="stat-label">{STAT_LABELS[stat]}</span>
                </button>
                <button
                  type="button"
                  id={statPreviewToggleId(stat)}
                  className="stat-preview-toggle"
                  aria-label={`Preview ${STAT_LABELS[stat].toLowerCase()} tasks`}
                  aria-expanded={pinned}
                  aria-controls={previewId}
                  disabled={!tasksReady}
                  onClick={() => setPinnedPreview((p) => (p === stat ? null : stat))}
                >
                  Preview
                </button>
                <div
                  id={previewId}
                  className={`stat-preview${pinned ? ' stat-preview-pinned' : ''}`}
                  role="region"
                  aria-label={`${STAT_LABELS[stat]} preview`}
                  hidden={!visible}
                  onMouseEnter={() => setHoverPreview(stat)}
                >
                  {visible &&
                    (total === 0 ? (
                      <p className="empty">No matching tasks.</p>
                    ) : (
                      <>
                        <ol>
                          {shown.map((t) => (
                            <li key={t.id}>
                              {t.title} — {t.dueDate}
                            </li>
                          ))}
                        </ol>
                        {total > shown.length && <p>+{total - shown.length} more</p>}
                        {pinned ? (
                          <button type="button" onClick={() => activateStatCard(stat)}>
                            View all {total}
                          </button>
                        ) : (
                          <p className="hint">Activate the card to view all.</p>
                        )}
                      </>
                    ))}
                </div>
              </div>
            );
          })}
        </section>

        <section className="panel" aria-label="My recent updates">
          <div className="panel-head">
            <h3>My recent updates</h3>
          </div>
          <PanelNotice panel={updatesPanel} contextKey={contextKey} name="recent updates" orgName={org?.name ?? 'this organization'} onRetry={retry} />
          {updatesView === 'empty' && <p className="empty">No updates yet.</p>}
          {updatesView === 'empty-stale' && <p className="empty">No updates were found at the last successful check.</p>}
          {updatesView === 'list' && (
            <ol className="updates">
              {updateRows.map((entry) => (
                <li key={`${entry.recordKind}-${entry.recordId}-${entry.seq}`}>
                  <button type="button" className="update-entry" onClick={() => openUpdate(entry)}>
                    <span className="update-title">{entry.recordTitle}</span>{' '}
                    <span className="update-kind">{entry.recordKind === 'task' ? 'Task' : 'Report'}</span>{' '}
                    <span className="status">{updateStatusLabel(entry)}</span>
                    <div className="trail-detail">
                      {entry.description} · {new Date(entry.timestamp).toLocaleString()}
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p>
            <button type="button" onClick={scrollToMyReports}>View my reports</button>
          </p>
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
                <tr key={t.id} className={t.id === taskId ? 'selected' : ''} onClick={() => { setNavNotice(null); openTaskFromOutside(t.id); }}>
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
                  onClick={() => {
                    if (!showNewObligation) newObligationFormSeq.current += 1;
                    setShowNewObligation((s) => !s);
                  }}
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
              onSubmit={(o) => {
                const formSeq = newObligationFormSeq.current;
                return run(async () => api.createObligation(o)).then((outcome) => {
                  if (shouldCloseFormOnCompletion(outcome, formSeq, newObligationFormSeq.current)) {
                    setShowNewObligation(false);
                  }
                });
              }}
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
                    // S-1/P-2: the navigation intent and context generation
                    // are recorded at CLICK time. A newer creation
                    // supersedes any older pending one.
                    const key = contextKey;
                    const gen = contextSeq.current;
                    const clickSeq = ++creationSeq.current;
                    setPendingCreatedTask(null);
                    api.generateObligation(o.id)
                      .then((out) => {
                        // P-2: obsolete context (switch, incl. away-and-back):
                        // no refresh, no counters, no state changes at all.
                        if (contextOpObsolete(gen, contextSeq.current)) return;
                        // Same-context superseded (newer selection,
                        // navigation, filter, or creation): refresh data
                        // only — no filter reset, no selection, no error.
                        if (creationResponseSuperseded(clickSeq, creationSeq.current)) {
                          return refresh(orgId, contextKey);
                        }
                        // N-3: previews close, the list resets to All, and
                        // the new id waits for a load started after this
                        // response (afterSeq bound captured first).
                        setHoverPreview(null);
                        setPinnedPreview(null);
                        setStatusFilter('all');
                        setPendingCreatedTask({ key, id: out.task.id, afterSeq: requestSeq.current });
                        return refresh(orgId, contextKey);
                      })
                      .catch((e: Error) => {
                        if (!contextOpObsolete(gen, contextSeq.current)) setError(e.message);
                      });
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
              <h3 id="tasks-heading" tabIndex={-1} className="focus-target">Compliance tasks</h3>
              <div className="panel-actions">
                <select value={statusFilter} onChange={(e) => applyStatusFilter(e.target.value)} aria-label="Filter by status" disabled={!tasksReady}>
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="submitted">Submitted</option>
                  <option value="verified">Verified</option>
                  <option value="dueSoon">Due within 7 days</option>
                  <option value="overdue">Overdue</option>
                </select>
                {me && can(me, 'task.create') && (
                  <button className="primary" onClick={() => { if (!showNew) newTaskFormSeq.current += 1; setShowNew((s) => !s); }} disabled={!tasksReady}>
                    {showNew ? 'Close' : 'New task'}
                  </button>
                )}
              </div>
            </div>
            {filterBar.visible && (
              <p className="filter-bar" role="status">
                Showing: {FILTER_LABELS[statusFilter] ?? statusFilter} ({filtered.length})
                {filterBar.stale ? ' — may be out of date' : ''}{' '}
                <button type="button" onClick={() => applyStatusFilter('all')}>
                  Clear filter
                </button>
              </p>
            )}
            <PanelNotice panel={panels.tasks} contextKey={contextKey} name="tasks" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            <PanelNotice panel={panels.domains} contextKey={contextKey} name="regulatory domains" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            {showNew && me && org && (
              <NewTaskForm
                orgId={org.id}
                timeZone={org.timeZone}
                domains={domains}
                users={orgUsers}
                formKey={newTaskFormSeq.current}
                onSubmit={(t) => {
                  const formSeq = newTaskFormSeq.current;
                  return run(async () => api.createTask(t)).then((outcome) => {
                    if (shouldCloseFormOnCompletion(outcome, formSeq, newTaskFormSeq.current)) {
                      setShowNew(false);
                    }
                  });
                }}
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
                  <tr key={t.id} className={t.id === taskId ? 'selected' : ''} onClick={() => { setNavNotice(null); creationSeq.current += 1; setPendingCreatedTask(null); setTaskId(t.id); }}>
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
            {navNotice && navNotice.key === contextKey && task && navNotice.recordId === task.id && (
              <p className="notice" role="status">
                {navNotice.message} <button type="button" onClick={() => setNavNotice(null)}>Dismiss</button>
              </p>
            )}
            <div className="panel-head">
              <h3 id="task-detail-heading" tabIndex={-1} className="focus-target">Task detail</h3>
            </div>
            {!task && <p className="empty">Select a task to review evidence, custody, and history.</p>}
            {task && me && (
              <>
                <h4>{task.title}</h4>
                {tasksReady && task.evidence.length > 0 && (
                  <button
                    type="button"
                    className="evidence-jump"
                    onClick={() => {
                      const el = document.getElementById('task-evidence-heading');
                      el?.scrollIntoView({ block: 'start' });
                      el?.focus({ preventScroll: true });
                    }}
                  >
                    View evidence ({task.evidence.length})
                  </button>
                )}
                {tasksReady && task.evidence.length === 0 && (
                  <p className="empty">No evidence recorded.</p>
                )}
                <dl className="meta">
                  <div><dt>Domain</dt><dd>{domainById.get(task.domainId)?.name ?? '—'}</dd></div>
                  {task.templateId && (
                    <div><dt>Template</dt><dd>{templateById.get(task.templateId)?.title ?? task.templateId}</dd></div>
                  )}
                  {task.obligationId && (
                    <div><dt>Obligation</dt><dd>Due period {task.periodKey ?? '—'} (recurring schedule)</dd></div>
                  )}
                  {task.noticeId && (
                    <div><dt>Notice</dt><dd>
                      <TaskNoticeLink
                        noticeId={task.noticeId}
                        noticesReady={noticesReady}
                        noticesError={noticePanel.key === contextKey && (noticePanel.status === 'error' || noticePanel.error !== undefined)}
                        noticeTitle={noticeRows.find((n) => n.id === task.noticeId)?.title ?? null}
                        onOpen={(id) => {
                          setNoticeId(id);
                          const el = document.getElementById('notice-detail-heading');
                          el?.scrollIntoView({ block: 'start' });
                          el?.focus({ preventScroll: true });
                        }}
                        onRetry={retry}
                      />
                    </dd></div>
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
                    {taskLockNoteId && (
                      <p className="sod-note" id={taskLockNoteId}>
                        Verified records are locked.
                      </p>
                    )}
                    <StatusButtons
                      me={me}
                      task={task}
                      startBlockReason={startBlockReason(task)}
                      submitBlockReason={submitStatusReason(task) ?? submitBlockReason(task)}
                      verifyBlockReason={verifyStatusReason(task) ?? verifyBlockReason(me, task, privilegedIds) ?? verifyEvidenceReason(task)}
                      reopenBlockReason={reopenBlockReason(task)}
                      lockNoteId={taskLockNoteId ?? undefined}
                      onChange={(status: TaskStatus) => run(async () => api.patchTask(task.id, { status }))}
                    />
                    <h5 id="task-evidence-heading" tabIndex={-1} className="focus-target">Evidence & chain of custody ({task.evidence.length})</h5>
                    {task.evidence.length === 0 && <p className="empty">No evidence recorded.</p>}
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
                        describedBy={taskLockNoteId ?? undefined}
                      />
                    )}
                    {can(me, 'custody.transfer', task) && task.evidence.length > 0 && (
                      <TransferForm
                        evidence={task.evidence}
                        onTransfer={(evidenceId, toHolder, reason) =>
                          run(async () => api.transfer(task.id, { evidenceId, toHolder, reason }))
                        }
                        lockedTitle={evidenceLockedReason(task) ?? undefined}
                        describedBy={taskLockNoteId ?? undefined}
                      />
                    )}
                  </>
                ) : (
                  <p className="panel-error" role="alert">
                    Task actions unavailable while task data is loading or failed.
                  </p>
                )}
                <h5>Record history (append-only)</h5>
                {recordTrail.length === 0 && <p className="empty">No events for this record in the loaded history.</p>}
                <ol className="trail">
                  {recordTrail.map((e) => (
                    <li key={e.id} id={auditEventDomId('task', e.seq)} tabIndex={-1} className="focus-target">
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
            <h3>Report a concern (synthetic — identified, not anonymous)</h3>
          </div>
          <p className="notice">{CONCERN_IDENTIFIED_NOTICE}</p>
          <p className="notice">{CONCERN_REVIEWER_ACCESS_NOTICE}</p>
          <div className="panel-alert" role="note">
            <p>{CONCERN_EMERGENCY_NOTICE}</p>
          </div>
          {receipt ? (
            <ConcernReceipt concern={receipt} onDone={() => setConcernReceipt(null)} />
          ) : (
            <ConcernForm
              key={contextKey}
              disabled={!me || !orgId}
              onSubmit={(body) => {
                // R-1: bind the filing to its originating context
                // generation; the receipt/selection below must not revive
                // after a switch away and back.
                const gen = contextSeq.current;
                return run(async () => {
                  const created = await api.createConcern({ orgId, ...body });
                  if (contextOpObsolete(gen, contextSeq.current)) return;
                  setConcernReceipt({ key: contextKey, concern: created });
                  setMyConcernId(created.id);
                });
              }}
            />
          )}
        </section>

        <section className="columns">
          <div className="tasklist panel">
            <div className="panel-head">
              <h3 id="my-reports-heading" tabIndex={-1} className="focus-target">My reports</h3>
            </div>
            <p className="notice">{CONCERN_IDENTIFIED_NOTICE}</p>
            <PanelNotice panel={myConcerns} contextKey={contextKey} name="reports" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {myRows.map((c) => (
                  <tr key={c.id} className={c.id === myConcernId ? 'selected' : ''} onClick={() => { setNavNotice(null); setMyConcernId(c.id); }}>
                    <td className="task-title">{c.title.length > 60 ? `${c.title.slice(0, 60)}…` : c.title}</td>
                    <td>{CONCERN_CATEGORY_LABELS[c.category]}</td>
                    <td>
                      <span className="status">{CONCERN_STATUS_LABELS[c.status]}</span>
                    </td>
                  </tr>
                ))}
                {myRows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="empty">You have not filed any concerns in this organization yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="detail panel">
            {navNotice && navNotice.key === contextKey && myConcern && navNotice.recordId === myConcern.id && (
              <p className="notice" role="status">
                {navNotice.message} <button type="button" onClick={() => setNavNotice(null)}>Dismiss</button>
              </p>
            )}
            <div className="panel-head">
              <h3 id="my-concern-detail-heading" tabIndex={-1} className="focus-target">My report detail</h3>
            </div>
            {!myConcern && <p className="empty">Select one of your reports to follow its status and updates.</p>}
            {myConcern && me && (
              <ConcernDetail
                key={myConcern.id}
                viewId="mine"
                concern={myConcern}
                ready={myReady}
                triage={false}
                userName={userName}
                capas={capas}
                trail={myConcernTrail}
                assignees={[]}
              />
            )}
          </div>
        </section>

        {canTriageHere && (
          <section className="columns">
            <div className="tasklist panel">
              <div className="panel-head">
                <h3>Concern triage queue</h3>
              </div>
              <PanelNotice panel={concernQueue} contextKey={contextKey} name="concerns" orgName={org?.name ?? 'this organization'} onRetry={retry} />
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Reporter</th>
                    <th>Category</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {queueRows.map((c) => (
                    <tr key={c.id} className={c.id === concernId ? 'selected' : ''} onClick={() => setConcernId(c.id)}>
                      <td className="task-title">{c.title.length > 60 ? `${c.title.slice(0, 60)}…` : c.title}</td>
                      <td>{userName.get(c.reporterId) ?? '—'}</td>
                      <td>{CONCERN_CATEGORY_LABELS[c.category]}</td>
                      <td>
                        <span className="status">{CONCERN_STATUS_LABELS[c.status]}</span>
                      </td>
                    </tr>
                  ))}
                  {queueRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">No concerns for this organization yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="detail panel">
              <div className="panel-head">
                <h3>Concern triage detail</h3>
              </div>
              {!queueConcern && <p className="empty">Select a concern to acknowledge, assign, link, update, or close it.</p>}
              {queueConcern && me && (
                <ConcernDetail
                  key={queueConcern.id}
                  viewId="queue"
                  concern={queueConcern}
                  ready={queueReady}
                  triage
                  userName={userName}
                  capas={capas}
                  trail={queueConcernTrail}
                  assignees={triageUsersFor(users, orgId)}
                  onAdvance={(status, closingMessage) =>
                    run(async () =>
                      api.patchConcern(
                        queueConcern.id,
                        closingMessage !== undefined ? { status, closingMessage } : { status }
                      )
                    )
                  }
                  onAssign={(assigneeId) =>
                    run(async () => api.patchConcern(queueConcern.id, { assigneeId }))
                  }
                  onLink={(capaId) => run(async () => api.patchConcern(queueConcern.id, { capaId }))}
                  onUnlink={() => run(async () => api.patchConcern(queueConcern.id, { capaId: null }))}
                  onUpdate={(message) =>
                    run(async () => api.addConcernUpdate(queueConcern.id, { message }))
                  }
                  onNote={(text) => run(async () => api.addConcernNote(queueConcern.id, { text }))}
                />
              )}
            </div>
          </section>
        )}

        <section className="columns">
          <div className="tasklist panel">
            <div className="panel-head">
              <h3>Safety notices (synthetic — manually pasted, human reviewed)</h3>
              {canNoticeManage && (
                <div className="panel-actions">
                  <button
                    onClick={() => {
                      if (!showNoticeIntake) noticeIntakeSeq.current += 1;
                      setShowNoticeIntake((v) => !v);
                    }}
                    disabled={!noticesReady}
                  >
                    {showNoticeIntake ? 'Cancel intake' : 'Record notice'}
                  </button>
                </div>
              )}
            </div>
            <PanelNotice panel={noticePanel} contextKey={contextKey} name="notices" orgName={org?.name ?? 'this organization'} onRetry={retry} />
            {showNoticeIntake && canNoticeManage && me && (
              <NoticeIntakeForm
                key={noticeIntakeSeq.current}
                orgId={orgId}
                onSubmit={(n) => {
                  const formSeq = noticeIntakeSeq.current;
                  return run(async () => api.createNotice(n)).then((o) => {
                    if (shouldCloseFormOnCompletion(o, formSeq, noticeIntakeSeq.current)) {
                      setShowNoticeIntake(false);
                    }
                  });
                }}
                onCancel={() => setShowNoticeIntake(false)}
              />
            )}
            {noticesReady && noticeRows.length === 0 && (
              <p className="empty">No safety notices recorded in this organization yet.</p>
            )}
            {noticeRows.length > 0 && (
              <table>
                <thead>
                  <tr><th>Title</th><th>Source</th><th>Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {noticeRows.map((n) => (
                    <tr key={n.id} className={n.id === noticeId ? 'selected' : ''} onClick={() => setNoticeId(n.id)}>
                      <td><button type="button" className="notice-rowlink" onClick={() => setNoticeId(n.id)} aria-label={`Open notice ${n.title}`}>{n.title}</button></td>
                      <td>{n.source}</td>
                      <td>{n.noticeDate}</td>
                      <td>{NOTICE_STATUS_LABELS[n.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="detail panel">
            <div className="panel-head">
              <h3 id="notice-detail-heading" tabIndex={-1} className="focus-target">Notice detail</h3>
            </div>
            {!selectedNotice && <p className="empty">Select a notice to review its applicability or follow-up tasks.</p>}
            {selectedNotice && me && (
              <NoticeDetail
                key={selectedNotice.id}
                notice={selectedNotice}
                tasks={tasks}
                domains={domains}
                users={orgUsers}
                timeZone={org?.timeZone ?? 'UTC'}
                userName={userName}
                canManage={canNoticeManage}
                ready={noticesReady && tasksReady}
                onReview={(status, rationale) =>
                  run(async () => api.patchNotice(selectedNotice.id, { status, rationale }))
                }
                onFollowup={async (payload) => {
                  const box: { r: { task: ComplianceTask; duplicate: boolean } | null } = { r: null };
                  const outcome = await run(async () => {
                    box.r = await api.createNoticeFollowup(selectedNotice.id, payload);
                  });
                  if (outcome !== 'completed' || box.r === null) {
                    return { ok: false as const, duplicate: false, taskId: '' };
                  }
                  return { ok: true as const, duplicate: box.r.duplicate, taskId: box.r.task.id };
                }}
                onOpenTask={(id) => {
                  openTaskFromOutside(id);
                  const el = document.getElementById('task-detail-heading');
                  el?.scrollIntoView({ block: 'start' });
                  el?.focus({ preventScroll: true });
                }}
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
                        <button onClick={() => {
                          if (instantiateFor?.templateId === x.id) setInstantiateFor(null);
                          else {
                            instantiateFormSeq.current += 1;
                            setInstantiateFor({ key: contextKey, templateId: x.id });
                          }
                        }} disabled={!templatesReady}>
                          {instantiateFor?.templateId === x.id ? 'Cancel' : 'New task'}
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
          {instantiateTemplate && me && org && (
            <InstantiateForm
              template={instantiateTemplate}
              timeZone={org.timeZone}
              users={orgUsers}
              formKey={instantiateFormSeq.current}
              onSubmit={(ownerId, dueDate) => {
                // S-1/P-2: the navigation intent and context generation
                // are recorded at CLICK time.
                const key = contextKey;
                const gen = contextSeq.current;
                const clickSeq = ++creationSeq.current;
                const formSeq = instantiateFormSeq.current;
                setPendingCreatedTask(null);
                return run(async () => {
                  const created = await api.instantiate(instantiateTemplate.id, { ownerId, dueDate });
                  // P-2: obsolete context: touch nothing (run's own guard
                  // also skips its refresh for the stale generation).
                  if (contextOpObsolete(gen, contextSeq.current)) return;
                  // Same-context superseded: run's refresh still updates
                  // data, but no filter reset, selection, or error follows.
                  if (creationResponseSuperseded(clickSeq, creationSeq.current)) return;
                  // N-4: same pending treatment as Generate — previews
                  // close, the list resets to All, and the id waits for a
                  // load started after this response (bound captured first).
                  setHoverPreview(null);
                  setPinnedPreview(null);
                  setStatusFilter('all');
                  setPendingCreatedTask({ key, id: created.id, afterSeq: requestSeq.current });
                }).then((outcome) => {
                  // R-2: close only this form instance on its own success.
                  if (shouldCloseFormOnCompletion(outcome, formSeq, instantiateFormSeq.current)) {
                    setInstantiateFor(null);
                  }
                });
              }}
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

        {me && can(me, 'docaudit.run', { orgId, ownerId: '' }) && (
          <DocAuditPanel
            orgId={orgId}
            orgName={org?.name ?? 'this organization'}
            userId={userId}
            domains={domains}
            users={orgUsers}
            textA={docaTextA}
            textB={docaTextB}
            result={docaResult?.result ?? null}
            resultKey={docaResult ? `${docaResult.key}#${docaResult.seq}` : ''}
            busy={docaBusy}
            posting={docaPosting}
            pending={docaPending}
            completed={docaCompleted}
            panelError={docaError}
            onInput={setDocaInput}
            onSamples={() => {
              setDocaTextA(DOCAUDIT_SAMPLE_A);
              setDocaTextB(DOCAUDIT_SAMPLE_B);
              invalidateDocAuditResults();
            }}
            onCompare={() => {
              runCompare().catch(() => {});
            }}
            onCreate={(findingId, payload) => {
              sendFollowup(findingId, payload, false).catch(() => {});
            }}
            onRetry={retryFollowup}
            onDismissError={() => setDocaError('')}
          />
        )}
      </main>

      <footer>
        Sentinel MVP · simulated demo build · audit chain is hash-linked but not independently
        anchored — do not treat as legal evidence of compliance.
      </footer>
    </div>
  );
}

function ConcernForm({ disabled, onSubmit }: {
  disabled: boolean;
  onSubmit: (body: { title: string; category: ConcernCategory; description: string; location?: string }) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ConcernCategory>('safety');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const valid = title.trim() !== '' && description.trim() !== '';
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || disabled) return;
        onSubmit({
          title: title.trim(),
          category,
          description: description.trim(),
          ...(location.trim() ? { location: location.trim() } : {})
        });
        setTitle('');
        setDescription('');
        setLocation('');
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" aria-label="Short title" required maxLength={CONCERN_TITLE_MAX} disabled={disabled} />
      <select value={category} onChange={(e) => setCategory(e.target.value as ConcernCategory)} aria-label="Category" disabled={disabled}>
        {CONCERN_CATEGORIES.map((c) => (
          <option key={c} value={c}>{CONCERN_CATEGORY_LABELS[c]}</option>
        ))}
      </select>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" required maxLength={CONCERN_DESCRIPTION_MAX} disabled={disabled} rows={3} />
      <p className="notice">{CONCERN_NO_SENSITIVE_DETAILS_HINT}</p>
      <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" aria-label="Location (optional)" maxLength={CONCERN_LOCATION_MAX} disabled={disabled} />
      <button className="primary" type="submit" disabled={disabled || !valid}>Submit concern</button>
    </form>
  );
}

function ConcernReceipt({ concern, onDone }: { concern: ConcernRecord; onDone: () => void }): JSX.Element {
  return (
    <div>
      <p className="req-ok">
        Report received. Reference: <code>{concern.id}</code> · Status: {CONCERN_STATUS_LABELS[concern.status]}
      </p>
      <p className="notice">{CONCERN_IDENTIFIED_NOTICE}</p>
      <p className="notice">{CONCERN_REVIEWER_ACCESS_NOTICE}</p>
      <p className="notice">
        Follow its status in My reports below. This demo makes no response-time commitment.
      </p>
      <div className="panel-alert" role="note">
        <p>{CONCERN_EMERGENCY_NOTICE}</p>
      </div>
      <p>
        <button type="button" onClick={onDone}>File another concern</button>
      </p>
    </div>
  );
}

function ConcernDetail({ concern, ready, triage, userName, capas, trail, assignees, viewId, onAdvance, onAssign, onLink, onUnlink, onUpdate, onNote }: {
  concern: ConcernRecord;
  ready: boolean;
  triage: boolean;
  userName: Map<string, string>;
  capas: CapaRecord[];
  trail: AuditEvent[];
  assignees: DemoUser[];
  /** Which detail rendering this is; scopes focus-target ids so both views never share one. */
  viewId: ConcernDetailView;
  onAdvance?: (status: ConcernStatus, closingMessage?: string) => void;
  onAssign?: (assigneeId: string) => void;
  onLink?: (capaId: string) => void;
  onUnlink?: () => void;
  onUpdate?: (message: string) => void;
  onNote?: (text: string) => void;
}): JSX.Element {
  const next = nextConcernStatus(concern.status);
  // Internal notes render only in the triage view; the server also strips
  // them from every reporter-view response.
  const notes = triage ? concern.internalNotes : undefined;
  const [closingMessage, setClosingMessage] = useState('');
  const [assignee, setAssignee] = useState(concern.assigneeId ?? '');
  const [linkId, setLinkId] = useState('');
  const [updateText, setUpdateText] = useState('');
  const [noteText, setNoteText] = useState('');
  const showTriage = triage && ready;
  return (
    <>
      <h4>{concern.title}</h4>
      <p className="notice">{CONCERN_REVIEWER_ACCESS_NOTICE}</p>
      <p>
        <span className="status">{CONCERN_STATUS_LABELS[concern.status]}</span>{' '}
        {CONCERN_CATEGORY_LABELS[concern.category]} · reported by {userName.get(concern.reporterId) ?? concern.reporterId}
      </p>
      {concern.location && <p>Location: {concern.location}</p>}
      <p>{concern.description}</p>
      <p>Handler: {concern.assigneeId ? (userName.get(concern.assigneeId) ?? concern.assigneeId) : 'Unassigned'}</p>
      <p>Linked CAPA: {linkedCapaLine(concern)}</p>
      {concern.status === 'closed' && <p className="notice">{CONCERN_CLOSED_MEANING_NOTICE}</p>}
      <h5>Follow-up updates (visible to the reporter)</h5>
      {concern.updates.length === 0 && <p className="empty">No updates yet.</p>}
      <ol className="trail">
        {concern.updates.map((u) => (
          <li key={u.seq} id={concernUpdateDomId(viewId, u.seq)} tabIndex={-1} className="focus-target">
            {u.kind === 'closing' ? 'Closing explanation' : 'Update'} · {userName.get(u.byUserId) ?? u.byUserId} ·{' '}
            {new Date(u.at).toLocaleString()}
            <div className="trail-detail">{u.message}</div>
          </li>
        ))}
      </ol>
      {notes !== undefined && (
        <>
          <h5>Internal investigation notes (triage only)</h5>
          {notes.length === 0 && <p className="empty">No internal notes yet.</p>}
          <ol className="trail">
            {notes.map((n) => (
              <li key={n.seq}>
                {userName.get(n.byUserId) ?? n.byUserId} · {new Date(n.at).toLocaleString()}
                <div className="trail-detail">{n.text}</div>
              </li>
            ))}
          </ol>
        </>
      )}
      <h5>Status history</h5>
      <ol className="trail">
        {concern.statusHistory.map((s, i) => (
          <li key={`${s.status}-${i}`} id={concernStatusDomId(viewId, i)} tabIndex={-1} className="focus-target">
            {CONCERN_STATUS_LABELS[s.status]} · {userName.get(s.byUserId) ?? s.byUserId} ·{' '}
            {new Date(s.at).toLocaleString()}
          </li>
        ))}
      </ol>
      {concern.linkHistory.length > 0 && (
        <>
          <h5>CAPA link history</h5>
          <ol className="trail">
            {concern.linkHistory.map((l) => (
              <li key={l.seq}>
                {l.capaId ? `Linked ${shortDisplayId(l.capaId)}` : 'Unlinked'} · {userName.get(l.byUserId) ?? l.byUserId} ·{' '}
                {new Date(l.at).toLocaleString()}
              </li>
            ))}
          </ol>
        </>
      )}
      <h5>Record history (append-only)</h5>
      {trail.length === 0 && <p className="empty">No events for this record in the loaded history.</p>}
      <ol className="trail">
        {trail.map((e) => (
          <li key={e.id} id={auditEventDomId(viewId, e.seq)} tabIndex={-1} className="focus-target">
            <code>#{e.seq}</code> {e.action} · {userName.get(e.actorId) ?? e.actorId} ·{' '}
            {new Date(e.timestamp).toLocaleString()}
            <div className="trail-detail">{e.detail}</div>
          </li>
        ))}
      </ol>
      {triage && !ready && (
        <p className="panel-error" role="alert">
          Concern actions unavailable while concern data is loading or failed.
        </p>
      )}
      {showTriage && next !== null && onAdvance && (
        <>
          <h5>Advance workflow</h5>
          {next === 'closed' ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!closingMessage.trim()) return;
                onAdvance(next, closingMessage.trim());
                setClosingMessage('');
              }}
            >
              <p className="notice">{CONCERN_CLOSED_MEANING_NOTICE}</p>
              <textarea value={closingMessage} onChange={(e) => setClosingMessage(e.target.value)} placeholder="Closing explanation (seen by the reporter)" aria-label="Closing explanation" required maxLength={CONCERN_MESSAGE_MAX} rows={3} />
              <button className="primary" type="submit" disabled={!closingMessage.trim()}>Close with explanation</button>
            </form>
          ) : (
            <p>
              <button type="button" onClick={() => onAdvance(next)}>
                Move to {CONCERN_STATUS_LABELS[next]}
              </button>
            </p>
          )}
        </>
      )}
      {showTriage && concern.status !== 'closed' && (
        <>
          {onAssign && (
            <>
              <h5>Assign handler</h5>
              <form className="form inline" onSubmit={(e) => { e.preventDefault(); if (assignee) onAssign(assignee); }}>
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Handler">
                  <option value="">Select handler…</option>
                  {assignees.map((u) => (
                    <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
                  ))}
                </select>
                <button type="submit" disabled={!assignee || assignee === concern.assigneeId}>Assign</button>
              </form>
            </>
          )}
          {(onLink ?? onUnlink) && (
            <>
              <h5>Link to CAPA</h5>
              <form className="form inline" onSubmit={(e) => { e.preventDefault(); if (linkId && onLink) onLink(linkId); }}>
                <select value={linkId} onChange={(e) => setLinkId(e.target.value)} aria-label="CAPA to link">
                  <option value="">Select CAPA…</option>
                  {capas.map((c) => (
                    <option key={c.id} value={c.id}>{shortDisplayId(c.id)} ({CAPA_STATUS_LABELS[c.status]})</option>
                  ))}
                </select>
                <button type="submit" disabled={!linkId || !onLink}>Link</button>
                {concern.capaId && onUnlink && (
                  <button type="button" onClick={onUnlink}>Unlink</button>
                )}
              </form>
            </>
          )}
          {onUpdate && (
            <>
              <h5>Add reporter-visible update</h5>
              <form className="form" onSubmit={(e) => { e.preventDefault(); if (!updateText.trim()) return; onUpdate(updateText.trim()); setUpdateText(''); }}>
                <textarea value={updateText} onChange={(e) => setUpdateText(e.target.value)} placeholder="Update for the reporter" aria-label="Update for the reporter" required maxLength={CONCERN_MESSAGE_MAX} rows={2} />
                <button type="submit" disabled={!updateText.trim()}>Add update</button>
              </form>
            </>
          )}
          {onNote && (
            <>
              <h5>Add internal note (triage only)</h5>
              <form className="form" onSubmit={(e) => { e.preventDefault(); if (!noteText.trim()) return; onNote(noteText.trim()); setNoteText(''); }}>
                <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Internal investigation note" aria-label="Internal investigation note" required maxLength={CONCERN_MESSAGE_MAX} rows={2} />
                <button type="submit" disabled={!noteText.trim()}>Add note</button>
              </form>
            </>
          )}
        </>
      )}
      {showTriage && concern.status === 'closed' && (
        <p className="notice">Closed concerns are locked in this slice.</p>
      )}
    </>
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
      {trail.length === 0 && <p className="empty">No events for this record in the loaded history.</p>}
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

function StatusButtons({ me, task, startBlockReason, submitBlockReason, verifyBlockReason, reopenBlockReason, lockNoteId, onChange }: { me: DemoUser; task: ComplianceTask; startBlockReason: string | null; submitBlockReason: string | null; verifyBlockReason: string | null; reopenBlockReason: string | null; lockNoteId?: string; onChange: (s: TaskStatus) => void }): JSX.Element {
  // A button is enabled only when the role allows it AND no state reason
  // blocks it. The tooltip names the role gap first, else the state reason.
  // M-UI1: on verified tasks every button also references the visible lock
  // explanation via aria-describedby (lockNoteId is absent otherwise).
  const btn = (label: string, status: TaskStatus, action: Action, reason: string | null, need: string): JSX.Element => {
    const roleOk = can(me, action, task);
    const allowed = roleOk && reason === null;
    return (
      <button key={status} disabled={!allowed} title={allowed ? '' : (roleOk ? (reason ?? '') : `Requires: ${need}`)} aria-describedby={lockNoteId} onClick={() => onChange(status)}>
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

function NewTaskForm({ orgId, timeZone, domains, users, formKey, onSubmit }: { orgId: string; timeZone: string; domains: RegulatoryDomain[]; users: DemoUser[]; formKey: number; onSubmit: (t: NewTask) => Promise<unknown> }): JSX.Element {
  const [title, setTitle] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(orgToday(timeZone));
  // D-1: in-flight duplicate guard (not server idempotency). The ref check
  // runs synchronously at submit, before any rerender, so rapid clicks or
  // Enter cannot issue a second request for this form instance.
  const guardRef = useRef<SubmitGuard>({ inFlightFor: null });
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setDomainId(domains[0]?.id ?? '');
  }, [domains]);
  // O-1: keep a valid chosen owner across renders and refreshes; only an
  // id that left the list clears (to an explicit empty choice, below).
  useEffect(() => {
    setOwnerId((prev) => retainSelection(prev, users));
  }, [users]);
  // D-1: a newer form instance starts unguarded; any late completion for
  // the superseded instance cannot unlock or alter this one.
  useEffect(() => {
    guardRef.current.inFlightFor = null;
    setSubmitting(false);
  }, [formKey]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tryBeginSubmit(guardRef.current, formKey)) return;
        setSubmitting(true);
        // L-1: the title stays until confirmed success closes the form
        // (unmount clears) or the user cancels — a failed submission keeps
        // the draft. Settle restores availability only for the still-current
        // instance; success closes via the parent's R-2 completion check.
        const settle = (): void => {
          if (guardRef.current.inFlightFor !== formKey) return;
          endSubmit(guardRef.current, formKey);
          setSubmitting(false);
        };
        onSubmit({ orgId, domainId, title, ownerId, dueDate }).then(settle, settle);
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" required />
      <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Regulatory domain">
        {domains.map((d) => (
          <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
        ))}
      </select>
      <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner" required>
        {ownerId === '' && <option value="">Select an owner</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
        ))}
      </select>
      <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
      <button className="primary" type="submit" disabled={submitting}>{submitting ? 'Creating task…' : 'Create task'}</button>
    </form>
  );
}

function EvidenceForm({ onAdd, kinds, lockedTitle, describedBy }: { onAdd: (label: string, holder: string, kind?: string) => void; kinds?: Array<{ value: string; label: string }>; lockedTitle?: string; describedBy?: string }): JSX.Element {
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
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Evidence label" aria-label="Evidence label" required disabled={locked} title={lockedTitle} aria-describedby={describedBy} />
      <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Holder" aria-label="Holder" required disabled={locked} title={lockedTitle} aria-describedby={describedBy} />
      {kinds && (
        <select aria-label="Evidence kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={locked} title={lockedTitle} aria-describedby={describedBy}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      )}
      <button type="submit" disabled={locked} title={lockedTitle} aria-describedby={describedBy}>Add evidence</button>
    </form>
  );
}

function TransferForm({ evidence, onTransfer, lockedTitle, describedBy }: { evidence: ComplianceTask['evidence']; onTransfer: (id: string, holder: string, reason?: string) => void; lockedTitle?: string; describedBy?: string }): JSX.Element {
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
      <select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} aria-label="Evidence item" disabled={locked} title={lockedTitle} aria-describedby={describedBy}>
        {evidence.map((x) => (
          <option key={x.id} value={x.id}>{x.label} (now: {x.holder})</option>
        ))}
      </select>
      <input value={toHolder} onChange={(e) => setToHolder(e.target.value)} placeholder="Transfer to (new holder)" aria-label="Transfer to (new holder)" required disabled={locked} title={lockedTitle} aria-describedby={describedBy} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason (optional)" disabled={locked} title={lockedTitle} aria-describedby={describedBy} />
      <button type="submit" disabled={locked} title={lockedTitle} aria-describedby={describedBy}>Transfer custody</button>
    </form>
  );
}

function InstantiateForm({ template, timeZone, users, formKey, onSubmit }: { template: TaskTemplate; timeZone: string; users: DemoUser[]; formKey: number; onSubmit: (ownerId: string, dueDate: string) => Promise<unknown> }): JSX.Element {
  const defaultDue =
    nextDueDate(orgToday(timeZone), template.recurrence.frequency) ??
    (addDaysISO(orgToday(timeZone), 30) ?? orgToday(timeZone));
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(defaultDue);
  // D-1: in-flight duplicate guard (not server idempotency). The ref check
  // runs synchronously at submit, before any rerender, so rapid clicks or
  // Enter cannot issue a second request for this form instance.
  const guardRef = useRef<SubmitGuard>({ inFlightFor: null });
  const [submitting, setSubmitting] = useState(false);
  // O-1: keep a valid chosen owner across renders and refreshes; only an
  // id that left the list clears (to an explicit empty choice, below).
  useEffect(() => {
    setOwnerId((prev) => retainSelection(prev, users));
  }, [users]);
  // R-3: re-init the due date only when the template or zone identity
  // changes — never on object identity (refreshes) — so edited drafts
  // survive reloads. Fresh instances mount fresh via initial state.
  useEffect(() => {
    setDueDate(
      nextDueDate(orgToday(timeZone), template.recurrence.frequency) ??
        (addDaysISO(orgToday(timeZone), 30) ?? orgToday(timeZone))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- template object
    // identity must NOT reset the draft; template.id carries the reset.
  }, [template.id, timeZone]);
  // D-1: a newer form instance starts unguarded; any late completion for
  // the superseded instance cannot unlock or alter this one.
  useEffect(() => {
    guardRef.current.inFlightFor = null;
    setSubmitting(false);
  }, [formKey]);
  return (
    <form
      className="form inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tryBeginSubmit(guardRef.current, formKey)) return;
        setSubmitting(true);
        // Settle restores availability only for the still-current instance,
        // keeping the draft on failure; success closes via the parent's
        // R-2 completion check.
        const settle = (): void => {
          if (guardRef.current.inFlightFor !== formKey) return;
          endSubmit(guardRef.current, formKey);
          setSubmitting(false);
        };
        onSubmit(ownerId, dueDate).then(settle, settle);
      }}
    >
      <span className="task-title">New task from “{template.title}”</span>
      <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner" required>
        {ownerId === '' && <option value="">Select an owner</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
        ))}
      </select>
      <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
      <button className="primary" type="submit" disabled={submitting}>{submitting ? 'Creating task…' : 'Create task'}</button>
    </form>
  );
}

/**
 * N-5: the task-to-notice link is honest about every backing state. Only
 * a notice found in the current context's server-scoped rows is named
 * and opened; loading, failure, and missing targets say so instead of
 * landing on an unexplained prompt. Retry re-runs the normal refresh.
 */
function TaskNoticeLink({ noticeId, noticesReady, noticesError, noticeTitle, onOpen, onRetry }: {
  noticeId: string;
  noticesReady: boolean;
  noticesError: boolean;
  noticeTitle: string | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
}): JSX.Element {
  if (!noticesReady) {
    if (noticesError) {
      return (
        <span>Safety notice (couldn't load notices) <button type="button" onClick={onRetry}>Retry</button></span>
      );
    }
    return <span>Safety notice (loading…)</span>;
  }
  if (noticeTitle === null) {
    return (
      <span>Safety notice (unavailable) <button type="button" onClick={onRetry}>Retry</button></span>
    );
  }
  return <button type="button" onClick={() => onOpen(noticeId)}>{noticeTitle}</button>;
}

function NoticeIntakeForm({ orgId, onSubmit, onCancel }: { orgId: string; onSubmit: (n: NewNotice) => Promise<unknown>; onCancel: () => void }): JSX.Element {
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [noticeDate, setNoticeDate] = useState('');
  const [text, setText] = useState('');
  // D-1 style: synchronous in-flight guard plus pending UI. Success closes
  // (unmount); failure restores with the draft intact.
  const guardRef = useRef<SubmitGuard>({ inFlightFor: null });
  const [submitting, setSubmitting] = useState(false);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tryBeginSubmit(guardRef.current, 1)) return;
        setSubmitting(true);
        const settle = (): void => {
          if (guardRef.current.inFlightFor !== 1) return;
          endSubmit(guardRef.current, 1);
          setSubmitting(false);
        };
        onSubmit({ orgId, source, title, noticeDate, text }).then(settle, settle);
      }}
    >
      <p className="empty">{NOTICE_SYNTHETIC_NOTICE}</p>
      <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source label" aria-label="Source label" maxLength={NOTICE_SOURCE_MAX} required />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Notice title" aria-label="Notice title" maxLength={NOTICE_TITLE_MAX} required />
      <input type="date" value={noticeDate} onChange={(e) => setNoticeDate(e.target.value)} aria-label="Notice date" required />
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Pasted notice text (synthetic only)" aria-label="Notice text" rows={4} maxLength={NOTICE_TEXT_MAX} required />
      <div className="panel-actions">
        <button className="primary" type="submit" disabled={submitting}>{submitting ? 'Recording…' : 'Record notice'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function NoticeFollowupForm({ orgId, noticeId, timeZone, domains, users, onSubmit, onCreated }: {
  orgId: string;
  noticeId: string;
  timeZone: string;
  domains: RegulatoryDomain[];
  users: DemoUser[];
  onSubmit: (payload: NoticeFollowupPayload) => Promise<{ ok: boolean; duplicate: boolean; taskId: string; seq: number }>;
  onCreated: (info: { taskId: string; title: string; duplicate: boolean }, submitSeq: number) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(orgToday(timeZone));
  const [preview, setPreview] = useState<{ payload: NoticeFollowupPayload; key: string } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const guardRef = useRef<SubmitGuard>({ inFlightFor: null });
  const [submitting, setSubmitting] = useState(false);
  // N-1: the first domain fills an empty choice exactly once (the initial
  // list completing). Afterwards a valid choice survives every refresh —
  // only an id that left the list clears, never an identity change.
  const domainInit = useRef(domains.length > 0);
  useEffect(() => {
    if (domains.length === 0) return;
    if (!domainInit.current) {
      domainInit.current = true;
      setDomainId(domains[0].id);
      return;
    }
    setDomainId((prev) => retainSelection(prev, domains));
  }, [domains]);
  // O-1: keep a valid chosen owner across renders; only an id that left
  // the list clears (the confirm then requires a pick).
  useEffect(() => {
    setOwnerId((prev) => retainSelection(prev, users));
  }, [users]);
  // Any draft edit closes the preview so confirmation always matches it.
  const touch = (): void => setPreview(null);
  // A select reset to '' (its id left the list) also invalidates the
  // preview: confirmation must be rebuilt, never silently substituted.
  const prevSelects = useRef({ domainId, ownerId });
  useEffect(() => {
    const prev = prevSelects.current;
    if ((prev.domainId !== '' && domainId === '') || (prev.ownerId !== '' && ownerId === '')) {
      setPreview(null);
    }
    prevSelects.current = { domainId, ownerId };
  }, [domainId, ownerId]);
  // N-1: the preview renders the exact frozen payload that Confirm sends
  // (names looked up by the payload ids), including notice and key.
  const previewDomain = preview === null ? undefined : domains.find((d) => d.id === preview.payload.domainId);
  const previewOwner = preview === null ? undefined : users.find((u) => u.id === preview.payload.ownerId);
  const openPreview = (): void => {
    if (!title.trim() || !domainId || !ownerId || !isValidIsoDate(dueDate)) {
      setPreviewError('Title, domain, owner, and a real calendar due date are required.');
      setPreview(null);
      return;
    }
    setPreviewError('');
    // One key per preview: a retry after failure reuses it, so the server
    // answers with the original task instead of a duplicate.
    setPreview({
      payload: { idempotencyKey: '', orgId, domainId, title: title.trim(), ownerId, dueDate },
      key: crypto.randomUUID()
    });
  };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (preview === null) {
          openPreview();
          return;
        }
        if (!tryBeginSubmit(guardRef.current, 1)) return;
        setSubmitting(true);
        const payload: NoticeFollowupPayload = { ...preview.payload, idempotencyKey: preview.key };
        const settle = (ok: boolean, duplicate: boolean, taskId: string, submitSeq: number): void => {
          if (guardRef.current.inFlightFor !== 1) return;
          endSubmit(guardRef.current, 1);
          setSubmitting(false);
          // Success remounts this form (parent instance key): the next
          // follow-up starts with a fresh guard and empty draft. The seq
          // lets the parent ignore completions for older instances (N-3).
          if (ok) onCreated({ taskId, title: payload.title, duplicate }, submitSeq);
        };
        onSubmit(payload).then(
          (r) => settle(r.ok, r.duplicate, r.taskId, r.seq),
          () => settle(false, false, '', -1)
        );
      }}
    >
      <input value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} placeholder="Follow-up task title" aria-label="Follow-up task title" maxLength={200} required />
      <select value={domainId} onChange={(e) => { setDomainId(e.target.value); touch(); }} aria-label="Regulatory domain" required>
        {domainId === '' && <option value="">Select a domain</option>}
        {domains.map((d) => (
          <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
        ))}
      </select>
      {domainId === '' && domains.length > 0 && (
        <p className="panel-error" role="alert">The selected domain is no longer available — choose a domain before confirming.</p>
      )}
      <select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); touch(); }} aria-label="Owner" required>
        {ownerId === '' && <option value="">Select an owner</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
        ))}
      </select>
      {ownerId === '' && users.length > 0 && (
        <p className="panel-error" role="alert">The selected owner is no longer available — choose an owner before confirming.</p>
      )}
      <input type="date" value={dueDate} onChange={(e) => { setDueDate(e.target.value); touch(); }} aria-label="Due date" required />
      {previewError !== '' && <p className="panel-error" role="alert">{previewError}</p>}
      {preview !== null && (
        <dl className="meta">
          <div><dt>Title</dt><dd>{preview.payload.title}</dd></div>
          <div><dt>Domain</dt><dd>{previewDomain ? `${previewDomain.code} — ${previewDomain.name}` : preview.payload.domainId}</dd></div>
          <div><dt>Owner</dt><dd>{previewOwner ? `${previewOwner.name} (${ROLE_LABELS[previewOwner.role]})` : preview.payload.ownerId}</dd></div>
          <div><dt>Due</dt><dd>{preview.payload.dueDate}</dd></div>
          <div><dt>Notice</dt><dd>{noticeId}</dd></div>
          <div><dt>Key</dt><dd>{preview.key}</dd></div>
        </dl>
      )}
      <button className="primary" type="submit" disabled={submitting}>
        {submitting ? 'Creating task…' : preview === null ? 'Preview follow-up' : 'Confirm follow-up'}
      </button>
    </form>
  );
}

function NoticeDetail({ notice, tasks, domains, users, timeZone, userName, canManage, ready, onReview, onFollowup, onOpenTask }: {
  notice: NoticeRecord;
  tasks: ComplianceTask[];
  domains: RegulatoryDomain[];
  users: DemoUser[];
  timeZone: string;
  userName: Map<string, string>;
  canManage: boolean;
  ready: boolean;
  onReview: (status: 'applicable' | 'not_applicable', rationale: string) => Promise<unknown>;
  onFollowup: (payload: NoticeFollowupPayload) => Promise<{ ok: boolean; duplicate: boolean; taskId: string }>;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  // The notice's task list derives from the authoritative task.noticeId
  // link — no duplicate arrays are maintained.
  const linked = tasks.filter((t) => t.noticeId === notice.id);
  const [decision, setDecision] = useState<'' | 'applicable' | 'not_applicable'>('');
  const [rationale, setRationale] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [showFollowup, setShowFollowup] = useState(false);
  // N-3: every follow-up form opening is a distinct instance. Completions
  // carry the submit-time key; only the current instance may show its
  // note or remount, so a late completion can never wipe a newer draft.
  const [followupKey, setFollowupKey] = useState(0);
  const followupKeyRef = useRef(0);
  const [createdNote, setCreatedNote] = useState<{ taskId: string; title: string; duplicate: boolean } | null>(null);
  const reviewGuardRef = useRef<SubmitGuard>({ inFlightFor: null });
  const decided = notice.status !== 'needs_review';
  const reviewReady = decision !== '' && rationale.trim() !== '' && ready && !reviewing;
  return (
    <>
      <h4>{notice.title}</h4>
      <dl className="meta">
        <div><dt>Source</dt><dd>{notice.source}</dd></div>
        <div><dt>Notice date</dt><dd>{notice.noticeDate}</dd></div>
        <div><dt>Status</dt><dd>{NOTICE_STATUS_LABELS[notice.status]}</dd></div>
        <div><dt>Recorded by</dt><dd>{userName.get(notice.createdBy) ?? notice.createdBy}</dd></div>
        {decided && (
          <div><dt>Reviewed by</dt><dd>{userName.get(notice.reviewedBy ?? '') ?? notice.reviewedBy}{notice.reviewedAt ? ` · ${new Date(notice.reviewedAt).toLocaleString()}` : ''}</dd></div>
        )}
      </dl>
      <blockquote className="doca-quote notice-text">{notice.text}</blockquote>
      {decided && notice.rationale !== undefined && (
        <>
          <h5>Review rationale</h5>
          <p>{notice.rationale}</p>
        </>
      )}
      {!decided && canManage && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (decision === '' || rationale.trim() === '') return;
            if (!tryBeginSubmit(reviewGuardRef.current, 1)) return;
            setReviewing(true);
            const settle = (): void => {
              if (reviewGuardRef.current.inFlightFor !== 1) return;
              endSubmit(reviewGuardRef.current, 1);
              setReviewing(false);
            };
            onReview(decision, rationale.trim()).then(settle, settle);
          }}
        >
          <p className="empty">{NOTICE_FINALITY_NOTICE}</p>
          <fieldset>
            <legend>Applicability decision (final)</legend>
            <label className="doca-option">
              <input type="radio" name={`notice-decision-${notice.id}`} checked={decision === 'applicable'} disabled={!ready} onChange={() => setDecision('applicable')} />
              <span>Applicable</span>
            </label>
            <label className="doca-option">
              <input type="radio" name={`notice-decision-${notice.id}`} checked={decision === 'not_applicable'} disabled={!ready} onChange={() => setDecision('not_applicable')} />
              <span>Not applicable</span>
            </label>
          </fieldset>
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (required for either decision)" aria-label="Review rationale" rows={3} maxLength={NOTICE_RATIONALE_MAX} required />
          <button className="primary" type="submit" disabled={!reviewReady}>{reviewing ? 'Recording…' : 'Record final decision'}</button>
        </form>
      )}
      {notice.status === 'applicable' && (
        <>
          <p className="empty">{NOTICE_APPLICABLE_MEANING_NOTICE}</p>
          <h5>Linked follow-up tasks ({linked.length})</h5>
          {linked.length === 0 && <p className="empty">No follow-up tasks yet.</p>}
          {linked.length > 0 && (
            <ul>
              {linked.map((t) => (
                <li key={t.id}>
                  <button onClick={() => onOpenTask(t.id)}>{t.title}</button>
                  {' — '}{STATUS_LABELS[t.status]}
                </li>
              ))}
            </ul>
          )}
          {createdNote !== null && (
            <p role="status">
              Follow-up task created: {createdNote.title} (<code>{createdNote.taskId.slice(0, 8)}</code>)
              {createdNote.duplicate ? ' — this retry reused the original task.' : '.'}
            </p>
          )}
          {canManage && (
            <div className="panel-actions">
              <button
                onClick={() => {
                  if (!showFollowup) {
                    followupKeyRef.current += 1;
                    setFollowupKey(followupKeyRef.current);
                  }
                  setShowFollowup((v) => !v);
                }}
                disabled={!ready}
              >
                {showFollowup ? 'Cancel follow-up' : 'New follow-up task'}
              </button>
            </div>
          )}
          {showFollowup && canManage && (
            <NoticeFollowupForm
              key={followupKey}
              orgId={notice.orgId}
              noticeId={notice.id}
              timeZone={timeZone}
              domains={domains}
              users={users}
              onSubmit={async (payload) => {
                const submitSeq = followupKeyRef.current;
                const r = await onFollowup(payload);
                return { ...r, seq: submitSeq };
              }}
              onCreated={(info, submitSeq) => {
                if (submitSeq !== followupKeyRef.current) return;
                setCreatedNote(info);
                followupKeyRef.current += 1;
                setFollowupKey(followupKeyRef.current);
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function DocAuditPanel({ orgId, orgName, userId, domains, users, textA, textB, result, resultKey, busy, posting, pending, completed, panelError, onInput, onSamples, onCompare, onCreate, onRetry, onDismissError }: {
  orgId: string;
  orgName: string;
  userId: string;
  domains: RegulatoryDomain[];
  users: DemoUser[];
  textA: string;
  textB: string;
  result: DocAuditCompareResult | null;
  /** Changes on every context switch and comparison, remounting finding cards. */
  resultKey: string;
  busy: boolean;
  posting: boolean;
  pending: { findingId: string; payload: DocAuditFollowupPayload; busy: boolean } | null;
  completed: Record<string, { taskId: string; title: string; duplicate: boolean }>;
  panelError: string;
  onInput: (side: 'A' | 'B', value: string) => void;
  onSamples: () => void;
  onCompare: () => void;
  onCreate: (findingId: string, payload: DocAuditFollowupPayload) => void;
  onRetry: () => void;
  onDismissError: () => void;
}): JSX.Element {
  // An unresolved attempt locks the whole review workflow: no edits, no new
  // comparisons, no replacement creates — only retrying the preserved
  // payload with its preserved key.
  const locked = pending !== null || posting;
  const canCompare = !busy && !locked && textA.trim().length > 0 && textB.trim().length > 0;
  return (
    <section className="panel" aria-label="Document audit">
      <div className="panel-head">
        <h3>Document audit (Working Memory — synthetic review only)</h3>
      </div>
      <p className="empty">
        Compare two pasted texts, accept or dismiss the suggested findings, and optionally create one
        follow-up task per finding. Comparisons never store your texts; paste synthetic text only.
      </p>
      <div className="doca-grid">
        <div>
          <label htmlFor="doca-text-a">Source text A (synthetic only)</label>
          <textarea
            id="doca-text-a"
            value={textA}
            maxLength={DOCAUDIT_TEXT_MAX}
            rows={6}
            disabled={locked}
            onChange={(e) => onInput('A', e.target.value)}
          />
          <p className="doca-count">{textA.length} / {DOCAUDIT_TEXT_MAX} characters</p>
        </div>
        <div>
          <label htmlFor="doca-text-b">Source text B (synthetic only)</label>
          <textarea
            id="doca-text-b"
            value={textB}
            maxLength={DOCAUDIT_TEXT_MAX}
            rows={6}
            disabled={locked}
            onChange={(e) => onInput('B', e.target.value)}
          />
          <p className="doca-count">{textB.length} / {DOCAUDIT_TEXT_MAX} characters</p>
        </div>
      </div>
      <div className="panel-actions">
        <button onClick={onSamples} disabled={locked}>Load synthetic sample texts</button>
        <button className="primary" onClick={onCompare} disabled={!canCompare}>
          {busy ? 'Comparing…' : 'Compare texts'}
        </button>
      </div>
      {pending && (
        <div className="doca-pending" role="alert">
          <p>
            Follow-up for finding {pending.findingId} has an unknown outcome — the task may or may not
            have been created. Retry uses the preserved payload and key <code>{pending.payload.idempotencyKey}</code>.
          </p>
          <button className="primary" onClick={onRetry} disabled={pending.busy}>
            {pending.busy ? 'Retrying…' : 'Retry follow-up task'}
          </button>
        </div>
      )}
      {!pending && panelError && (
        <div className="panel-alert" role="alert">
          <p>{panelError}</p>
          <button onClick={onDismissError} aria-label="Dismiss document audit error">Dismiss</button>
        </div>
      )}
      {result && (
        <div className="doca-results">
          {result.notice && (
            <div className="doca-notice" role="note">
              <strong>{result.notice}</strong>
              <p>Provider: {result.provider} · Comparison {result.runId}</p>
            </div>
          )}
          <p>
            {result.findings.length === 0
              ? 'No differences found.'
              : `${result.findings.length} suggested finding${result.findings.length === 1 ? '' : 's'} — accepting or dismissing changes nothing until you create a follow-up task.`}
          </p>
          {result.findings.map((finding) => (
            <DocAuditFindingCard
              key={`${userId}|${orgId}|${resultKey}|${finding.id}`}
              finding={finding}
              missingLabel={result.missingLabel}
              disabled={locked}
              completed={completed[finding.id]}
              orgId={orgId}
              orgName={orgName}
              domains={domains}
              users={users}
              textA={textA}
              textB={textB}
              onCreate={onCreate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DocAuditFindingCard({ finding, missingLabel, disabled, completed, orgId, orgName, domains, users, textA, textB, onCreate }: {
  finding: DocAuditFinding;
  missingLabel: string;
  disabled: boolean;
  completed: { taskId: string; title: string; duplicate: boolean } | undefined;
  orgId: string;
  orgName: string;
  domains: RegulatoryDomain[];
  users: DemoUser[];
  textA: string;
  textB: string;
  onCreate: (findingId: string, payload: DocAuditFollowupPayload) => void;
}): JSX.Element {
  const [verdict, setVerdict] = useState<DocAuditVerdict | undefined>(undefined);
  // Unambiguous passages resolve to their only location; repeated passages
  // require an explicit reviewer choice (never preselected).
  const [selectionA, setSelectionA] = useState<number | undefined>(
    finding.passageA && finding.passageA.totalOccurrences === 1 ? 0 : undefined
  );
  const [selectionB, setSelectionB] = useState<number | undefined>(
    finding.passageB && finding.passageB.totalOccurrences === 1 ? 0 : undefined
  );
  const [summary, setSummary] = useState(finding.summary);
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState(users[0]?.id ?? '');
  const [dueDate, setDueDate] = useState('');
  const [preview, setPreview] = useState<{ content: Omit<DocAuditFollowupPayload, 'idempotencyKey'>; contentJson: string; rows: FollowupPreviewRow[]; key: string } | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const bindingRef = useRef<FollowupKeyBinding | null>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setDomainId(domains[0]?.id ?? '');
  }, [domains]);
  // O-1: keep a valid chosen owner across renders and refreshes; only an
  // id that left the list clears (preview validation then requires a pick).
  useEffect(() => {
    setOwnerId((prev) => retainSelection(prev, users));
  }, [users]);
  useEffect(() => {
    if (preview) previewHeadingRef.current?.focus();
  }, [preview]);
  // Any draft edit closes the preview so creation always confirms the shown payload.
  const touch = (): void => setPreview(null);
  const blockers = findingBlockers({ verdict, finding, selectionA, selectionB, completed: completed !== undefined });
  const domainName = domains.find((d) => d.id === domainId);
  const ownerName = users.find((u) => u.id === ownerId);

  const openPreview = (): void => {
    const gate = findingBlockers({ verdict, finding, selectionA, selectionB, completed: completed !== undefined });
    if (gate.length > 0) {
      setPreviewErrors(gate);
      setPreview(null);
      return;
    }
    const built = buildFollowupPreview({
      orgId,
      orgName,
      domainId,
      domainName: domainName ? `${domainName.code} — ${domainName.name}` : domainId,
      title,
      ownerId,
      ownerName: ownerName ? `${ownerName.name} (${ROLE_LABELS[ownerName.role]})` : ownerId,
      dueDate,
      finding,
      summary,
      selectionA,
      selectionB,
      textA,
      textB
    });
    if (!built.ok) {
      setPreviewErrors(built.errors);
      setPreview(null);
      return;
    }
    const key = resolveFollowupKey(built.contentJson, bindingRef.current) ?? crypto.randomUUID();
    bindingRef.current = { contentJson: built.contentJson, key };
    setPreviewErrors([]);
    setPreview({ content: built.content, contentJson: built.contentJson, rows: built.rows, key });
  };

  const renderPassage = (side: 'A' | 'B', passage: DocAuditFinding['passageA']): JSX.Element | null => {
    if (!passage) return <p className="empty">{missingLabel} (source text {side}).</p>;
    const selected = side === 'A' ? selectionA : selectionB;
    const setSelected = side === 'A' ? setSelectionA : setSelectionB;
    return (
      <div className="doca-passage">
        <blockquote className="doca-quote">{passage.text}</blockquote>
        <p>
          {passage.totalOccurrences === 1
            ? `Only location in source text ${side}: characters ${passage.occurrences[0]?.start ?? 0}–${passage.occurrences[0]?.end ?? 0}.`
            : `${passage.totalOccurrences} locations in source text ${side} — choose one.`}
        </p>
        {occurrencesTruncated(passage) && (
          <p className="empty">Showing the first {passage.occurrences.length} of {passage.totalOccurrences}; narrow the quotation to see more.</p>
        )}
        {passage.totalOccurrences > 1 && (
          <fieldset>
            <legend>Location for source text {side} passage</legend>
            {passage.occurrences.map((o, i) => (
              <label key={o.start} className="doca-option">
                <input
                  type="radio"
                  name={`doca-${finding.id}-${side}`}
                  checked={selected === i}
                  disabled={disabled}
                  onChange={() => {
                    setSelected(i);
                    touch();
                  }}
                />
                <span>
                  <strong>{occurrenceLabel(i, passage.totalOccurrences, o.start, o.end)}</strong>
                  <br />
                  <span className="doca-context">…{o.contextBefore}<mark>{passage.text}</mark>{o.contextAfter}…</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    );
  };

  return (
    <article className="doca-finding" aria-label={`Finding ${finding.id}`}>
      <h4>Finding {finding.id} — {findingKindLabel(finding.kind)}</h4>
      {completed ? (
        <p className="doca-created" role="status">
          Follow-up task created: {completed.title} (<code>{completed.taskId.slice(0, 8)}</code>)
          {completed.duplicate ? ' — this retry reused the original task.' : '.'}
        </p>
      ) : (
        <div className="panel-actions" role="group" aria-label={`Decision for finding ${finding.id}`}>
          <button onClick={() => { setVerdict('accepted'); touch(); }} disabled={disabled} aria-pressed={verdict === 'accepted'}>
            {verdict === 'accepted' ? 'Accepted' : `Accept finding ${finding.id}`}
          </button>
          <button onClick={() => { setVerdict('dismissed'); touch(); }} disabled={disabled} aria-pressed={verdict === 'dismissed'}>
            {verdict === 'dismissed' ? 'Dismissed' : `Dismiss finding ${finding.id}`}
          </button>
        </div>
      )}
      <div>
        <label htmlFor={`doca-summary-${finding.id}`}>Finding {finding.id} summary (reviewer-confirmed)</label>
        <textarea
          id={`doca-summary-${finding.id}`}
          value={summary}
          maxLength={DOCAUDIT_SUMMARY_MAX}
          rows={2}
          disabled={disabled || completed !== undefined}
          onChange={(e) => {
            setSummary(e.target.value);
            touch();
          }}
        />
        <p className="doca-count">{summary.length} / {DOCAUDIT_SUMMARY_MAX} characters</p>
      </div>
      {renderPassage('A', finding.passageA)}
      {renderPassage('B', finding.passageB)}
      {!completed && (
        <div className="form">
          <input
            value={title}
            maxLength={DOCAUDIT_TASK_TITLE_MAX}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
            placeholder="Follow-up task title"
            aria-label={`Follow-up task title for finding ${finding.id}`}
            disabled={disabled}
          />
          <select
            value={domainId}
            onChange={(e) => {
              setDomainId(e.target.value);
              touch();
            }}
            aria-label={`Regulatory domain for finding ${finding.id}`}
            disabled={disabled}
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
            ))}
          </select>
          <select
            value={ownerId}
            onChange={(e) => {
              setOwnerId(e.target.value);
              touch();
            }}
            aria-label={`Owner for finding ${finding.id}`}
            disabled={disabled}
            required
          >
            {ownerId === '' && <option value="">Select an owner</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({ROLE_LABELS[u.role]})</option>
            ))}
          </select>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value);
              touch();
            }}
            aria-label={`Due date for finding ${finding.id} (required)`}
            disabled={disabled}
          />
          <button onClick={openPreview} disabled={disabled || blockers.length > 0} title={blockers[0] ?? ''}>
            Review follow-up task for finding {finding.id}
          </button>
          {blockers.length > 0 && verdict !== undefined && <p className="empty">{blockers[0]}</p>}
        </div>
      )}
      {previewErrors.length > 0 && (
        <ul className="doca-errors" role="alert">
          {previewErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {preview && !completed && (
        <section className="doca-preview" aria-label={`Save preview for finding ${finding.id}`}>
          <h5 ref={previewHeadingRef} tabIndex={-1}>Save preview — finding {finding.id}</h5>
          <p>This creates one task with exactly the following saved content.</p>
          <dl className="meta">
            {preview.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <p><strong>{FOLLOWUP_EVIDENCE_NOTE}</strong></p>
          <p className="empty">Retry key: <code>{preview.key}</code> — identical retries reuse this key.</p>
          <div className="panel-actions">
            <button
              className="primary"
              disabled={disabled}
              onClick={() => onCreate(finding.id, { ...preview.content, idempotencyKey: preview.key })}
            >
              Create follow-up task
            </button>
            <button onClick={() => setPreview(null)} disabled={disabled}>Back to review</button>
          </div>
        </section>
      )}
    </article>
  );
}
