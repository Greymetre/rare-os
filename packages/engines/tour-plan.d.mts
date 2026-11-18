import type { DayVerdict, Holiday, Weekday } from './attendance.d.mts';

export type PlanStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'SENT_BACK';
export type DaySource = 'AUTO' | 'MANUAL';
export type ChangeStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type AdherenceStatus =
  | 'FOLLOWED'
  | 'PARTIAL'
  | 'DEVIATED'
  | 'MISSED'
  | 'UNPLANNED'
  | 'LEAVE'
  | 'HOLIDAY'
  | 'WEEK_OFF'
  | 'NOT_PLANNED';

// A beat as the auto-fill needs to see it: its run pattern, the window the rep holds it for,
// and what a day on it is worth.
export type PlannableBeat = {
  id: string;
  code?: string;
  town?: string;
  outlet_count?: number | string;
  objective?: string;
  frequency?: 'WEEKLY' | 'FORTNIGHTLY';
  run_days?: string;
  week_parity?: 'ALL' | 'ODD' | 'EVEN';
  from_date?: string | null;
  to_date?: string | null;
};

export type PlannedDay = {
  work_date: string;
  beat_id: string | null;
  beat?: string;
  town?: string;
  outlet_count?: number | string;
  objective?: string;
  source?: DaySource;
  // The stops the round asks for, when the caller has read them.
  outlets?: string[];
};

export type Visit = {
  customer_id: string;
  visit_date: string;
  rep_id?: string;
  out_of_fence?: boolean;
};

export type AdherenceRow = {
  date: string;
  status: AdherenceStatus;
  beat: string;
  town: string;
  planned: number;
  visited: number;
  offPlan: number;
  percent: number | null;
  leave?: string;
};

export type PlanSettings = {
  plan_due_day?: number | string;
  plan_max_outlets?: number | string;
  plan_field_days_pct?: number | string;
  plan_followed_pct?: number | string;
};

export const WEEK_DAYS: Weekday[];
export const PLAN_STATUSES: PlanStatus[];
export const DAY_SOURCES: DaySource[];
export const CHANGE_STATUSES: ChangeStatus[];
export const ADHERENCE_STATUSES: AdherenceStatus[];
export const COUNTED_STATUSES: AdherenceStatus[];

export function monthSpan(month: unknown): { from: string; to: string } | null;
export function monthDates(month: unknown): string[];
export function isoWeek(date: unknown): number | null;
export function weekParityOf(date: unknown): 'ODD' | 'EVEN' | null;
export function beatRunsOn(beat: PlannableBeat, date: string): boolean;

export function autoFill(input: {
  month: string;
  beats?: PlannableBeat[];
  holidays?: Holiday[];
  weekOff?: string;
}): {
  days: PlannedDay[];
  clashes: { date: string; kept: string; dropped: string }[];
  skipped: { date: string; reason: 'HOLIDAY' | 'WEEK_OFF'; name: string }[];
};

export function planChecks(input: {
  month: string;
  days?: PlannedDay[];
  holidays?: Holiday[];
  weekOff?: string;
  settings?: PlanSettings;
}): {
  checks: { code: string; ok: boolean; message: string }[];
  ready: boolean;
  workingDays: number;
  fieldDays: number;
  fieldPct: number;
};

export function dayAdherence(input: {
  date: string;
  planned?: PlannedDay | null;
  visits?: Visit[];
  verdict?: DayVerdict | null;
  followedPct: number | string;
}): AdherenceRow;

export function planAdherence(input: {
  from: string;
  to: string;
  days?: PlannedDay[];
  visits?: Visit[];
  register?: DayVerdict[];
  settings?: PlanSettings;
  followedPct?: number | string;
}): {
  rows: AdherenceRow[];
  totals: Record<AdherenceStatus, number>;
  countedDays: number;
  score: number | null;
  plannedOutlets: number;
  visitedOutlets: number;
  coverage: number | null;
  followedPct: number;
};
