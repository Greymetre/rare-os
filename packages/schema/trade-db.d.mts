import type {
  AgedInvoice,
  Credit,
  InvoiceStatus,
  KycStatus,
  Line,
  OrderStatus,
} from '../engines/trade.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export type TradeSettings = {
  ageing_buckets: string;
  fy_start_month: number;
  dso_window_days: number;
  timezone: string;
  version: number;
  [key: string]: unknown;
};

export type Terms = {
  credit_limit: number | null;
  credit_days: number | null;
  hold_days: number | null;
  from: { credit_limit: string; credit_days: string; hold_days: string };
  kyc_before_order: boolean;
  order_route: 'ERP' | 'DISTRIBUTOR' | 'NONE';
};

export type TradeCustomerRow = {
  id: string;
  version: number;
  code: string;
  name: string;
  status: string;
  town: string;
  phone: string;
  attrs: Record<string, unknown>;
  type_id: string;
  type: string;
  type_name: string;
  beat: string;
  territory: string;
  rep: string;
  buys_from: string;
  sales_customer: string;
  latitude: string | null;
  longitude: string | null;
  geo_verified: boolean;
  terms: Terms;
  [key: string]: unknown;
};

export type OrderRow = {
  id: string;
  version: number;
  order_no: string;
  status: OrderStatus;
  route: string;
  external_ref: string;
  hold_reasons: string[];
  gross: number;
  discount: number;
  taxable: number;
  gst: number;
  total: number;
  order_date: string;
  customer_id: string;
  customer: string;
  customer_name: string;
  rep_id: string;
  rep: string;
  type: string;
  release_reason: string;
  lines: (Line & { line_no: number; item_id: string; item: string; item_name: string })[];
  [key: string]: unknown;
};

export type Outstanding = {
  rows: AgedInvoice[];
  open: AgedInvoice[];
  labels: string[];
  totals: Record<string, number>;
  outstanding: number;
  unapplied: number;
  oldestDays: number | null;
  invoices: number;
  receipts: any[];
};

export type Kyc = {
  rows: any[];
  status: KycStatus;
  missing: string[];
  pending: string[];
  rejected: string[];
  asked: number;
  required: number;
  documents: any[];
};

export function tradeSettings(db: Db): Promise<TradeSettings>;
export function bucketsOf(settings: { ageing_buckets?: string }): number[];

export function tradeCustomer(db: Db, customerId: string): Promise<TradeCustomerRow | null>;
export function saveTerms(
  db: Db,
  input: {
    customerId: string;
    version: number;
    limit: number | null;
    days: number | null;
    hold: number | null;
  },
): Promise<boolean>;

export function kycRequired(
  db: Db,
  typeId: string,
): Promise<
  {
    id: string;
    code: string;
    name: string;
    number_check: string;
    valid_months: number | null;
    requirement: string;
  }[]
>;
export function kycDocuments(db: Db, customerId: string): Promise<any[]>;
export function kycFor(db: Db, customer: { id: string; type_id: string }): Promise<Kyc>;
export function uploadKyc(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    customerId: string;
    kycTypeId: string;
    fileId?: string | null;
    number?: string;
    validTo?: string | null;
    actorId?: string | null;
  },
): Promise<string>;
export function findKycDocument(
  db: Db,
  id: string,
): Promise<{
  id: string;
  version: number;
  status: KycStatus;
  customer_id: string;
  kyc_type_id: string;
  kyc_type: string;
  customer: string;
} | null>;
export function decideKyc(
  db: Db,
  actorId: string | null,
  input: { id: string; version: number; status: string; reason: string },
): Promise<boolean>;
export function listKyc(
  db: Db,
  filters: { status?: string | null; limit?: number },
): Promise<{ items: any[]; total: number }>;

export function ratesFor(db: Db, typeId: string, date: string): Promise<any[]>;
export function schemesFor(db: Db, date: string): Promise<any[]>;
export function priceBasket(
  db: Db,
  input: { typeId: string; date: string; lines: { item_id: string; units: number }[] },
): Promise<{
  lines: (Line & { item_id: string; item: string; item_name: string; scheme_id: string | null })[];
  totals: {
    lines: number;
    units: number;
    free_units: number;
    gross: number;
    discount: number;
    taxable: number;
    gst: number;
    total: number;
  };
  missing: string[];
}>;

export function invoicesFor(db: Db, customerId: string): Promise<any[]>;
export function receiptsFor(db: Db, customerId: string): Promise<any[]>;
export function outstandingFor(
  db: Db,
  customerId: string,
  asOf: string,
  settings: unknown,
): Promise<Outstanding>;

export function creditFor(
  db: Db,
  customer: TradeCustomerRow,
  input: { asOf: string; orderValue?: number; settings: unknown },
): Promise<{ credit: Credit; outstanding: Outstanding; kyc: Kyc }>;

export function orderLines(db: Db, orderId: string): Promise<any[]>;
export function findOrder(db: Db, orderId: string): Promise<OrderRow | null>;
export function createOrder(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    orderNo: string;
    customerId: string;
    repId: string;
    visitId?: string | null;
    orderDate: string;
    route?: string;
    note?: string;
    priced: { lines: any[]; totals: any };
    credit: Credit;
  },
): Promise<string>;
export function releaseOrder(
  db: Db,
  actorId: string | null,
  input: { id: string; version: number; reason: string },
): Promise<boolean>;
export function cancelOrder(
  db: Db,
  input: { id: string; version: number; reason: string },
): Promise<boolean>;
export function routeOrder(
  db: Db,
  input: { id: string; version: number; externalRef?: string },
): Promise<boolean>;
export function listOrders(
  db: Db,
  filters: {
    customerId?: string | null;
    repId?: string | null;
    status?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  },
): Promise<{ items: OrderRow[]; total: number; value: number }>;

export function nextInvoiceNo(
  db: Db,
  tenantId: string,
  input: { prefix: string; fy: number | null },
): Promise<{ series_id: string; number: string; issued: number }>;
export function raiseInvoiceFromOrder(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    order: OrderRow;
    series: { series_id: string; number: string };
    invoiceDate: string;
    dueDate?: string | null;
    actorId?: string | null;
    note?: string;
  },
): Promise<string>;
export function invoiceForOrder(
  db: Db,
  orderId: string,
): Promise<{ id: string; invoice_no: string; status: string } | null>;
export function recordInvoice(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    invoiceNo: string;
    customerId: string;
    orderId?: string | null;
    invoiceDate: string;
    dueDate?: string | null;
    amount: number;
    taxable?: number | null;
    gst?: number | null;
    source?: string;
    note?: string;
    lines?: {
      item_id: string;
      units: number;
      total: number;
      rate?: number | null;
      gst_pct?: number | null;
      taxable?: number | null;
      gst?: number | null;
    }[];
  },
): Promise<string>;
export function findInvoice(
  db: Db,
  id: string,
): Promise<{
  id: string;
  version: number;
  invoice_no: string;
  status: InvoiceStatus | 'CANCELLED';
  amount: number;
  taxable: number | null;
  gst: number | null;
  source: string;
  series_id: string | null;
  order_id: string | null;
  customer_id: string;
  customer: string;
  invoice_date: string;
} | null>;
export function cancelInvoice(
  db: Db,
  input: { id: string; version: number; reason: string },
): Promise<boolean>;

export function recordReceipt(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    receiptNo: string;
    customerId: string;
    repId?: string | null;
    invoiceId?: string | null;
    receivedOn: string;
    amount: number;
    mode: string;
    reference?: string;
    fileId?: string | null;
    at?: { latitude: number | null; longitude: number | null };
    note?: string;
  },
): Promise<string>;
export function findReceipt(
  db: Db,
  id: string,
): Promise<{
  id: string;
  version: number;
  receipt_no: string;
  status: string;
  amount: number;
  customer_id: string;
  rep_id: string | null;
  customer: string;
} | null>;
export function cancelReceipt(
  db: Db,
  input: { id: string; version: number; reason: string },
): Promise<boolean>;

export function salesFor(
  db: Db,
  customerId: string,
  asOf: string,
  settings: unknown,
): Promise<{
  thisMonth: { month: string; amount: number; invoices: number };
  lastMonth: { month: string; amount: number; invoices: number } | null;
  growthPct: number | null;
  financialYear: { from: string; amount: number };
  topItems: any[];
  dsoWindow: { from: string; to: string; days: number; sales: number };
}>;

export function timelineFor(db: Db, customerId: string, limit?: number): Promise<any[]>;

export function customer360(
  db: Db,
  customerId: string,
  input: { asOf: string; settings: unknown },
): Promise<{
  customer: TradeCustomerRow;
  credit: Credit;
  outstanding: Outstanding;
  kyc: Kyc;
  sales: any;
  dso: number | null;
  visits: { visits: number; last_visit: string | null; flagged: number };
  timeline: any[];
} | null>;
