type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Problem = { column: string; message: string };
type Row = {
  id?: string;
  line?: number;
  value: any;
  errors: Problem[];
  existing?: any;
  action?: string;
};
type Page<C> = Promise<{ items: any[]; nextCursor: C | null }>;
type Kind = 'sales_orders' | 'purchase_orders';
export const ORDER_TABLES: Record<Kind, { table: string; lines: string; no: string; noun: string }>;
export function listStockLocations(db: Db, siteId: string): Promise<any[]>;
export function checkStockLocations(db: Db, rows: Row[], scope: Set<string> | null): Promise<Row[]>;
export function stockLocationAction(value: any, old: any): 'create' | 'update' | 'unchanged';
export function writeStockLocation(
  db: Db,
  tenantId: string,
  value: any,
  old: any,
  active?: boolean,
): Promise<string>;
export function stockInLocation(db: Db, locationId: string): Promise<number>;
export function checkMovements(
  db: Db,
  rows: Row[],
  scope: Set<string> | null,
  options: { today: string },
): Promise<Row[]>;
export function postMovements(
  db: Db,
  tenantId: string,
  actor: { id: string | null; subject: string | null } | null,
  values: any[],
  batchId?: string | null,
): Promise<{ id: string; movement_no: string }[]>;
export function movementDetail(db: Db, id: string): Promise<any | null>;
export function reversalFor(
  db: Db,
  original: any,
  reason: string,
  today: string,
): Promise<{ value?: any; error?: string }>;
export function listBalances(
  db: Db,
  siteId: string,
  options: { q?: string; locationId?: string | null; cursor?: string[] | null; limit?: number },
): Page<string[]>;
export function listMovements(
  db: Db,
  siteId: string,
  options: { q?: string; cursor?: string | null; limit?: number },
): Page<string>;
export function nextOrderNo(db: Db, kind: Kind): Promise<string>;
export function checkOrders(
  db: Db,
  kind: Kind,
  docs: Row[],
  scope: Set<string> | null,
): Promise<Row[]>;
export function orderDetail(db: Db, kind: Kind, id: string): Promise<any | null>;
export function orderAction(
  db: Db,
  kind: Kind,
  doc: Row,
): Promise<'create' | 'update' | 'unchanged'>;
export function writeOrder(db: Db, kind: Kind, tenantId: string, doc: Row): Promise<string>;
export function cancelOrder(db: Db, kind: Kind, id: string, reason: string): Promise<void>;
export function listOrders(
  db: Db,
  kind: Kind,
  siteId: string,
  options: { q?: string; status?: string | null; cursor?: string[] | null; limit?: number },
): Page<string[]>;
export function checkDemandHistory(
  db: Db,
  rows: Row[],
  scope: Set<string> | null,
  options: { today: string },
): Promise<Row[]>;
export function writeDemandHistory(
  db: Db,
  tenantId: string,
  values: any[],
): Promise<{ created: number; updated: number; unchanged: number }>;
export function listDemandHistory(
  db: Db,
  siteId: string,
  options: { q?: string; cursor?: string[] | null; limit?: number },
): Page<string[]>;
export function demandStockReadiness(db: Db, siteId: string, today: string): Promise<any[]>;
export function conversionFactors(
  db: Db,
  itemIds: string[],
): Promise<(from: string, to: string, itemId: string) => string | null>;
