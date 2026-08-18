/**
 * People / Employee Lifecycle — configuration catalogs (single source of truth).
 *
 * Everything here is DATA, not control flow. Owner teams, approver groups, the systems and
 * assets we track, SharePoint groups and their approval rules, and computer classes all live
 * here so the routing engine (routing.ts) and the seed (service.ts) read one authoritative set
 * of rules instead of scattering `if (name === 'Payroll')` checks through route files.
 *
 * These are the built-in DEFAULTS. They are seeded into configurable DB tables on boot so an
 * authorized admin can add/edit offices, software, SharePoint groups and vendor portals from the
 * People section without a code change. The routing rules that are ADAMANT (WEX -> Safety,
 * Payroll SharePoint -> HR, MGMT -> executive, door/fob -> IT, payroll/benefits -> HR) are
 * expressed here and enforced in routing.ts, and are covered by tests.
 */

/* ─────────────────────────── owner teams ─────────────────────────── */
/** The teams that own and execute lifecycle work. Safety renders green per the brand spec. */
export type Team = 'it' | 'hr' | 'safety' | 'accounting' | 'executive';

export interface TeamDef {
  key: Team;
  label: string;
  color: string; // status/routing color in the UI
  /** The operational people behind the team (display only; authorization is by role, not name). */
  people: string[];
}

export const TEAMS: TeamDef[] = [
  { key: 'it', label: 'IT', color: '#4b57c9', people: ['Devon'] },
  { key: 'hr', label: 'HR', color: '#B9860B', people: ['Sandi', 'Ronda'] },
  { key: 'safety', label: 'Safety', color: '#1f7a4d', people: ['Daniel', 'Denise'] },
  { key: 'accounting', label: 'Accounting', color: '#5b86ad', people: ['Rebecca'] },
  { key: 'executive', label: 'Executive', color: '#C62828', people: ['Mario', 'Chris'] },
];
export const TEAM_LABEL: Record<Team, string> = TEAMS.reduce((m, t) => ((m[t.key] = t.label), m), {} as Record<Team, string>);
export const TEAM_COLOR: Record<Team, string> = TEAMS.reduce((m, t) => ((m[t.key] = t.color), m), {} as Record<Team, string>);

/* ─────────────────────────── approver groups ───────────────────────────
 * An approval is satisfied by ANY user holding the approver group's role. The executive group is
 * satisfied by Mario OR Chris (never both). Approver group -> the authorization role that can
 * decide it. */
export type ApproverGroup = 'hr' | 'accounting' | 'executive' | 'safety' | 'it';

/** The app role that satisfies each approver group (see authz.ts for the role model). */
export const APPROVER_ROLE: Record<ApproverGroup, string> = {
  hr: 'hr',
  accounting: 'accounting',
  executive: 'executive_approver',
  safety: 'safety',
  it: 'it',
};

/* ─────────────────────────── access systems ───────────────────────────
 * Systems/software/access we grant and (on offboarding) revoke. `owner` provisions and revokes.
 * `approver` (when present) must approve before the provisioning task becomes actionable. */
export interface SystemDef {
  key: string;
  name: string;
  category: 'identity' | 'software' | 'operations' | 'monitoring' | 'vendor' | 'sharepoint';
  owner: Team;
  approver?: ApproverGroup;
  /** Seeded but marked so admins can extend; vendor portals arrive from Accounting's list later. */
  configurable?: boolean;
}

export const SYSTEMS: SystemDef[] = [
  // identity / IT core
  { key: 'active_directory', name: 'Active Directory', category: 'identity', owner: 'it' },
  { key: 'company_email', name: 'Company email', category: 'identity', owner: 'it' },
  { key: 'microsoft_365', name: 'Microsoft 365', category: 'identity', owner: 'it' },
  { key: 'teams_number', name: 'Teams number', category: 'identity', owner: 'it' },
  // software (IT provisions)
  { key: 'adobe_acrobat', name: 'Adobe Acrobat', category: 'software', owner: 'it' },
  { key: 'bluebeam', name: 'Bluebeam', category: 'software', owner: 'it' },
  { key: 'autocad', name: 'AutoCAD', category: 'software', owner: 'it' },
  { key: 'hydracad', name: 'HydraCAD', category: 'software', owner: 'it' },
  { key: 'hfss', name: 'HFSS', category: 'software', owner: 'it' },
  // operations
  { key: 'servicetrade', name: 'ServiceTrade', category: 'operations', owner: 'it' },
  { key: 'govspend', name: 'GovSpend', category: 'operations', owner: 'it' },
  { key: 'nfpa', name: 'NFPA', category: 'operations', owner: 'it' },
  { key: 'procore', name: 'Procore', category: 'operations', owner: 'it' },
  // monitoring
  { key: 'alarm_com', name: 'Alarm.com', category: 'monitoring', owner: 'it' },
  { key: 'southwest_dispatch', name: 'Southwest Dispatch', category: 'monitoring', owner: 'it' },
  { key: 'napco', name: 'NAPCO', category: 'monitoring', owner: 'it' },
  { key: 'advent', name: 'Advent', category: 'monitoring', owner: 'it' },
];

/* ─────────────────────────── SharePoint groups ───────────────────────────
 * Restricted groups need approval before IT provisions. The four adamant rules:
 *   Payroll -> HR (Sandi),  ACCT -> Accounting (Rebecca),  HR -> HR (Sandi),  MGMT -> executive (Mario OR Chris).
 * Location/function groups route straight to IT with no approval. */
export interface SharePointGroupDef {
  key: string;
  name: string;
  owner: Team; // always IT provisions the membership
  approver?: ApproverGroup;
  restricted: boolean;
}

export const SHAREPOINT_GROUPS: SharePointGroupDef[] = [
  { key: 'payroll', name: 'Payroll', owner: 'it', approver: 'hr', restricted: true },
  { key: 'hr', name: 'HR', owner: 'it', approver: 'hr', restricted: true },
  { key: 'acct', name: 'ACCT', owner: 'it', approver: 'accounting', restricted: true },
  { key: 'mgmt', name: 'MGMT', owner: 'it', approver: 'executive', restricted: true },
  // open location/function groups (IT provisions directly)
  { key: 'safety', name: 'Safety', owner: 'it', restricted: false },
  { key: 'riverton', name: 'Riverton', owner: 'it', restricted: false },
  { key: 'austin', name: 'Austin', owner: 'it', restricted: false },
  { key: 'fairview', name: 'Fairview', owner: 'it', restricted: false },
  { key: 'millbrook', name: 'Millbrook', owner: 'it', restricted: false },
  { key: 'college_station', name: 'College Station', owner: 'it', restricted: false },
  { key: 'lubbock', name: 'Lubbock', owner: 'it', restricted: false },
];

/* ─────────────────────────── assets ───────────────────────────
 * Physical/company assets we assign and recover. `owner` is who recovers it on offboarding. */
export interface AssetTypeDef {
  key: string;
  name: string;
  owner: Team;
  serialized: boolean; // tracks a serial/identifier
}

export const ASSET_TYPES: AssetTypeDef[] = [
  { key: 'laptop', name: 'Laptop', owner: 'it', serialized: true },
  { key: 'desktop', name: 'Desktop', owner: 'it', serialized: true },
  { key: 'monitor', name: 'Monitor', owner: 'it', serialized: false },
  { key: 'dock', name: 'Dock / accessories', owner: 'it', serialized: false },
  { key: 'ipad', name: 'iPad', owner: 'it', serialized: true },
  { key: 'company_phone', name: 'Company phone', owner: 'it', serialized: true },
  { key: 'phone_number', name: 'Phone number', owner: 'it', serialized: false },
  { key: 'vehicle', name: 'Vehicle', owner: 'safety', serialized: true },
  { key: 'wex_card', name: 'WEX fuel card', owner: 'safety', serialized: true },
  { key: 'key_fob', name: 'Key fob', owner: 'it', serialized: true },
  { key: 'gate_opener', name: 'Gate opener', owner: 'it', serialized: true },
  { key: 'access_credential', name: 'Building access credential', owner: 'it', serialized: false },
  { key: 'physical_key', name: 'Physical key', owner: 'it', serialized: false },
];
export const ASSET_OWNER: Record<string, Team> = ASSET_TYPES.reduce((m, a) => ((m[a.key] = a.owner), m), {} as Record<string, Team>);

/* ─────────────────────────── building access methods ───────────────────────────
 * Owner is always IT. Availability is per-office; not every branch is electronically managed. */
export const ACCESS_METHODS = [
  { key: 'electronic_building', name: 'Electronic building access' },
  { key: 'key_fob', name: 'Key fob' },
  { key: 'door_pin', name: 'Door PIN' },
  { key: 'gate_pin', name: 'Gate PIN' },
  { key: 'gate_opener', name: 'Gate opener' },
  { key: 'physical_key', name: 'Physical key' },
];

/* ─────────────────────────── computer classes ───────────────────────────
 * Purchasable specs are configuration, not hard-coded workflow logic. */
export const COMPUTER_CLASSES = [
  { key: 'standard', label: 'Standard', spec: '16 GB RAM / 512 GB storage' },
  { key: 'business', label: 'Business', spec: '32 GB RAM / 512 GB storage' },
  { key: 'cad', label: 'CAD', spec: '32 GB RAM / 1 TB storage / dedicated GPU' },
];
/** Software whose presence should nudge a CAD-class machine recommendation. */
export const CAD_SOFTWARE = new Set(['autocad', 'hydracad', 'hfss']);

/* ─────────────────────────── offices ───────────────────────────
 * Real 1st FP offices. Resources (access methods, SharePoint, printers) can be scoped per office. */
export const OFFICES = [
  { key: 'san_antonio', name: 'San Antonio' },
  { key: 'austin', name: 'Austin' },
  { key: 'mcallen', name: 'McAllen' },
  { key: 'waco', name: 'Waco' },
  { key: 'college_station', name: 'College Station' },
  { key: 'lubbock', name: 'Lubbock' },
  { key: 'houston', name: 'Houston' },
];

/* ─────────────────────────── job positions ───────────────────────────
 * The real BambooHR job-title catalog. Role templates are created for each, marked `unreviewed`
 * until the business approves defaults (we do not invent access defaults without evidence). */
export const JOB_POSITIONS: string[] = [
  'Foreman', 'Fitter Helper', 'Fitter', 'Admin', 'FA Tech', 'Inspector', 'Sales/Project Manager',
  'Service Tech', 'Technician', 'FA Helper', 'FA Sales/Project Manager', 'Service Helper', 'Branch Manager',
  'Designer', 'Service Manager', 'Office Manager', 'Purchasing Admin', 'Service Fitter', 'Accounting Assistant',
  'Receptionist', 'Senior Accountant', 'Service Foreman', 'Service Sales', 'Manager', 'Accounts Payable Supervisor',
  'Construction Accountant', 'Construction Accounting Manager', 'Controller', 'COO', 'FA Manager',
  'FE Special Hazard Tech', 'Fire Protection/Security Sales', 'HR Admin', 'Inspection manager', 'Inspector/FA Tech',
  'Lead Service Tech', 'Owner', 'P/T FA Tech', 'P/T Foreman', 'P/T Summer Helper', 'Payroll Manager/HR Generalist',
  'Safety Director', 'Safety/Laredo Admin Assistant', 'Service Tech Helper', 'CAD Designer', 'Asst Inspections Manager',
  'Coordinator', 'Extinguisher/Inspector Helper', 'FA Apprentice', 'FA Service Tech', 'FA Tech Helper',
  'Fire Alarm Manager', 'General Office Clerk', 'Payroll Specialist', 'PT Engineer', 'Warehouse/Delivery Driver',
];

/** Everything the onboarding form and role-template editor need to render, in one payload. */
export function catalogSnapshot() {
  return {
    teams: TEAMS,
    systems: SYSTEMS,
    sharepointGroups: SHAREPOINT_GROUPS,
    assetTypes: ASSET_TYPES,
    accessMethods: ACCESS_METHODS,
    computerClasses: COMPUTER_CLASSES,
    offices: OFFICES,
    jobPositions: JOB_POSITIONS,
  };
}
