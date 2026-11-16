type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Row = {
  id?: string;
  line?: number;
  value: any;
  errors: { column: string; message: string }[];
};
export function resolveReferences(db: Db, kind: string, rows: Row[]): Promise<Row[]>;
export function existingRecords(db: Db, kind: string, rows: Row[]): Promise<Map<string, any>>;
export function decideAction(
  kind: string,
  value: any,
  existing: any,
): 'create' | 'update' | 'unchanged';
export function upsertMasters(
  db: Db,
  kind: string,
  tenantId: string,
  values: any[],
): Promise<{ created: number; updated: number; unchanged: number }>;
export function listMasters(
  db: Db,
  kind: string,
  options: { q?: string; cursor?: string[] | null; limit?: number },
): Promise<{ items: any[]; nextCursor: string[] | null; total: number }>;
export function findMaster(db: Db, kind: string, id: string): Promise<any | null>;
export function updateMaster(
  db: Db,
  kind: string,
  id: string,
  value: any,
  active: boolean,
): Promise<void>;
export function removalBlockers(db: Db, kind: string, id: string): Promise<string[]>;
export function removeMaster(
  db: Db,
  kind: string,
  id: string,
  actorId: string | null,
  reason: string,
): Promise<boolean>;
