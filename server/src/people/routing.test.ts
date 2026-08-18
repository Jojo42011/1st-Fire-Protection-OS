import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOnboarding, routeOffboarding, recommendComputerClass, WorkItem } from './routing';

const find = (items: WorkItem[], key: string) => items.find((i) => i.key === key);
const byTitle = (items: WorkItem[], re: RegExp) => items.filter((i) => re.test(i.title));

test('Payroll SharePoint approval routes to HR (Sandi), not Accounting/Rebecca', () => {
  const items = routeOnboarding({ sharepoint: ['payroll'] });
  const appr = find(items, 'sp_appr_payroll');
  assert.ok(appr, 'payroll approval exists');
  assert.equal(appr!.kind, 'approval');
  assert.equal(appr!.approverGroup, 'hr');
  assert.equal(appr!.approverRole, 'hr');
  assert.notEqual(appr!.approverGroup, 'accounting');
});

test('ACCT SharePoint approval routes to Accounting (Rebecca)', () => {
  const items = routeOnboarding({ sharepoint: ['acct'] });
  const appr = find(items, 'sp_appr_acct');
  assert.ok(appr);
  assert.equal(appr!.approverGroup, 'accounting');
  assert.equal(appr!.approverRole, 'accounting');
});

test('HR SharePoint approval routes to HR (Sandi)', () => {
  const items = routeOnboarding({ sharepoint: ['hr'] });
  assert.equal(find(items, 'sp_appr_hr')!.approverGroup, 'hr');
});

test('MGMT SharePoint approval is satisfied by the executive group (Mario OR Chris)', () => {
  const items = routeOnboarding({ sharepoint: ['mgmt'] });
  const appr = find(items, 'sp_appr_mgmt');
  assert.ok(appr);
  assert.equal(appr!.approverGroup, 'executive');
  assert.equal(appr!.approverRole, 'executive_approver'); // any one holder (Mario or Chris) satisfies it
});

test('Restricted SharePoint provisioning task depends on its approval (blocked until granted)', () => {
  const items = routeOnboarding({ sharepoint: ['mgmt'] });
  const provision = find(items, 'sp_it_mgmt');
  assert.ok(provision);
  assert.equal(provision!.team, 'it');
  assert.equal(provision!.dependsOn, 'sp_appr_mgmt');
});

test('Open location SharePoint routes straight to IT with no approval', () => {
  const items = routeOnboarding({ sharepoint: ['austin'] });
  assert.equal(find(items, 'sp_it_austin')!.team, 'it');
  assert.equal(items.some((i) => i.key === 'sp_appr_austin'), false);
});

test('WEX fuel card routes to Safety', () => {
  const items = routeOnboarding({ wexCard: true });
  const wex = find(items, 'safety_wex');
  assert.ok(wex);
  assert.equal(wex!.team, 'safety');
  assert.equal(wex!.assetType, 'wex_card');
});

test('Fleet / company vehicle assignment routes to Safety and depends on MVR clearing', () => {
  const items = routeOnboarding({ companyVehicle: true });
  const veh = find(items, 'safety_vehicle');
  assert.ok(veh);
  assert.equal(veh!.team, 'safety');
  assert.equal(veh!.dependsOn, 'safety_mvr');
  assert.equal(find(items, 'safety_mvr')!.team, 'safety');
});

test('Vehicle allowance (compensation) routes to HR, not Safety', () => {
  const items = routeOnboarding({ vehicleAllowance: true });
  assert.equal(find(items, 'hr_veh_allow')!.team, 'hr');
});

test('Door access and key fob route to IT', () => {
  const items = routeOnboarding({ buildingAccess: ['door_pin', 'key_fob'] });
  assert.equal(find(items, 'access_door_pin')!.team, 'it');
  assert.equal(find(items, 'access_key_fob')!.team, 'it');
});

test('Payroll setup and pay adjustments route to HR', () => {
  const items = routeOnboarding({ payrollSetup: true, payAdjustment: true });
  assert.equal(find(items, 'hr_payroll')!.team, 'hr');
  assert.equal(find(items, 'hr_pay_adj')!.team, 'hr');
});

test('Insurance / benefits route to HR', () => {
  const items = routeOnboarding({ benefits: true });
  assert.equal(find(items, 'hr_benefits')!.team, 'hr');
});

test('CAD-heavy software recommends CAD hardware', () => {
  assert.equal(recommendComputerClass(['autocad']), 'cad');
  assert.equal(recommendComputerClass(['servicetrade']), 'standard');
});

test('Premium hardware requires executive approval before IT configures it', () => {
  const items = routeOnboarding({ computerNeeded: true, computerClass: 'cad', premiumHardware: true });
  const appr = find(items, 'exec_hw');
  assert.ok(appr);
  assert.equal(appr!.approverGroup, 'executive');
  assert.equal(find(items, 'it_computer')!.dependsOn, 'exec_hw');
});

test('Offboarding reverses the employee ACTUAL footprint to the owning teams', () => {
  const items = routeOffboarding({
    access: [{ system: 'active_directory' }, { system: 'servicetrade' }, { system: 'sharepoint:mgmt' }, { system: 'building:key_fob' }],
    assets: [{ assetType: 'laptop', identifier: 'DEV-123' }, { assetType: 'vehicle', identifier: 'Truck 34' }, { assetType: 'wex_card' }],
  });
  // access revocations to the owning team
  assert.equal(find(items, 'off_access_active_directory')!.team, 'it');
  assert.equal(find(items, 'off_access_servicetrade')!.team, 'it');
  assert.equal(find(items, 'off_access_sharepoint_mgmt')!.team, 'it');
  // asset recovery to the owning team: laptop -> IT, vehicle + WEX -> Safety
  assert.equal(items.find((i) => i.assetType === 'laptop' && /Recover/.test(i.title))!.team, 'it');
  assert.equal(items.find((i) => i.assetType === 'vehicle')!.team, 'safety');
  assert.equal(items.find((i) => i.assetType === 'wex_card')!.team, 'safety');
  // HR closeout always present
  assert.ok(find(items, 'off_hr_status'));
  assert.ok(byTitle(items, /Recover/).length >= 3);
});

test('A sparse intake produces only the items it asked for (plus the always-on defaults)', () => {
  const items = routeOnboarding({ bambooRecord: false, wantAdAccount: false, safetyOnboarding: false });
  assert.equal(items.length, 0);
});
