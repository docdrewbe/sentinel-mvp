// Read-only survey/OCM inspection packet projection over existing records.
//
// Pure function: no I/O, no writes, no audit events. The route enforces
// organization visibility before calling; every lookup below is additionally
// constrained to the packet org, and task inclusion follows explicit stored
// links only (templateId / domainId / id) — never title similarity.
import type { SurveyPacket, SurveyScopeKind } from '../shared/survey.js';
import { SURVEY_DOMAIN_NOTE, SURVEY_TASK_NOTE, SURVEY_TEMPLATE_NOTE } from '../shared/survey.js';
import { verifyAuditChain, type DbShape } from './store.js';

/** Build one packet snapshot, or null when the scope does not resolve in this org. */
export function buildSurveyPacket(
  db: DbShape,
  orgId: string,
  kind: SurveyScopeKind,
  id: string
): SurveyPacket | null {
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org) return null;
  const template =
    kind === 'template' ? db.templates.find((t) => t.id === id && t.orgId === orgId) : undefined;
  const domain =
    kind === 'domain' ? db.domains.find((d) => d.id === id && d.orgId === orgId) : undefined;
  const single =
    kind === 'task' ? db.tasks.find((t) => t.id === id && t.orgId === orgId) : undefined;
  if (!template && !domain && !single) return null;

  const tasks = db.tasks.filter((t) => {
    if (t.orgId !== orgId) return false;
    if (template) return t.templateId === template.id;
    if (domain) return t.domainId === domain.id;
    return single !== undefined && t.id === single.id;
  });
  const taskIds = new Set(tasks.map((t) => t.id));
  const templateIds = new Set(
    template
      ? [template.id]
      : domain
        ? db.templates
            .filter((t) => t.orgId === orgId && t.domainId === domain.id)
            .map((t) => t.id)
        : tasks.flatMap((t) => (t.templateId ? [t.templateId] : []))
  );
  // Containment: only task/template events whose event org equals the packet
  // org. Unknown/system tags and every other record type (concern, CAPA,
  // notice, docaudit, obligation) are excluded even on id collision. This is
  // strictly narrower than the audit endpoint's visibility rules, never
  // broader: no privileged-only event enters a packet.
  const audit = db.audit.filter(
    (e) =>
      e.orgId === orgId &&
      ((e.recordType === 'task' && taskIds.has(e.recordId)) ||
        (e.recordType === 'template' && templateIds.has(e.recordId)))
  );
  // Integrity reuses the existing full-chain verifier: no subset verifier.
  // ok:false must surface, never block the snapshot (the packet discloses it).
  const chain = verifyAuditChain(db.audit);

  const names = new Map(db.users.map((u) => [u.id, u.name]));
  const actorIds = new Set<string>();
  for (const t of tasks) {
    actorIds.add(t.ownerId);
    if (t.verifiedBy) actorIds.add(t.verifiedBy);
    for (const e of t.evidence) {
      for (const c of e.custody ?? []) actorIds.add(c.byUserId);
    }
  }
  for (const e of audit) actorIds.add(e.actorId);
  const actors: Record<string, string> = {};
  for (const actorId of actorIds) {
    const name = names.get(actorId);
    if (name !== undefined) actors[actorId] = name;
  }

  return {
    simulated: true,
    generatedAt: new Date().toISOString(),
    organization: { id: org.id, name: org.name, kind: org.kind },
    scope: {
      kind: template ? 'template' : domain ? 'domain' : 'task',
      id,
      title: template?.title ?? domain?.name ?? single?.title ?? id,
      note: template ? SURVEY_TEMPLATE_NOTE : domain ? SURVEY_DOMAIN_NOTE : SURVEY_TASK_NOTE
    },
    regulatoryRefs: template ? [...template.regulatoryRefs] : [],
    // Clone so callers can never mutate live store records through the packet.
    tasks: structuredClone(tasks),
    actors,
    audit: structuredClone(audit),
    integrity: {
      ok: chain.ok,
      checkedEvents: db.audit.length,
      relatedEvents: audit.length,
      legacyEvents: audit.filter((e) => e.hashVersion !== 2).length
    }
  };
}
