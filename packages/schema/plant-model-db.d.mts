type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Problem = { column: string; message: string };
type Doc = { id?: string; value: any; errors: Problem[]; existing?: any; line?: number };
export function plantsByCode(db: Db, codes: string[]): Promise<Map<string, any>>;
export function resolvePlant(
  map: Map<string, any>,
  code: string,
  scope: Set<string> | null,
  errors: Problem[],
): any | null;
export function itemsByCode(db: Db, codes: string[]): Promise<Map<string, any>>;
export function plantScope(db: Db, actorId: string | null): Promise<Set<string> | null>;
export function calendarDetail(db: Db, id: string): Promise<any | null>;
export function listCalendars(db: Db, siteId: string): Promise<any[]>;
export function saveCalendar(
  db: Db,
  tenantId: string,
  siteId: string,
  value: any,
  existing: any,
): Promise<{ id: string; errors: Problem[] }>;
export function listResources(db: Db, siteId: string): Promise<any[]>;
export function checkResources(db: Db, rows: Doc[], scope: Set<string> | null): Promise<Doc[]>;
export function resourceAction(value: any, old: any): 'create' | 'update' | 'unchanged';
export function writeResource(
  db: Db,
  tenantId: string,
  value: any,
  old: any,
  active?: boolean,
): Promise<string>;
export function checkBoms(db: Db, docs: Doc[]): Promise<Doc[]>;
export function bomDetail(db: Db, id: string): Promise<any | null>;
export function bomAction(db: Db, doc: Doc): Promise<'create' | 'update' | 'unchanged'>;
export function writeBom(db: Db, tenantId: string, doc: Doc): Promise<string>;
export function listBoms(
  db: Db,
  options: { q?: string; cursor?: string[] | null; limit?: number },
): Promise<{ items: any[]; nextCursor: string[] | null }>;
export function checkRoutings(db: Db, docs: Doc[], scope: Set<string> | null): Promise<Doc[]>;
export function routingDetail(db: Db, id: string): Promise<any | null>;
export function routingAction(db: Db, doc: Doc): Promise<'create' | 'update' | 'unchanged'>;
export function writeRouting(db: Db, tenantId: string, doc: Doc): Promise<string>;
export function listRoutings(
  db: Db,
  siteId: string,
  options: { q?: string; cursor?: string[] | null; limit?: number },
): Promise<{ items: any[]; nextCursor: string[] | null }>;
export function plantReadiness(db: Db, siteId: string, today: string): Promise<any[]>;
