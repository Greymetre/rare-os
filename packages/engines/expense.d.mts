export type ExpenseBasis = 'KM' | 'DAILY' | 'NIGHTLY' | 'ACTUAL';
export type PlaceClass = 'HQ' | 'EX_HQ' | 'OUTSTATION';
export type ClaimStatus = 'DRAFT' | 'SUBMITTED' | 'MANAGER_OK' | 'APPROVED' | 'REJECTED';
export type ApprovalStage = 'MANAGER' | 'FINANCE';

export const EXPENSE_BASES: ExpenseBasis[];
export const PLACE_CLASSES: PlaceClass[];
export const CLAIM_STATUSES: ClaimStatus[];
export const APPROVAL_STAGES: ApprovalStage[];
export const NOT_AT_WORK: string[];
export const LINE_REASONS: Record<string, string>;

export function money(value: unknown): number;

export type Policy = { id?: string; effective_from: string; active?: boolean; [k: string]: any };
export function policyFor(input: { policies?: Policy[]; date: string }): Policy | null;
export function policyIsOpen(policy: Policy | null, today: string): boolean;

export function placeClass(input: {
  hqTown?: string;
  plannedTown?: string;
  claimedTown?: string;
  nights?: number | string;
}): { place: PlaceClass; town: string; source: 'PLAN' | 'CLAIM' };

export function rateKeyFor(input: {
  basis?: string;
  vehicle?: string;
  place?: string;
  grade?: string;
}): string;

export type Rate = {
  category_id: string;
  key: string;
  rate?: number | null;
  cap?: number | null;
  period_cap?: number | null;
};
export function rateFor(input: { rates?: Rate[]; categoryId: string; key: string }): Rate | null;

export type PricedLine = {
  basis: string;
  place: string;
  town: string;
  town_source: string;
  key: string;
  rate: number | null;
  units: number;
  claimed: number;
  computed: number;
  allowed: number;
  capped: boolean;
  reasons: string[];
};
export function lineAmount(input: {
  line?: Record<string, any>;
  category?: { basis?: string; receipt_above?: number | null } | null;
  rate?: Rate | null;
  dayStatus?: string | null;
  place?: { place: string; town: string; source: string } | null;
  hasReceipt?: boolean;
}): PricedLine;

export function claimTotals(input: {
  lines?: any[];
  periodCaps?: Record<string, number | null | undefined>;
}): {
  lines: any[];
  count: number;
  claimed: number;
  allowed: number;
  disallowed: number;
  capped: number;
  blocked: number;
};

export function periodOf(
  date: unknown,
  options?: { fortnightly?: boolean },
): { from: string; to: string } | null;

export function nextStage(status: string): ApprovalStage | null;
export function canDecide(input: {
  claim?: Record<string, any>;
  stage: string;
  actorId: string;
  repUserId?: string | null;
}): { allowed: boolean; reason: string };
