import type { FormField, Verdict } from '../engines/visit.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export type VisitSettings = {
  visit_dedupe_minutes: number;
  timezone: string;
  version: number;
  [key: string]: unknown;
};

export type CallableCustomer = {
  id: string;
  code: string;
  name: string;
  town: string;
  status: string;
  beat_id: string | null;
  beat: string | null;
  latitude: string | null;
  longitude: string | null;
  type_id: string;
  type: string;
  type_name: string;
  checkin_radius_m: number;
  min_visit_minutes: number;
  kyc_before_order: boolean;
};

export type Visit = Verdict & {
  id: string;
  version: number;
  rep_id: string;
  rep: string;
  rep_name: string;
  customer_id: string;
  customer: string;
  customer_name: string;
  town: string;
  type_id: string;
  type: string;
  beat: string;
  beat_id: string | null;
  visit_date: string;
  checked_in_at: string;
  checked_out_at: string | null;
  client_ref: string;
  report: Record<string, unknown>;
  note: string;
};

export type DaySummary = {
  visits: number;
  totals: Record<string, number>;
  outOfFence: number;
  incomplete: number;
  minutes: number;
  averageMinutes: number | null;
};

export function visitSettings(db: Db): Promise<VisitSettings>;
export function visitFormFor(db: Db, typeId: string): Promise<FormField[]>;
export function callableCustomer(db: Db, customerId: string): Promise<CallableCustomer | null>;

export function findVisit(db: Db, visitId: string): Promise<(Visit & { form: FormField[] }) | null>;

export function recentVisits(
  db: Db,
  input: { repId: string; customerId: string; workDate: string },
): Promise<
  { id: string; client_ref: string; checked_in_at: string; checked_out_at: string | null }[]
>;

export function listVisits(
  db: Db,
  filters: {
    repId?: string | null;
    customerId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  },
): Promise<{ items: Visit[]; total: number; summary: DaySummary }>;

export function checkIn(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    repId: string;
    customer: CallableCustomer;
    workDate: string;
    at: {
      latitude?: number | null;
      longitude?: number | null;
      accuracy_m?: number | null;
      source?: string;
    };
    clientRef?: string;
    fileId?: string | null;
    note?: string;
    beatId?: string | null;
  },
): Promise<{ id: string; distance_m: number | null; out_of_fence: boolean; known: boolean }>;

export function existingVisit(
  db: Db,
  input: {
    repId: string;
    customerId: string;
    workDate: string;
    clientRef: string;
    settings: { visit_dedupe_minutes: number | string };
  },
): Promise<(Visit & { form: FormField[] }) | null>;

export function checkReport(
  db: Db,
  typeId: string,
  raw: Record<string, unknown>,
): Promise<{
  form: FormField[];
  value: Record<string, unknown>;
  errors: { column: string; message: string }[];
}>;

export function checkOut(
  db: Db,
  input: {
    visitId: string;
    version: number;
    at: {
      latitude?: number | null;
      longitude?: number | null;
      accuracy_m?: number | null;
      source?: string;
    };
    report: Record<string, unknown>;
  },
): Promise<boolean>;

export function amendReport(
  db: Db,
  input: { visitId: string; version: number; report: Record<string, unknown> },
): Promise<boolean>;

export function plannedStops(db: Db, input: { repId: string; workDate: string }): Promise<any[]>;

export function repDay(
  db: Db,
  input: { repId: string; workDate: string },
): Promise<{
  date: string;
  stops: any[];
  done: number;
  planned: number;
  unplanned: number;
  open: any | null;
  visits: Visit[];
  summary: DaySummary;
}>;

export function visitBoard(
  db: Db,
  input: { workDate: string; territoryId?: string | null },
): Promise<{ date: string; reps: any[]; summary: DaySummary }>;

export const VISIT_COLUMNS_CSV: string[];
export function visitCsvRows(
  db: Db,
  filters: {
    repId?: string | null;
    customerId?: string | null;
    from?: string | null;
    to?: string | null;
  },
): Promise<Record<string, string | number>[]>;
