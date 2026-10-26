// Synthetic demonstration data. No real patients, staff, or facilities.
// Due dates are generated relative to "today" so the demo always shows a
// mix of upcoming, due-soon, and overdue tasks.
import { buildAuditEvent, emptyDb, type DbShape } from './store.js';
import type { ComplianceTask, EvidenceRef, TaskStatus } from '../shared/types.js';

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
    ]
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
    status: 'submitted'
  },
  {
    key: 'task-baa',
    orgId: 'org-cah',
    domainId: 'dom-hipaa-h',
    title: 'Business associate agreement renewals',
    ownerId: 'u-officer',
    dueIn: -20,
    status: 'verified',
    evidence: [{ label: 'Signed BAA bundle (simulated)', holder: 'J. Ortiz' }]
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
    status: 'verified'
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
      createdAt: t,
      updatedAt: t
    };
  });

  db.audit = [];
  const push = (input: { actorId: string; action: string; recordType: string; recordId: string; detail: string }) => {
    db.audit.push(buildAuditEvent(db.audit, input));
  };
  push({
    actorId: 'system',
    action: 'db.seeded',
    recordType: 'database',
    recordId: 'sentinel',
    detail: 'Synthetic demo data loaded (simulated; no real patient data).'
  });
  for (const task of db.tasks) {
    push({
      actorId: 'u-admin',
      action: 'task.created',
      recordType: 'task',
      recordId: task.id,
      detail: `Seeded: ${task.title}`
    });
  }
  return db;
}
