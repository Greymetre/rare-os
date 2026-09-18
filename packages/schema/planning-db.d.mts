type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Problem = { column: string; message: string };
type Row = { line?: number; value: any; errors: Problem[]; existing?: any };
export function listProfiles(db: Db): Promise<any[]>;
export function profileByCode(db: Db, code: string): Promise<any | null>;
export function writeProfile(
  db: Db,
  tenantId: string,
  value: any,
  old: any,
  active?: boolean,
): Promise<string>;
export function checkBufferSettings(db: Db, rows: Row[], scope: Set<string> | null): Promise<Row[]>;
export function bufferSettingAction(value: any, old: any): 'create' | 'update' | 'unchanged';
export function writeBufferSettings(db: Db, tenantId: string, values: any[]): Promise<void>;
export function listBufferSettings(
  db: Db,
  siteId: string,
  options: { q?: string; cursor?: string[] | null; limit?: number },
): Promise<{ items: any[]; nextCursor: string[] | null }>;
export function queueRun(
  db: Db,
  tenantId: string,
  options: { trigger: 'auto' | 'manual'; actor?: any },
): Promise<{ run: any; created: boolean }>;
export function runPlanning(
  db: Db,
  runId: string,
): Promise<{ promoted: boolean; summary: any } | null>;
export function failRun(db: Db, runId: string, message: string): Promise<void>;
export function planningStatus(db: Db): Promise<any>;
export function listBoard(
  db: Db,
  siteId: string,
  options: { q?: string; zone?: string | null; cursor?: string[] | null; limit?: number },
): Promise<{
  runId: string | null;
  items: any[];
  counts: Record<string, number>;
  nextCursor: string[] | null;
}>;
export function bufferReadiness(db: Db, siteId: string): Promise<any>;
