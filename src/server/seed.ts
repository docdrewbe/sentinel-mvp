// Synthetic demonstration data. No real patients, staff, or facilities.
// Due dates are generated relative to "today" so the demo always shows a
// mix of upcoming, due-soon, and overdue tasks.
import { buildAuditEvent, emptyDb, type DbShape } from './store.js';
import type {
  ComplianceTask,
  ControlType,
  EscalationRule,
  EvidenceRef,
  EvidenceRequirement,
  RecurrenceFrequency,
  RegulatorySourceRef,
  Role,
  TaskStatus,
  TaskTemplate
} from '../shared/types.js';
import { SYSTEM_AUDIT_ORG } from '../shared/types.js';

const dueInDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const now = (): string => new Date().toISOString();

interface SeedTask {
  key: string;
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueIn: number;
  status: TaskStatus;
  evidence?: Array<{ label: string; holder: string }>;
  submittedBy?: string;
  submissions?: Array<{ submittedBy: string; ownerAtSubmission: string }>;
  verifiedBy?: string;
}

interface SeedTemplate {
  key: string;
  domainId: string;
  title: string;
  description: string;
  controlType: ControlType;
  regulatoryRefs: RegulatorySourceRef[];
  responsibleRoles: Role[];
  frequency: RecurrenceFrequency;
  evidenceRequired: EvidenceRequirement[];
  escalation: EscalationRule[];
}

const SEED_TASKS: SeedTask[] = [
  // --- 25-bed critical access hospital (primary demo) ---
  {
    key: 'task-hipaa-training',
    orgId: 'org-cah',
    domainId: 'dom-hipaa-h',
    title: 'HIPAA annual workforce training review',
    ownerId: 'u-staff',
    dueIn: 6,
    status: 'in_progress',
    evidence: [{ label: 'Training roster Q3 (simulated)', holder: 'M. Lee' }]
  },
  {
    key: 'task-emergency-drill',
    orgId: 'org-cah',
    domainId: 'dom-cms',
    title: 'CMS emergency preparedness drill log',
    ownerId: 'u-nurse-mgr',
    dueIn: -3,
    status: 'open'
  },
  {
    key: 'task-sharps-log',
    orgId: 'org-cah',
    domainId: 'dom-osha-h',
    title: 'OSHA sharps injury log — quarterly review',
    ownerId: 'u-staff',
    dueIn: 12,
    status: 'open'
  },
  {
    key: 'task-med-storage',
    orgId: 'org-cah',
    domainId: 'dom-tjc',
    title: 'Medication storage temperature audit',
    ownerId: 'u-nurse-mgr',
    dueIn: 2,
    status: 'submitted',
    evidence: [
      { label: 'Temperature log export (simulated)', holder: 'J. Ortiz' },
      { label: 'Corrective action note (simulated)', holder: 'M. Lee' }
    ],
    submittedBy: 'u-nurse-mgr',
    submissions: [{ submittedBy: 'u-nurse-mgr', ownerAtSubmission: 'u-nurse-mgr' }]
  },
  {
    key: 'task-access-review',
    orgId: 'org-cah',
    domainId: 'dom-hipaa-h',
    title: 'Access review — separated workforce accounts',
    ownerId: 'u-officer',
    dueIn: 9,
    status: 'in_progress'
  },
  {
    key: 'task-patient-rights',
    orgId: 'org-cah',
    domainId: 'dom-cms',
    title: 'Patient rights signage check — all units',
    ownerId: 'u-staff',
    dueIn: -10,
    status: 'submitted',
    evidence: [{ label: 'Unit signage checklist (simulated)', holder: 'T. Nguyen' }],
    submittedBy: 'u-staff',
    submissions: [{ submittedBy: 'u-staff', ownerAtSubmission: 'u-staff' }]
  },
  {
    key: 'task-baa',
    orgId: 'org-cah',
    domainId: 'dom-hipaa-h',
    title: 'Business associate agreement renewals',
    ownerId: 'u-officer',
    dueIn: -20,
    status: 'verified',
    evidence: [{ label: 'Signed BAA bundle (simulated)', holder: 'J. Ortiz' }],
    submittedBy: 'u-officer',
    submissions: [{ submittedBy: 'u-officer', ownerAtSubmission: 'u-officer' }],
    verifiedBy: 'u-admin'
  },
  // --- Outpatient clinic (primary demo) ---
  {
    key: 'task-privacy-screen',
    orgId: 'org-clinic',
    domainId: 'dom-hipaa-c',
    title: 'Front-desk privacy screen check',
    ownerId: 'u-clinic-staff',
    dueIn: 4,
    status: 'open'
  },
  {
    key: 'task-eyewash',
    orgId: 'org-clinic',
    domainId: 'dom-osha-c',
    title: 'Eyewash station weekly check log',
    ownerId: 'u-clinic-mgr',
    dueIn: 7,
    status: 'in_progress',
    evidence: [{ label: 'Check log photo (simulated)', holder: 'S. Patel' }]
  },
  {
    key: 'task-emergency-contacts',
    orgId: 'org-clinic',
    domainId: 'dom-osha-c',
    title: 'Emergency contacts posted at reception',
    ownerId: 'u-clinic-staff',
    dueIn: -6,
    status: 'verified',
    evidence: [{ label: 'Reception photo log (simulated)', holder: 'R. Gomez' }],
    submittedBy: 'u-clinic-staff',
    submissions: [{ submittedBy: 'u-clinic-staff', ownerAtSubmission: 'u-clinic-staff' }],
    verifiedBy: 'u-officer'
  },
  // --- Cannabis microbusiness (secondary demo: model portability) ---
  {
    key: 'task-inventory-sop',
    orgId: 'org-canna',
    domainId: 'dom-ocm',
    title: 'Inventory tracking SOP draft (demo config)',
    ownerId: 'u-canna-mgr',
    dueIn: 14,
    status: 'open'
  }
];

export function seedDatabase(): DbShape {
  const db = emptyDb();
  const t = now();

  db.orgs = [
    {
      id: 'org-cah',
      name: 'North Pine Critical Access Hospital',
      kind: 'hospital',
      beds: 25,
      location: 'Pine County, MN (simulated)',
      createdAt: t
    },
    {
      id: 'org-clinic',
      name: 'North Pine Outpatient Clinic',
      kind: 'clinic',
      location: 'Pine County, MN (simulated)',
      createdAt: t
    },
    {
      id: 'org-canna',
      name: 'North Star Cannabis Microbusiness',
      kind: 'cannabis_microbusiness',
      location: 'Minnesota (demo config)',
      createdAt: t
    }
  ];

  db.domains = [
    { id: 'dom-hipaa-h', orgId: 'org-cah', code: 'HIPAA', name: 'HIPAA Privacy & Security', description: 'Simulated hospital privacy and security tasks.', active: true },
    { id: 'dom-cms', orgId: 'org-cah', code: 'CMS-CAH', name: 'CMS Critical Access Hospital CoPs', description: 'Simulated conditions of participation tasks.', active: true },
    { id: 'dom-osha-h', orgId: 'org-cah', code: 'OSHA', name: 'OSHA Workplace Safety', description: 'Simulated workforce safety tasks.', active: true },
    { id: 'dom-tjc', orgId: 'org-cah', code: 'TJC', name: 'Joint Commission Readiness', description: 'Simulated accreditation readiness tasks.', active: true },
    { id: 'dom-hipaa-c', orgId: 'org-clinic', code: 'HIPAA', name: 'HIPAA Privacy & Security', description: 'Simulated clinic privacy tasks.', active: true },
    { id: 'dom-osha-c', orgId: 'org-clinic', code: 'OSHA', name: 'OSHA Workplace Safety', description: 'Simulated clinic safety tasks.', active: true },
    { id: 'dom-ocm', orgId: 'org-canna', code: 'MN-OCM', name: 'MN Office of Cannabis Management', description: 'Demo regulatory domain showing model portability.', active: true }
  ];

  db.users = [
    { id: 'u-admin', orgId: 'org-cah', name: 'A. Rahman', role: 'administrator', department: 'Administration' },
    { id: 'u-officer', orgId: 'org-cah', name: 'J. Ortiz', role: 'compliance_officer', department: 'Compliance' },
    { id: 'u-officer2', orgId: 'org-cah', name: 'D. Kim', role: 'compliance_officer', department: 'Compliance' },
    { id: 'u-nurse-mgr', orgId: 'org-cah', name: 'M. Lee', role: 'department_manager', department: 'Nursing' },
    { id: 'u-staff', orgId: 'org-cah', name: 'T. Nguyen', role: 'staff', department: 'Nursing' },
    { id: 'u-clinic-mgr', orgId: 'org-clinic', name: 'S. Patel', role: 'department_manager', department: 'Clinic Operations' },
    { id: 'u-clinic-staff', orgId: 'org-clinic', name: 'R. Gomez', role: 'staff', department: 'Front Desk' },
    { id: 'u-canna-mgr', orgId: 'org-canna', name: 'K. Anderson', role: 'department_manager', department: 'Operations' }
  ];

  db.tasks = SEED_TASKS.map((s): ComplianceTask => {
    const evidence: EvidenceRef[] = (s.evidence ?? []).map((e, i) => ({
      id: `${s.key}-ev${i + 1}`,
      label: e.label,
      holder: e.holder,
      custody: [{ seq: 1, fromHolder: null, toHolder: e.holder, byUserId: 'system', at: t }],
      updatedAt: t
    }));
    return {
      id: s.key,
      orgId: s.orgId,
      domainId: s.domainId,
      title: s.title,
      ownerId: s.ownerId,
      dueDate: dueInDays(s.dueIn),
      status: s.status,
      evidence,
      ...(s.submittedBy ? { submittedBy: s.submittedBy } : {}),
      ...(s.submissions
        ? {
            submissions: s.submissions.map((entry, i) => ({
              seq: i + 1,
              submittedBy: entry.submittedBy,
              ownerAtSubmission: entry.ownerAtSubmission,
              at: t
            }))
          }
        : {}),
      ...(s.verifiedBy ? { verifiedBy: s.verifiedBy, verifiedAt: t } : {}),
      createdAt: t,
      updatedAt: t
    };
  });

  // Compliance task templates for the 25-bed critical access hospital.
  // Regulatory citations below are illustrative demo references, not legal advice.
  const SEED_TEMPLATES: SeedTemplate[] = [
    {
      key: 'tpl-hipaa-training',
      domainId: 'dom-hipaa-h',
      title: 'HIPAA workforce training review',
      description: 'Confirm annual privacy and security training completion (simulated).',
      controlType: 'legally_required',
      regulatoryRefs: [
        { source: '45 CFR Part 164', citation: 'Workforce training (illustrative reference)' }
      ],
      responsibleRoles: ['compliance_officer', 'department_manager'],
      frequency: 'annually',
      evidenceRequired: [{ label: 'Training completion roster (simulated)', required: true }],
      escalation: [
        { afterDaysOverdue: 7, escalateTo: 'compliance_officer' },
        { afterDaysOverdue: 14, escalateTo: 'administrator' }
      ]
    },
    {
      key: 'tpl-emergency-drill',
      domainId: 'dom-cms',
      title: 'Emergency preparedness drill and review',
      description: 'Run the annual preparedness exercise and record the review (simulated).',
      controlType: 'legally_required',
      regulatoryRefs: [
        { source: '42 CFR Part 485', citation: 'Emergency preparedness CoP (illustrative reference)' }
      ],
      responsibleRoles: ['department_manager', 'compliance_officer'],
      frequency: 'annually',
      evidenceRequired: [
        { label: 'Drill log (simulated)', required: true },
        { label: 'After-action note (simulated)', required: false }
      ],
      escalation: [
        { afterDaysOverdue: 7, escalateTo: 'compliance_officer' },
        { afterDaysOverdue: 21, escalateTo: 'administrator' }
      ]
    },
    {
      key: 'tpl-sharps-review',
      domainId: 'dom-osha-h',
      title: 'Sharps injury log quarterly review',
      description: 'Review the sharps injury log and confirm follow-ups (simulated).',
      controlType: 'legally_required',
      regulatoryRefs: [
        { source: '29 CFR 1910.1030', citation: 'Bloodborne pathogens recordkeeping (illustrative reference)' }
      ],
      responsibleRoles: ['department_manager'],
      frequency: 'quarterly',
      evidenceRequired: [{ label: 'Log review sign-off (simulated)', required: true }],
      escalation: [{ afterDaysOverdue: 7, escalateTo: 'compliance_officer' }]
    },
    {
      key: 'tpl-access-review',
      domainId: 'dom-hipaa-h',
      title: 'Separated-workforce access review',
      description: 'Confirm accounts of separated staff are disabled (simulated).',
      controlType: 'legally_required',
      regulatoryRefs: [
        { source: '45 CFR Part 164', citation: 'Workforce clearance procedures (illustrative reference)' }
      ],
      responsibleRoles: ['compliance_officer'],
      frequency: 'monthly',
      evidenceRequired: [{ label: 'Deprovisioning checklist (simulated)', required: true }],
      escalation: [
        { afterDaysOverdue: 3, escalateTo: 'compliance_officer' },
        { afterDaysOverdue: 10, escalateTo: 'administrator' }
      ]
    },
    {
      key: 'tpl-med-storage',
      domainId: 'dom-tjc',
      title: 'Medication storage temperature audit',
      description: 'Voluntary monthly audit supporting accreditation readiness (simulated).',
      controlType: 'best_practice',
      regulatoryRefs: [
        { source: 'Internal quality program', citation: 'Voluntary readiness audit — not a legal mandate' }
      ],
      responsibleRoles: ['department_manager'],
      frequency: 'monthly',
      evidenceRequired: [{ label: 'Temperature log export (simulated)', required: true }],
      escalation: [{ afterDaysOverdue: 7, escalateTo: 'compliance_officer' }]
    },
    {
      key: 'tpl-signage',
      domainId: 'dom-cms',
      title: 'Patient rights signage check',
      description: 'Confirm patient rights notices are posted in all units (simulated).',
      controlType: 'legally_required',
      regulatoryRefs: [
        { source: '42 CFR Part 485', citation: 'Patient rights CoP (illustrative reference)' }
      ],
      responsibleRoles: ['department_manager', 'staff'],
      frequency: 'quarterly',
      evidenceRequired: [{ label: 'Unit checklist (simulated)', required: true }],
      escalation: [{ afterDaysOverdue: 7, escalateTo: 'compliance_officer' }]
    }
  ];
  db.templates = SEED_TEMPLATES.map(
    (s): TaskTemplate => ({
      id: s.key,
      orgId: 'org-cah',
      domainId: s.domainId,
      title: s.title,
      description: s.description,
      controlType: s.controlType,
      regulatoryRefs: s.regulatoryRefs,
      responsibleRoles: s.responsibleRoles,
      recurrence: { frequency: s.frequency },
      evidenceRequired: s.evidenceRequired,
      escalation: s.escalation,
      active: true,
      createdAt: t,
      updatedAt: t
    })
  );

  // First-slice CAPA example (synthetic hospital finding; no PHI).
  db.capas = [
    {
      id: 'capa-temp-log',
      orgId: 'org-cah',
      domainId: 'dom-tjc',
      taskId: 'task-med-storage',
      finding: 'Medication refrigerator temperature log gaps on two night shifts (simulated finding).',
      severity: 'medium',
      containment: 'Manual twice-daily checks assigned pending logger repair (simulated).',
      rootCause: 'Night-shift coverage gap during PTO (simulated draft).',
      ownerId: 'u-nurse-mgr',
      dueDate: dueInDays(14),
      correctivePlan: 'Repair logger and backfill supervised readings (simulated).',
      status: 'investigation',
      evidence: [],
      statusHistory: [
        { status: 'open', at: t, byUserId: 'u-officer' },
        { status: 'investigation', at: t, byUserId: 'u-nurse-mgr' }
      ],
      createdBy: 'u-officer',
      ownerHistory: [{ ownerId: 'u-nurse-mgr', from: 'initial', byUserId: 'u-officer', at: t }],
      actionsBy: ['u-nurse-mgr'],
      createdAt: t,
      updatedAt: t
    }
  ];

  db.audit = [];
  const push = (input: {
    actorId: string;
    action: string;
    recordType: string;
    recordId: string;
    orgId: string;
    detail: string;
  }) => {
    db.audit.push(buildAuditEvent(db.audit, input));
  };
  push({
    actorId: 'system',
    action: 'db.seeded',
    recordType: 'database',
    recordId: 'sentinel',
    orgId: SYSTEM_AUDIT_ORG,
    detail: 'Synthetic demo data loaded (simulated; no real patient data).'
  });
  for (const task of db.tasks) {
    push({
      actorId: 'u-admin',
      action: 'task.created',
      recordType: 'task',
      recordId: task.id,
      orgId: task.orgId,
      detail: `Seeded: ${task.title}`
    });
  }
  for (const template of db.templates) {
    push({
      actorId: 'u-officer',
      action: 'template.created',
      recordType: 'template',
      recordId: template.id,
      orgId: template.orgId,
      detail: `Seeded: ${template.title} [${template.controlType}]`
    });
  }
  for (const capa of db.capas) {
    push({
      actorId: 'u-officer',
      action: 'capa.created',
      recordType: 'capa',
      recordId: capa.id,
      orgId: capa.orgId,
      detail: `Seeded: ${capa.finding.slice(0, 80)}`
    });
  }
  return db;
}
