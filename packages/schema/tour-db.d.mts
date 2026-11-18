import type { AdherenceRow, AdherenceStatus, PlanStatus } from '../engines/tour-plan.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export type PlanSettings = {
  plan_due_day: number;
  plan_max_outlets: number;
  plan_field_days_pct: number;
  plan_followed_pct: number;
  timezone: string;
  version: number;
  [key: string]: unknown;
};

export type Plan = {
  id: string;
  version: number;
  status: PlanStatus;
  note: string;
  rep_id: string;
  month: string;
  month_start: string;
  rep: string;
  rep_name: string;
  territory_id: string;
  week_off: string;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string;
  decision_reason: string;
};

export type PlanDay = {
  work_date: string;
  beat_id: string | null;
  beat: string;
  beat_name: string;
  town: string;
  outlet_count: number;
  objective: string;
  source: 'AUTO' | 'MANUAL';
  outlets: string[];
};

export type PlannableBeatRow = {
  id: string;
  code: string;
  name: string;
  frequency: 'WEEKLY' | 'FORTNIGHTLY';
  run_days: string;
  week_parity: 'ALL' | 'ODD' | 'EVEN';
  from_date: string;
  to_date: string | null;
  outlet_count: number;
  town: string;
};

export type DayChange = {
  id: string;
  version: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string;
  decision_reason: string;
  work_date: string;
  month: string;
  plan_id: string;
  rep_id: string;
  rep: string;
  rep_name: string;
  beat_id: string | null;
  beat: string;
  town: string;
  outlet_count: number;
  objective: string;
  previous_beat_id: string | null;
  previous_beat: string;
  previous_town: string;
  previous_outlet_count: number;
  previous_objective: string;
  decided_by: string;
  decided_at: string | null;
};

export const EDITABLE: PlanStatus[];

export function planSettings(db: Db): Promise<PlanSettings>;
export function findPlan(db: Db, input: { repId: string; month: string }): Promise<Plan | null>;
export function findPlanById(db: Db, planId: string): Promise<Plan | null>;
export function createPlan(
  db: Db,
  tenantId: string,
  input: { id: string; repId: string; month: string; note?: string },
): Promise<string>;
export function touchPlan(db: Db, input: { id: string; version: number }): Promise<boolean>;
export function submitPlan(
  db: Db,
  actorId: string | null,
  input: { id: string; version: number },
): Promise<boolean>;
export function decidePlan(
  db: Db,
  actorId: string | null,
  input: { id: string; version: number; status: string; reason: string },
): Promise<boolean>;

export function planDays(db: Db, planId: string): Promise<PlanDay[]>;
export function plannedDaysFor(
  db: Db,
  input: { repId: string; from: string; to: string },
): Promise<PlanDay[]>;
export function savePlanDay(
  db: Db,
  tenantId: string,
  input: {
    planId: string;
    workDate: string;
    beatId: string | null;
    town?: string;
    outletCount?: number;
    objective?: string;
    source?: 'AUTO' | 'MANUAL';
  },
): Promise<void>;

export function beatsForRep(
  db: Db,
  repId: string,
  from: string,
  to: string,
): Promise<PlannableBeatRow[]>;

export function autoFillPlan(
  db: Db,
  tenantId: string,
  plan: Plan,
): Promise<{
  written: number;
  kept: number;
  clashes: { date: string; kept: string; dropped: string }[];
  skipped: { date: string; reason: string; name: string }[];
}>;

export function checksFor(
  db: Db,
  plan: Plan,
  settings: unknown,
): Promise<{
  days: PlanDay[];
  holidays: { holiday_date: string; name: string }[];
  checks: { code: string; ok: boolean; message: string }[];
  ready: boolean;
  workingDays: number;
  fieldDays: number;
  fieldPct: number;
}>;

export function findChange(db: Db, id: string): Promise<DayChange | null>;
export function listChanges(
  db: Db,
  filters: { repId?: string | null; status?: string | null; limit?: number },
): Promise<{ items: DayChange[]; total: number }>;
export function requestDayChange(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    planId: string;
    repId: string;
    workDate: string;
    beatId: string | null;
    town?: string;
    outletCount?: number;
    objective?: string;
    reason: string;
    previous: {
      beat_id?: string | null;
      town?: string;
      outlet_count?: number;
      objective?: string;
    } | null;
  },
): Promise<string>;
export function decideDayChange(
  db: Db,
  actorId: string | null,
  tenantId: string,
  input: { change: DayChange; status: string; reason: string },
): Promise<boolean>;

export function visitsFor(
  db: Db,
  input: { repId: string; from: string; to: string },
): Promise<
  {
    id: string;
    customer_id: string;
    rep_id: string;
    visit_date: string;
    customer: string;
    customer_name: string;
    out_of_fence: boolean;
    distance_m: number | null;
  }[]
>;

export function adherenceFor(
  db: Db,
  input: { repId: string; from: string; to: string },
  settings: { timezone: string; plan_followed_pct: number | string },
): Promise<{
  rep: { id: string; code: string; name: string; shift: string };
  rows: AdherenceRow[];
  totals: Record<AdherenceStatus, number>;
  countedDays: number;
  score: number | null;
  plannedOutlets: number;
  visitedOutlets: number;
  coverage: number | null;
  followedPct: number;
} | null>;

export function planBoard(
  db: Db,
  input: { month: string; territoryId?: string | null; status?: string | null },
): Promise<{
  month: string;
  rows: any[];
  totals: Record<string, number>;
  missing: { rep_id: string; rep: string; rep_name: string; territory: string }[];
}>;
