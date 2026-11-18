export type DayStatus =
  | 'HOLIDAY'
  | 'WEEK_OFF'
  | 'LEAVE'
  | 'PRESENT'
  | 'LATE'
  | 'HALF_DAY'
  | 'OPEN'
  | 'ABSENT';

export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export type Shift = {
  starts_at: string;
  ends_at?: string;
  grace_minutes?: number | string;
  half_day_minutes?: number | string;
  min_minutes?: number | string;
  week_off?: string;
};

export type Punch = {
  work_date?: string;
  start_time: string | null;
  end_time?: string | null;
  counts_present?: boolean;
};

export type LeaveSpell = {
  from_date: string;
  to_date: string;
  status: string;
  leave_type?: string;
  paid?: boolean;
  half_day?: boolean;
};

export type Holiday = { holiday_date?: string; name?: string };

export type DayVerdict = {
  date: string;
  status: DayStatus;
  late: boolean | null;
  workedMinutes: number | null;
  holiday: string | null;
  leave: string | null;
};

export const WEEK_DAYS: Weekday[];
export const DAY_STATUSES: DayStatus[];

export function minutesOfDay(clock: unknown): number | null;
export function workedMinutes(start: unknown, end: unknown): number | null;
export function weekdayOf(date: unknown): Weekday | null;
export function datesBetween(from: unknown, to: unknown): string[];

export function dayStatus(input: {
  date: string;
  punch?: Punch | null;
  shift?: Shift | null;
  holiday?: Holiday | null;
  leave?: LeaveSpell | null;
}): DayVerdict;

export function monthlyRegister(input: {
  from: string;
  to: string;
  punches?: Punch[];
  shift?: Shift | null;
  holidays?: Holiday[];
  leaves?: LeaveSpell[];
}): {
  rows: DayVerdict[];
  totals: Record<DayStatus, number>;
  open: string[];
  paidDays: number;
};
