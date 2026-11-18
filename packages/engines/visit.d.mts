export type VisitStatus = 'OPEN' | 'SHORT' | 'DONE';

export type FormField = {
  field_key: string;
  label: string;
  section: string;
  order: number;
  input: string;
  help: string;
  required: boolean;
  choices: string[];
  descriptor: Record<string, unknown>;
};

export type VisitRow = {
  id?: string;
  customer_id?: string;
  customer?: string;
  customer_name?: string;
  checked_in_at: string;
  checked_out_at?: string | null;
  client_ref?: string;
  report?: Record<string, unknown>;
  out_of_fence?: boolean;
  distance_m?: number | string | null;
};

export type Verdict = {
  status: VisitStatus;
  minutes: number | null;
  missing: string[];
  report_complete: boolean;
  out_of_fence: boolean;
  distance_m: number | null;
};

export const VISIT_STATUSES: VisitStatus[];

export function fenceVerdict(input: {
  customer: { latitude?: number | string | null; longitude?: number | string | null } | null;
  at: { latitude?: number | string | null; longitude?: number | string | null } | null;
  radius: number | string;
}): { distance_m: number | null; out_of_fence: boolean; known: boolean };

export function duplicateOf(input: {
  candidates?: VisitRow[];
  clientRef?: string;
  at?: string;
  withinMinutes?: number | string;
}): VisitRow | null;

export function stayMinutes(checkedIn: unknown, checkedOut: unknown): number | null;
export function missingAnswers(form?: FormField[], report?: Record<string, unknown>): string[];

export function visitVerdict(input: {
  visit: VisitRow;
  form?: FormField[];
  minMinutes?: number | string;
}): Verdict;

export function daySummary(rows?: (Verdict & Record<string, unknown>)[]): {
  visits: number;
  totals: Record<string, number>;
  outOfFence: number;
  incomplete: number;
  minutes: number;
  averageMinutes: number | null;
};

export function fieldDay(input: {
  stops?: { customer_id: string; code?: string; name?: string; sequence?: number | null }[];
  visits?: (VisitRow & Verdict)[];
}): {
  stops: any[];
  done: number;
  planned: number;
  unplanned: number;
  open: any | null;
};
