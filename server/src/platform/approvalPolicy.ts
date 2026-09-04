import type { ApprovalLevel } from './contracts';

export interface ActionPolicy {
  key: string;
  level: ApprovalLevel;
  description: string;
}

export const DEFAULT_ACTION_POLICIES: ActionPolicy[] = [
  { key: 'read', level: 0, description: 'Read, research, analyze, summarize, calculate, or classify.' },
  { key: 'prepare', level: 1, description: 'Draft or prepare a reversible artifact without sending/publishing it.' },
  { key: 'internal_reversible', level: 2, description: 'Reversible internal state change.' },
  { key: 'external_write', level: 3, description: 'Customer-facing, public, or external side effect.' },
  { key: 'high_risk', level: 4, description: 'Financial, legal, destructive, employment, or security action.' },
];

export function requiresHumanApproval(level: ApprovalLevel, autonomousCeiling: ApprovalLevel = 2): boolean {
  if (level >= 4) return true;
  return level > autonomousCeiling;
}

export function assertAllowed(level: ApprovalLevel, approved: boolean, autonomousCeiling: ApprovalLevel = 2): void {
  if (requiresHumanApproval(level, autonomousCeiling) && !approved) {
    throw new Error(`Human approval required for action level ${level}`);
  }
}
