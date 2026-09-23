type Db = import('pg').PoolClient;
export const cycleTimeAuditOptions: { minCompletions: number; driftPct: number };
export function makeRecommendation(db: Db, siteId: string, itemId: string): Promise<any>;
export function releaseMakeOrder(
  db: Db,
  actor: any,
  siteId: string,
  rec: any,
  decisionNo: number,
): Promise<string>;
export function workOrder(db: Db, siteId: string, orderNo: string): Promise<any | null>;
export function releaseWork(
  db: Db,
  actor: any,
  siteId: string,
  order: any,
  today: string,
): Promise<{ release: number; planned: number | null }>;
export function completeWork(db: Db, actor: any, order: any, value: any): Promise<void>;
export function listExecution(
  db: Db,
  siteId: string,
  bufferPct: number,
  limit?: number,
): Promise<any>;
export function logDowntime(
  db: Db,
  actor: any,
  siteId: string,
  value: any,
): Promise<{ id: string; no: number }>;
export function listDowntime(db: Db, siteId: string, limit?: number): Promise<any[]>;
export function atRiskOrders(db: Db, siteId: string): Promise<any>;
export function routingStandards(db: Db, siteId: string, today: string): Promise<Map<string, any>>;
export function cycleTimeAudit(db: Db, siteId: string, today: string, options?: any): Promise<any>;
export function adoptCycleTime(
  db: Db,
  actor: any,
  siteId: string,
  row: any,
  today: string,
): Promise<any>;
