import type { PricedLine } from '../engines/expense.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export type ExpenseSettings = {
  expense_fortnightly: boolean;
  expense_window_days: number;
  timezone: string;
  version: number;
  [key: string]: unknown;
};

export type Category = {
  id: string;
  code: string;
  name: string;
  basis: string;
  receipt_above: number | null;
  active: boolean;
};

export type PolicyRow = {
  id: string;
  code: string;
  name: string;
  note: string;
  active: boolean;
  version: number;
  effective_from: string;
  rates?: number;
};

export type ClaimRow = {
  id: string;
  version: number;
  status: string;
  rep_id: string;
  period_from: string;
  period_to: string;
  submitted_at: string | null;
  manager_by: string | null;
  manager_at: string | null;
  manager_note: string;
  finance_by: string | null;
  finance_at: string | null;
  finance_note: string;
  reject_reason: string;
  rep: string;
  rep_name: string;
  hq_town: string;
  rep_user_id: string | null;
  grade: string;
  manager_name: string;
  finance_name: string;
  [key: string]: unknown;
};

export type PricedClaim = {
  lines: (PricedLine & Record<string, any>)[];
  count: number;
  claimed: number;
  allowed: number;
  disallowed: number;
  capped: number;
  blocked: number;
  period: { from: string; to: string };
  rep: { id: string; code: string; name: string; hq_town: string } | null;
};

export const SETTING_DEFAULTS: Record<string, unknown>;

export function expenseSettings(db: Db): Promise<ExpenseSettings>;
export function fortnightlyFrom(settings: { expense_fortnightly?: boolean }): boolean;
export function periodFor(date: string, settings: unknown): { from: string; to: string } | null;

export function categories(db: Db, options?: { includeInactive?: boolean }): Promise<Category[]>;
export function findCategory(db: Db, id: string): Promise<Category | null>;

export function policies(db: Db): Promise<PolicyRow[]>;
export function findPolicy(db: Db, id: string): Promise<PolicyRow | null>;
export function policyRates(db: Db, policyId: string): Promise<any[]>;
export function createPolicy(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    code: string;
    name: string;
    effectiveFrom: string;
    note?: string;
    actorId?: string | null;
  },
): Promise<string>;
export function updatePolicy(
  db: Db,
  input: {
    id: string;
    version: number;
    name: string;
    effectiveFrom: string;
    note?: string;
    active?: boolean;
  },
): Promise<boolean>;
export function savePolicyRates(
  db: Db,
  tenantId: string,
  policyId: string,
  rows: {
    category_id: string;
    key: string;
    rate?: number | null;
    cap?: number | null;
    period_cap?: number | null;
  }[],
): Promise<number>;
export function policyInForce(
  db: Db,
  date: string,
): Promise<{ policy: PolicyRow | null; rates: any[] }>;

export function findClaim(db: Db, id: string): Promise<ClaimRow | null>;
export function claimForPeriod(db: Db, repId: string, periodFrom: string): Promise<ClaimRow | null>;
export function createClaim(
  db: Db,
  tenantId: string,
  input: { id: string; repId: string; from: string; to: string },
): Promise<string>;
export function openClaim(
  db: Db,
  tenantId: string,
  input: { repId: string; date: string; settings: unknown },
): Promise<ClaimRow | null>;
export function claimLines(db: Db, claimId: string): Promise<any[]>;
export function addLine(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    claimId: string;
    categoryId: string;
    spendDate: string;
    km?: number;
    vehicle?: string;
    nights?: number;
    town?: string;
    claimedAmount?: number;
    fileId?: string | null;
    note?: string;
  },
): Promise<string>;
export function editLine(
  db: Db,
  input: {
    id: string;
    version: number;
    categoryId: string;
    spendDate: string;
    km?: number;
    vehicle?: string;
    nights?: number;
    town?: string;
    claimedAmount?: number;
    fileId?: string | null;
    note?: string;
  },
): Promise<boolean>;
export function removeLine(
  db: Db,
  input: { id: string; version: number; reason?: string },
): Promise<boolean>;
export function findLine(
  db: Db,
  id: string,
): Promise<{
  id: string;
  version: number;
  claim_id: string;
  category_id: string;
  spend_date: string;
  category: string;
} | null>;

export function priceClaim(db: Db, claim: ClaimRow, settings: unknown): Promise<PricedClaim>;

export function submitClaim(db: Db, input: { id: string; version: number }): Promise<boolean>;
export function decideClaim(
  db: Db,
  actorId: string,
  input: {
    id: string;
    version: number;
    stage: string;
    approve: boolean;
    note?: string;
    reason?: string;
  },
): Promise<boolean>;
export function reopenClaim(db: Db, input: { id: string; version: number }): Promise<boolean>;
export function listClaims(
  db: Db,
  filters: {
    repId?: string | null;
    status?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  },
): Promise<{ items: ClaimRow[]; total: number }>;

export function expenseRegister(
  db: Db,
  filters: { from: string; to: string; repId?: string | null; status?: string | null },
  settings: unknown,
): Promise<{
  rows: any[];
  totals: { claims: number; claimed: number; allowed: number };
}>;
