export type OrderStatus = 'DRAFT' | 'HELD' | 'PLACED' | 'ROUTED' | 'CANCELLED';
export type InvoiceStatus = 'OPEN' | 'PART_PAID' | 'PAID' | 'CANCELLED';
export type KycStatus = 'MISSING' | 'PENDING' | 'VERIFIED' | 'REJECTED';
export type PaymentMode = 'CASH' | 'CHEQUE' | 'UPI' | 'NEFT' | 'ADJUSTMENT';
export type HoldReason = 'OVER_LIMIT' | 'OVERDUE' | 'KYC' | 'APPROVAL' | 'INACTIVE';

export type Rate = {
  item_id: string;
  rate: number | string;
  gst_pct?: number | string;
  from_date?: string | null;
  to_date?: string | null;
};

export type Scheme = {
  code?: string;
  item_id: string;
  min_quantity: number | string;
  discount_pct?: number | string;
  free_quantity?: number | string;
  from_date?: string | null;
  to_date?: string | null;
};

export type Line = {
  units: number;
  rate: number;
  gross: number;
  discount_pct: number;
  discount: number;
  free_units: number;
  taxable: number;
  gst_pct: number;
  gst: number;
  total: number;
  scheme: string;
};

export type Invoice = {
  id?: string;
  invoice_date: string;
  amount: number | string;
  paid?: number | string;
  status?: InvoiceStatus;
  lines?: { item_id: string; item?: string; item_name?: string; units?: number; total?: number }[];
};

export type Receipt = {
  id?: string;
  amount: number | string;
  invoice_id?: string | null;
  status?: string;
};

export type AgedInvoice = Invoice & {
  applied: number;
  outstanding: number;
  age_days: number | null;
  status: InvoiceStatus;
};

export type Credit = {
  limit: number | null;
  creditDays: number | null;
  holdDays: number | null;
  outstanding: number;
  orderValue: number;
  exposure: number;
  available: number | null;
  oldestDays: number | null;
  hold: boolean;
  reasons: HoldReason[];
  message: string;
};

export const ORDER_STATUSES: OrderStatus[];
export const INVOICE_STATUSES: InvoiceStatus[];
export const KYC_STATUSES: KycStatus[];
export const PAYMENT_MODES: PaymentMode[];
export const HOLD_REASONS: Record<HoldReason, string>;
export const AGEING_BUCKETS: number[];

export function money(value: unknown): number;

export function rateFor(input: { rates?: Rate[]; itemId: string; date: string }): Rate | null;
export function schemeFor(input: {
  schemes?: Scheme[];
  itemId: string;
  quantity: number | string;
  date: string;
}): Scheme | null;

export function lineAmount(input: {
  quantity: number | string;
  rate: number | string;
  gstPct?: number | string;
  scheme?: Scheme | null;
}): Line;

export function orderTotals(lines?: Partial<Line>[]): {
  lines: number;
  units: number;
  free_units: number;
  gross: number;
  discount: number;
  taxable: number;
  gst: number;
  total: number;
};

export function applyReceipts(input: {
  invoices?: Invoice[];
  receipts?: Receipt[];
  asOf: string;
}): { rows: AgedInvoice[]; unapplied: number };

export function ageing(input: {
  invoices?: Invoice[];
  receipts?: Receipt[];
  asOf: string;
  buckets?: number[];
}): {
  rows: AgedInvoice[];
  open: AgedInvoice[];
  labels: string[];
  totals: Record<string, number>;
  outstanding: number;
  unapplied: number;
  oldestDays: number | null;
  invoices: number;
};

export function dso(input: {
  outstanding: number | string;
  sales: number | string;
  days?: number;
}): number | null;

export function creditState(input: {
  limit?: number | string | null;
  creditDays?: number | string | null;
  holdDays?: number | string | null;
  outstanding?: number | string;
  oldestDays?: number | string | null;
  orderValue?: number | string;
  kyc?: KycStatus | null;
  customerStatus?: string;
  kycRequired?: boolean;
}): Credit;

export function kycState(input: {
  required?: { id?: string; code: string; name: string; requirement?: string }[];
  documents?: {
    kyc_type_id?: string;
    kyc_type?: string;
    status: KycStatus;
    file_id?: string | null;
    number?: string;
    decided_by?: string;
    decision_reason?: string;
    uploaded_at?: string | null;
  }[];
}): {
  rows: any[];
  status: KycStatus;
  missing: string[];
  pending: string[];
  rejected: string[];
  asked: number;
  required: number;
};

export function previousMonth(month: unknown): string | null;
export function financialYearStart(date: unknown, startMonth?: number): number | null;

export function salesSummary(input: {
  invoices?: Invoice[];
  asOf: string;
  fyStartMonth?: number;
  topCount?: number;
}): {
  thisMonth: { month: string; amount: number; invoices: number };
  lastMonth: { month: string; amount: number; invoices: number } | null;
  growthPct: number | null;
  financialYear: { from: string; amount: number };
  topItems: { item_id: string; code: string; name: string; units: number; amount: number }[];
};

export function timeline(
  events?: { at: string; kind?: string; [key: string]: unknown }[],
  limit?: number,
): { at: string; kind?: string; [key: string]: unknown }[];
