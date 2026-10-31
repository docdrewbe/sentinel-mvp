// Survey/OCM inspection packet panel: request one standard/control, one
// task record, or one whole domain, then display and print that same
// read-only snapshot. Simulated demo data only.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { shouldApplySurveyResponse } from './dashboard.js';
import {
  STATUS_LABELS,
  type ComplianceTask,
  type OrgKind,
  type RegulatoryDomain,
  type TaskTemplate
} from '../shared/types.js';
import {
  SURVEY_EMPTY_DOMAIN,
  SURVEY_EMPTY_TEMPLATE,
  SURVEY_EVIDENCE_NOTE,
  SURVEY_INTEGRITY_NOTE,
  surveyPacketTitle,
  type SurveyPacket
} from '../shared/survey.js';

/** Resolved demo-user name with the id kept for traceability; raw id fallback. */
function actorLabel(packet: SurveyPacket, id: string): string {
  const name = packet.actors[id];
  return name !== undefined && name !== id ? `${name} (${id})` : id;
}

function scopeKindLabel(packet: SurveyPacket): string {
  return packet.scope.kind === 'template'
    ? 'Standard/control'
    : packet.scope.kind === 'domain'
      ? 'Whole domain'
      : 'Task record';
}

export function SurveyPacketPanel({
  orgId,
  orgKind,
  orgName,
  contextKey,
  domains,
  templates,
  tasks,
  ready
}: {
  orgId: string;
  orgKind?: OrgKind;
  orgName: string;
  contextKey: string;
  domains: RegulatoryDomain[];
  templates: TaskTemplate[];
  tasks: ComplianceTask[];
  ready: boolean;
}): JSX.Element {
  const [selection, setSelection] = useState('');
  const [packet, setPacket] = useState<SurveyPacket | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const keyRef = useRef(contextKey);
  keyRef.current = contextKey;

  // User/org switches invalidate everything from the previous context.
  useEffect(() => {
    sequence.current += 1;
    setSelection('');
    setPacket(null);
    setError('');
    setBusy(false);
  }, [contextKey]);

  // Linked tasks are covered by their template packet; the single-task scope
  // exists for unlinked records (the server still serves any same-org task).
  const choices = [
    ...templates.map((t) => ({ value: `template:${t.id}`, label: `Standard/control: ${t.title}` })),
    ...tasks
      .filter((t) => !t.templateId)
      .map((t) => ({ value: `task:${t.id}`, label: `Task record: ${t.title}` })),
    ...domains.map((d) => ({ value: `domain:${d.id}`, label: `Whole domain: ${d.code} — ${d.name}` }))
  ];
  const valid = choices.some((c) => c.value === selection);
  // The packet shows only for the currently selected, currently loaded scope.
  const shown = packet !== null && valid && ready ? packet : null;

  async function load(): Promise<void> {
    const colon = selection.indexOf(':');
    if (colon < 0) return;
    const request = sequence.current + 1;
    sequence.current = request;
    const sentKey = contextKey;
    setBusy(true);
    setPacket(null);
    setError('');
    try {
      const result = await api.surveyPacket(orgId, selection.slice(0, colon), selection.slice(colon + 1));
      if (shouldApplySurveyResponse(sentKey, request, keyRef.current, sequence.current)) {
        setPacket(result);
      }
    } catch (e) {
      if (shouldApplySurveyResponse(sentKey, request, keyRef.current, sequence.current)) {
        setError(e instanceof Error ? e.message : 'Packet unavailable.');
      }
    } finally {
      if (shouldApplySurveyResponse(sentKey, request, keyRef.current, sequence.current)) {
        setBusy(false);
      }
    }
  }

  const evidenceTotal = (shown?.tasks ?? []).reduce((n, t) => n + t.evidence.length, 0);

  return (
    <section className="panel survey-panel" aria-labelledby="survey-heading">
      <div className="survey-controls">
        <h3 id="survey-heading">
          {orgKind === 'cannabis_microbusiness'
            ? 'OCM inspection mode — the inspector asks, Sentinel answers'
            : 'Survey mode — the surveyor asks, Sentinel answers'}
        </h3>
        <p>
          Gather existing records and check their audit history. Select a standard/control, a
          standalone task, or a whole domain.
        </p>
        <label htmlFor="survey-scope">Requested records</label>{' '}
        <select
          id="survey-scope"
          value={valid ? selection : ''}
          disabled={!ready}
          onChange={(e) => {
            // A new scope invalidates any in-flight packet from the old one.
            sequence.current += 1;
            setSelection(e.target.value);
            setPacket(null);
            setError('');
            setBusy(false);
          }}
        >
          <option value="">Choose records…</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>{' '}
        <button
          onClick={() => {
            void load();
          }}
          disabled={!ready || !valid || busy}
        >
          {busy ? 'Checking…' : 'Gather records & check integrity'}
        </button>
        {error && (
          <p role="alert" className="panel-error">
            {error}
          </p>
        )}
        {!ready && <p>Waiting for {orgName} data.</p>}
      </div>
      {!shown && (
        <p className="survey-print-empty">
          No survey packet gathered. Choose records and gather them before printing.
        </p>
      )}
      {shown && (
        <>
          <div className="survey-controls panel-actions">
            <button className="primary" onClick={() => window.print()}>
              Print packet / Save PDF
            </button>
            <button
              onClick={() => {
                void load();
              }}
              disabled={busy}
            >
              Refresh packet
            </button>
          </div>
          <article className="survey-packet" aria-label="Survey record packet">
            <h2>{surveyPacketTitle(shown.organization.kind)}</h2>
            <p className="survey-sim">
              <strong>SIMULATED DATA — DEMONSTRATION ONLY</strong>
            </p>
            <h3>
              {scopeKindLabel(shown)}: {shown.scope.title}
            </h3>
            <p>
              {shown.organization.name} · Snapshot generated {shown.generatedAt}
            </p>
            <p>{shown.scope.note}</p>
            {shown.regulatoryRefs.map((r, i) => (
              <p key={i}>
                {r.source}: {r.citation}
              </p>
            ))}
            <p role="status" className={shown.integrity.ok ? 'survey-pass' : 'survey-warning'}>
              <strong>
                {shown.integrity.ok
                  ? 'Audit chain check: PASS'
                  : 'WARNING: Audit chain check: FAILED — investigate before relying on this packet'}
              </strong>{' '}
              · {shown.integrity.relatedEvents} related events · {shown.tasks.length} tasks ·{' '}
              {evidenceTotal} evidence entries
            </p>
            {shown.integrity.legacyEvents > 0 && (
              <p className="survey-warning">
                WARNING: {shown.integrity.legacyEvents} related legacy events do not bind their
                organization into the hash.
              </p>
            )}
            <p>{SURVEY_INTEGRITY_NOTE}</p>
            <p>{SURVEY_EVIDENCE_NOTE}</p>
            {shown.tasks.length === 0 && shown.scope.kind === 'template' && (
              <p>{SURVEY_EMPTY_TEMPLATE}</p>
            )}
            {shown.tasks.length === 0 && shown.scope.kind === 'domain' && <p>{SURVEY_EMPTY_DOMAIN}</p>}
            {shown.tasks.map((t) => (
              <section key={t.id} className="survey-task">
                <h4>{t.title}</h4>
                <p>
                  Record: <code>{t.id}</code> · Owner: {actorLabel(shown, t.ownerId)} · Due:{' '}
                  {t.dueDate} · Status: {STATUS_LABELS[t.status]}
                </p>
                <p>
                  Verified: {t.status === 'verified' ? 'Yes' : 'No'} · Locked:{' '}
                  {t.status === 'verified'
                    ? 'Yes — task, evidence and custody changes are locked'
                    : 'No'}
                  {t.verifiedBy ? ` · Verifier ${actorLabel(shown, t.verifiedBy)}` : ''}
                  {t.verifiedAt ? ` · Verified at ${t.verifiedAt}` : ''}
                </p>
                <h5>Evidence ({t.evidence.length})</h5>
                {t.evidence.length === 0 && <p>No evidence recorded.</p>}
                <ul>
                  {t.evidence.map((e) => (
                    <li key={e.id}>
                      <strong>{e.label}</strong> · Current holder: {e.holder} · Updated:{' '}
                      {e.updatedAt}
                      <ol>
                        {e.custody.map((c) => (
                          <li key={c.seq}>
                            {c.at}: {c.fromHolder ?? 'Initial custody'} → {c.toHolder} · By{' '}
                            {actorLabel(shown, c.byUserId)}
                            {c.reason ? ` · ${c.reason}` : ''}
                          </li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <h3>Related recorded history ({shown.audit.length})</h3>
            {shown.audit.length === 0 && <p>No related audit events found.</p>}
            <ol className="survey-history">
              {shown.audit.map((e) => (
                <li key={e.id}>
                  <strong>
                    #{e.seq} {e.action}
                  </strong>{' '}
                  · {e.timestamp} · Actor {actorLabel(shown, e.actorId)} · {e.recordType}{' '}
                  {e.recordId}
                  <p>{e.detail}</p>
                  <p>
                    Hash version: {e.hashVersion ?? 1} · Hash: <code>{e.hash}</code>
                  </p>
                </li>
              ))}
            </ol>
          </article>
        </>
      )}
    </section>
  );
}
