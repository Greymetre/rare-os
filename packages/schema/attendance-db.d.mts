import type { DayVerdict, DayStatus, Shift } from '../engines/attendance.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export type ReachSettings = {
  gps_verified_m: number;
  duplicate_within_m: number;
  retag_approval_m: number;
  kyc_reminder_days: number;
  attendance_fence_m: number;
  absent_after_minutes: number;
  selfie_required: boolean;
  timezone: string;
  version: number;
};

export type Rep = {
  id: string;
  code: string;
  name: string;
  shift_id: string | null;
  shift: Shift | null;
  shift_code: string;
  territory_id: string;
};

export type Place = {
  latitude?: number | null;
  longitude?: number | null;
  accuracy_m?: number | null;
  source?: string;
  in_fence?: boolean | null;
};

export type Day = {
  id: string;
  version: number;
  work_date: string;
  work_type_id: string;
  start_time: string | null;
  end_time: string | null;
  start_file_id: string | null;
  start_in_fence: boolean | null;
  counts_present: boolean;
  work_type: string;
  note: string;
};

export function attendanceSettings(db: Db): Promise<ReachSettings>;
export function findRep(db: Db, repId: string): Promise<Rep | null>;
export function repForUser(db: Db, userId: string): Promise<Rep | null>;
export function todayFor(db: Db, settings: { timezone: string }): Promise<string>;
export function findDay(
  db: Db,
  repId: string,
  workDate: string,
  settings: { timezone: string },
): Promise<Day | null>;

export function inFence(input: {
  anchor: { latitude: number | string; longitude: number | string } | null;
  at: { latitude?: number | null; longitude?: number | null };
  settings: { attendance_fence_m: number };
}): boolean | null;

export function startDay(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    repId: string;
    workDate: string;
    workTypeId: string;
    at: Place;
    fileId?: string | null;
    note?: string;
  },
): Promise<string>;

export function endDay(
  db: Db,
  input: { dayId: string; version: number; at: Place },
): Promise<boolean>;

export function registerFor(
  db: Db,
  input: { repId: string; from: string; to: string },
  settings: { timezone: string },
): Promise<{
  rep: { id: string; code: string; name: string; shift: string };
  rows: DayVerdict[];
  totals: Record<DayStatus, number>;
  open: string[];
  paidDays: number;
} | null>;

export function dayBoard(
  db: Db,
  input: { date: string; territoryId?: string | null },
  settings: { timezone: string; absent_after_minutes: number },
): Promise<{ date: string; rows: any[]; totals: Record<string, number>; remind?: number }>;

export function leaveBalance(
  db: Db,
  repId: string,
  year: number,
): Promise<
  {
    id: string;
    code: string;
    name: string;
    paid: boolean;
    annual_quota: number;
    taken: number;
    left: number;
  }[]
>;

export function overlappingLeave(
  db: Db,
  input: { repId: string; from: string; to: string; exceptId?: string | null },
): Promise<{ from_date: string; to_date: string } | null>;

export function applyLeave(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    repId: string;
    leaveTypeId: string;
    from: string;
    to: string;
    halfDay: boolean;
    reason: string;
  },
): Promise<string>;

export function decideLeave(
  db: Db,
  actorId: string | null,
  input: { id: string; version: number; status: string; reason: string },
): Promise<boolean>;

export function cancelLeave(db: Db, input: { id: string; version: number }): Promise<boolean>;

export function listLeave(
  db: Db,
  filters: { repId?: string | null; status?: string | null; limit?: number },
): Promise<{ items: any[]; total: number }>;

export function requestEdit(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    repId: string;
    workDate: string;
    startAt: unknown;
    endAt: unknown;
    reason: string;
    previous: { started_at?: unknown; ended_at?: unknown } | null;
  },
): Promise<string>;

export function decideEdit(
  db: Db,
  actorId: string | null,
  tenantId: string,
  input: { edit: any; status: string; reason: string; workTypeId?: string },
): Promise<boolean>;

export function findEdit(db: Db, id: string): Promise<any | null>;

export function listEdits(
  db: Db,
  filters: { repId?: string | null; status?: string | null; limit?: number },
  settings: { timezone: string },
): Promise<{ items: any[]; total: number }>;

export function payrollRows(
  db: Db,
  input: { from: string; to: string; territoryId?: string | null },
  settings: { timezone: string },
): Promise<Record<string, string | number>[]>;

export const PAYROLL_COLUMNS: string[];
