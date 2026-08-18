/**
 * People / Employee Lifecycle — the routing engine (pure, deterministic, testable).
 *
 * ONBOARDING: given the manager's intake, produce the exact list of work items, each addressed
 * to the owning team as a TASK (do it) or an APPROVAL (a human with the approver role must say
 * yes). Approval-gated access produces a linked pair: the approval, plus a provisioning task that
 * DEPENDS on the approval and cannot become actionable until it is granted.
 *
 * OFFBOARDING: given the employee's ACTUAL recorded footprint (access + assets), produce the
 * inverse revocation/recovery items. Offboarding reverses what the person really has, not what
 * the role template says, because employees carry exceptions.
 *
 * No database, no I/O — service.ts persists whatever this returns. The adamant routing rules
 * (WEX -> Safety, fleet -> Safety, payroll -> HR, benefits -> HR, door/fob -> IT, Payroll
 * SharePoint -> HR, ACCT -> Accounting, MGMT -> executive) are enforced here and covered by tests.
 */
import {
  Team, ApproverGroup, APPROVER_ROLE, SYSTEMS, SHAREPOINT_GROUPS, ASSET_OWNER, CAD_SOFTWARE, COMPUTER_CLASSES,
} from './catalog';

export type WorkKind = 'task' | 'approval';
export type WorkCategory = 'identity' | 'hardware' | 'software' | 'access' | 'hr' | 'safety' | 'credentials' | 'sharepoint';

export interface WorkItem {
  /** Stable within one request, used to wire dependencies. */
  key: string;
  category: WorkCategory;
  team: Team;
  kind: WorkKind;
  title: string;
  detail?: string;
  /** For approvals: the role that can decide it. For tasks that gate on approval: see dependsOn. */
  approverGroup?: ApproverGroup;
  approverRole?: string;
  /** This task cannot become `ready` until the item with this key is approved/done. */
  dependsOn?: string;
  /** Ties the item back to a catalog system / asset for offboarding + reconciliation. */
  system?: string;
  assetType?: string;
}

const SYSTEM_BY_KEY = new Map(SYSTEMS.map((s) => [s.key, s]));
const SP_BY_KEY = new Map(SHAREPOINT_GROUPS.map((g) => [g.key, g]));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'on';

/* ─────────────────────────── onboarding intake shape ─────────────────────────── */
export interface OnboardingIntake {
  // identity / HR
  wantAdAccount?: boolean;         // Create AD account (identity authority is on-prem AD)
  companyEmail?: boolean;
  microsoft365?: boolean;
  teamsNumber?: boolean;
  bambooRecord?: boolean;          // create/verify the BambooHR record (default true)
  payrollSetup?: boolean;          // HR
  payAdjustment?: boolean;         // HR
  benefits?: boolean;              // HR (insurance/benefits)
  ptoException?: boolean;          // HR
  probationWaived?: boolean;       // HR
  incentivePlan?: boolean;         // HR
  vehicleAllowance?: boolean;      // HR (compensation)
  hoursException?: boolean;        // HR (80/40)
  hrExceptionNote?: string;        // HR free-text
  // hardware
  computerNeeded?: boolean;
  computerClass?: string;          // standard|business|cad
  existingComputer?: boolean;      // reuse existing device (no purchase)
  companyPhone?: boolean;
  ipad?: boolean;
  monitors?: number;
  dock?: boolean;
  premiumHardware?: boolean;       // exceptional/high-cost -> executive approval
  hardwareNote?: string;
  // software / systems (catalog keys)
  systems?: string[];
  // sharepoint (catalog keys)
  sharepoint?: string[];
  // vendor portals (free-form names; IT provisions, admin-configured catalog)
  vendorPortals?: string[];
  // vehicles / safety
  companyVehicle?: boolean;
  vehicleTransfer?: boolean;
  newVehicle?: boolean;
  vehicleDetails?: string;
  wexCard?: boolean;
  mvrRequired?: boolean;
  proofOfInsurance?: boolean;
  safetyOnboarding?: boolean;
  // building access (catalog keys) + office
  buildingAccess?: string[];
  office?: string;
  // credentials/certifications (free-form list of required types)
  certifications?: string[];
}

function approval(item: Omit<WorkItem, 'kind' | 'approverRole'> & { approverGroup: ApproverGroup }): WorkItem {
  return { ...item, kind: 'approval', approverRole: APPROVER_ROLE[item.approverGroup] };
}
function task(item: Omit<WorkItem, 'kind'>): WorkItem {
  return { ...item, kind: 'task' };
}

/** Recommend a computer class from the requested software (CAD-heavy roles want CAD hardware). */
export function recommendComputerClass(systems: string[] = []): string {
  return systems.some((s) => CAD_SOFTWARE.has(s)) ? 'cad' : 'standard';
}

/* ─────────────────────────── the onboarding router ─────────────────────────── */
export function routeOnboarding(intake: OnboardingIntake): WorkItem[] {
  const items: WorkItem[] = [];
  const push = (w: WorkItem) => items.push(w);

  // ── HR: BambooHR record (default on) + pay/benefits + exceptions (all HR, never Accounting) ──
  if (intake.bambooRecord !== false) push(task({ key: 'hr_bamboo', category: 'hr', team: 'hr', title: 'Create/verify BambooHR record' }));
  if (bool(intake.payrollSetup)) push(task({ key: 'hr_payroll', category: 'hr', team: 'hr', title: 'Payroll setup' }));
  if (bool(intake.payAdjustment)) push(task({ key: 'hr_pay_adj', category: 'hr', team: 'hr', title: 'Pay adjustment' }));
  if (bool(intake.benefits)) push(task({ key: 'hr_benefits', category: 'hr', team: 'hr', title: 'Insurance / benefits' }));
  if (bool(intake.ptoException)) push(task({ key: 'hr_pto', category: 'hr', team: 'hr', title: 'PTO exception' }));
  if (bool(intake.probationWaived)) push(task({ key: 'hr_probation', category: 'hr', team: 'hr', title: 'Probation waiver' }));
  if (bool(intake.incentivePlan)) push(task({ key: 'hr_incentive', category: 'hr', team: 'hr', title: 'Incentive plan' }));
  if (bool(intake.hoursException)) push(task({ key: 'hr_hours', category: 'hr', team: 'hr', title: '80/40 hours exception' }));
  if (bool(intake.vehicleAllowance)) push(task({ key: 'hr_veh_allow', category: 'hr', team: 'hr', title: 'Vehicle allowance (build into pay)' }));
  const hrNote = (intake.hrExceptionNote || '').trim();
  if (hrNote) push(task({ key: 'hr_note', category: 'hr', team: 'hr', title: 'HR/pay exception', detail: hrNote }));

  // ── Identity / IT ──
  if (intake.wantAdAccount !== false) push(task({ key: 'it_ad', category: 'identity', team: 'it', title: 'Create Active Directory account', detail: 'On-prem AD is the identity authority; Entra Connect syncs it up.', system: 'active_directory' }));
  if (bool(intake.companyEmail)) push(task({ key: 'it_email', category: 'identity', team: 'it', title: 'Set up company email', system: 'company_email' }));
  if (bool(intake.microsoft365)) push(task({ key: 'it_m365', category: 'identity', team: 'it', title: 'Provision Microsoft 365', system: 'microsoft_365' }));
  if (bool(intake.teamsNumber)) push(task({ key: 'it_teams', category: 'identity', team: 'it', title: 'Assign Teams number', system: 'teams_number' }));

  // ── Hardware (IT). Premium/exceptional hardware needs executive approval before purchase. ──
  if (bool(intake.computerNeeded)) {
    const cls = intake.computerClass || recommendComputerClass(intake.systems);
    const spec = COMPUTER_CLASSES.find((c) => c.key === cls)?.spec || cls;
    const source = bool(intake.existingComputer) ? 'reuse existing device' : 'new device';
    if (bool(intake.premiumHardware) && !bool(intake.existingComputer)) {
      push(approval({ key: 'exec_hw', category: 'hardware', team: 'executive', title: 'Approve exceptional hardware purchase', detail: `${cls} · ${spec}`, approverGroup: 'executive' }));
      push(task({ key: 'it_computer', category: 'hardware', team: 'it', title: `Configure ${cls} computer`, detail: `${spec} · ${source}`, dependsOn: 'exec_hw', assetType: 'laptop' }));
    } else {
      push(task({ key: 'it_computer', category: 'hardware', team: 'it', title: `Configure ${cls} computer`, detail: `${spec} · ${source}`, assetType: 'laptop' }));
    }
  }
  if (bool(intake.companyPhone)) push(task({ key: 'it_phone', category: 'hardware', team: 'it', title: 'Issue company phone', assetType: 'company_phone' }));
  if (bool(intake.ipad)) push(task({ key: 'it_ipad', category: 'hardware', team: 'it', title: 'Issue iPad', assetType: 'ipad' }));
  if (Number(intake.monitors) > 0) push(task({ key: 'it_monitors', category: 'hardware', team: 'it', title: `Provide ${Number(intake.monitors)} monitor(s)`, assetType: 'monitor' }));
  if (bool(intake.dock)) push(task({ key: 'it_dock', category: 'hardware', team: 'it', title: 'Provide dock / accessories', assetType: 'dock' }));

  // ── Software / systems (IT provisions; some catalog systems may require approval). ──
  for (const key of intake.systems || []) {
    const s = SYSTEM_BY_KEY.get(key);
    if (!s) continue;
    if (s.approver) {
      push(approval({ key: `appr_${key}`, category: 'software', team: teamForApprover(s.approver), title: `Approve ${s.name}`, approverGroup: s.approver, system: key }));
      push(task({ key: `it_${key}`, category: 'software', team: s.owner, title: `Provision ${s.name}`, dependsOn: `appr_${key}`, system: key }));
    } else {
      push(task({ key: `it_${key}`, category: 'software', team: s.owner, title: `Provision ${s.name}`, system: key }));
    }
  }

  // ── SharePoint groups. Restricted -> approval (HR/Accounting/executive) then IT provisions. ──
  for (const key of intake.sharepoint || []) {
    const g = SP_BY_KEY.get(key);
    if (!g) continue;
    if (g.approver) {
      push(approval({ key: `sp_appr_${key}`, category: 'sharepoint', team: teamForApprover(g.approver), title: `Approve SharePoint: ${g.name}`, detail: 'Restricted group; needs approval before access.', approverGroup: g.approver, system: `sharepoint:${key}` }));
      push(task({ key: `sp_it_${key}`, category: 'sharepoint', team: 'it', title: `Grant SharePoint: ${g.name}`, dependsOn: `sp_appr_${key}`, system: `sharepoint:${key}` }));
    } else {
      push(task({ key: `sp_it_${key}`, category: 'sharepoint', team: 'it', title: `Grant SharePoint: ${g.name}`, system: `sharepoint:${key}` }));
    }
  }

  // ── Vendor portals (IT provisions; catalog is admin-configured). ──
  for (const name of intake.vendorPortals || []) {
    const clean = String(name).trim();
    if (clean) push(task({ key: `vendor_${slug(clean)}`, category: 'access', team: 'it', title: `Provision vendor portal: ${clean}`, system: `vendor:${slug(clean)}` }));
  }

  // ── Vehicles / Safety. WEX, fleet, company vehicle, transfer, MVR, insurance -> Safety.  ──
  if (bool(intake.mvrRequired) || bool(intake.companyVehicle)) {
    push(task({ key: 'safety_mvr', category: 'safety', team: 'safety', title: 'Run/verify motor vehicle report (MVR)' }));
  }
  if (bool(intake.proofOfInsurance)) push(task({ key: 'safety_insurance', category: 'safety', team: 'safety', title: 'Verify proof of insurance' }));
  if (bool(intake.companyVehicle) || bool(intake.newVehicle) || bool(intake.vehicleTransfer)) {
    // Vehicle assignment must not complete until MVR clears -> model the dependency, don't rely on memory.
    const detail = (intake.vehicleDetails || '').trim() || undefined;
    push(task({ key: 'safety_vehicle', category: 'safety', team: 'safety', title: bool(intake.vehicleTransfer) ? 'Company vehicle transfer' : 'Assign company vehicle', detail, dependsOn: 'safety_mvr', assetType: 'vehicle' }));
  }
  if (bool(intake.wexCard)) push(task({ key: 'safety_wex', category: 'safety', team: 'safety', title: 'Issue WEX fuel card', assetType: 'wex_card' }));
  if (intake.safetyOnboarding !== false) push(task({ key: 'safety_onboarding', category: 'safety', team: 'safety', title: 'Safety onboarding + training' }));

  // ── Building access (IT). Options depend on office; we route whatever the manager selected. ──
  for (const key of intake.buildingAccess || []) {
    push(task({ key: `access_${key}`, category: 'access', team: 'it', title: `Grant building access: ${humanize(key)}`, detail: intake.office ? `Office: ${intake.office}` : undefined, assetType: assetForAccess(key), system: `building:${key}` }));
  }

  // ── Credentials / certifications (verification owner depends on type; safety-owned by default). ──
  for (const cert of intake.certifications || []) {
    const clean = String(cert).trim();
    if (clean) push(task({ key: `cred_${slug(clean)}`, category: 'credentials', team: certOwner(clean), title: `Collect + verify: ${clean}` }));
  }

  return items;
}

/* ─────────────────────────── the offboarding router ─────────────────────────── */
export interface FootprintAccess { system: string; label?: string }
export interface FootprintAsset { assetType: string; identifier?: string; label?: string }
export interface Footprint { access: FootprintAccess[]; assets: FootprintAsset[] }

/** Reverse the employee's ACTUAL footprint into revocation (access) + recovery (asset) tasks. */
export function routeOffboarding(fp: Footprint): WorkItem[] {
  const items: WorkItem[] = [];

  // HR closeout is always present.
  items.push(task({ key: 'off_hr_status', category: 'hr', team: 'hr', title: 'Set BambooHR status to terminated + final HR file' }));
  items.push(task({ key: 'off_hr_finalpay', category: 'hr', team: 'hr', title: 'Final pay / termination documentation' }));

  for (const a of fp.access || []) {
    const owner = ownerForSystem(a.system);
    const label = a.label || humanizeSystem(a.system);
    items.push(task({ key: `off_access_${slug(a.system)}`, category: categoryForSystem(a.system), team: owner, title: `Revoke ${label}`, system: a.system }));
  }
  for (const as of fp.assets || []) {
    const owner = ASSET_OWNER[as.assetType] || 'it';
    const label = as.label || humanize(as.assetType);
    const id = as.identifier ? ` (${as.identifier})` : '';
    items.push(task({ key: `off_asset_${slug(as.assetType + (as.identifier || ''))}`, category: 'access', team: owner, title: `Recover ${label}${id}`, assetType: as.assetType }));
  }
  return items;
}

/* ─────────────────────────── helpers ─────────────────────────── */
function teamForApprover(g: ApproverGroup): Team {
  return g === 'executive' ? 'executive' : (g as Team);
}
function ownerForSystem(system: string): Team {
  if (system.startsWith('sharepoint:') || system.startsWith('building:') || system.startsWith('vendor:')) return 'it';
  const s = SYSTEM_BY_KEY.get(system);
  if (s) return s.owner;
  // access-control credentials + phone live with IT; vehicle/WEX with Safety.
  if (/vehicle|wex|fleet/.test(system)) return 'safety';
  return 'it';
}
function categoryForSystem(system: string): WorkCategory {
  if (system.startsWith('sharepoint:')) return 'sharepoint';
  if (system.startsWith('building:')) return 'access';
  const s = SYSTEM_BY_KEY.get(system);
  if (s) return s.category === 'identity' ? 'identity' : s.category === 'software' ? 'software' : 'access';
  return 'access';
}
function assetForAccess(key: string): string | undefined {
  if (key === 'key_fob') return 'key_fob';
  if (key === 'gate_opener') return 'gate_opener';
  if (key === 'physical_key') return 'physical_key';
  if (key === 'electronic_building') return 'access_credential';
  return undefined;
}
function certOwner(name: string): Team {
  return /osha|mvr|driver|insurance|dot|safety/i.test(name) ? 'safety' : 'hr';
}
function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function humanizeSystem(system: string): string {
  if (system.startsWith('sharepoint:')) return `SharePoint: ${humanize(system.slice('sharepoint:'.length))}`;
  if (system.startsWith('building:')) return `Building access: ${humanize(system.slice('building:'.length))}`;
  if (system.startsWith('vendor:')) return `Vendor portal: ${humanize(system.slice('vendor:'.length))}`;
  return SYSTEM_BY_KEY.get(system)?.name || humanize(system);
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
