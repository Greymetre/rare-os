type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
export const PLANT_PLANNING_DEFAULTS: any;
export function loadPlantModel(db: Db, today: string): Promise<Map<string, any>>;
export function plantLeadTimes(
  plant: any,
  settings: any[],
  adu: Map<string, number>,
): Map<string, any>;
export function scheduleSites(
  db: Db,
  run: any,
  today: string,
  plants: Map<string, any>,
  inputs: any,
): Promise<any>;
export function prunedSchedules(db: Db, runIds: string[]): Promise<void>;
export function scheduleRun(
  db: Db,
  siteId: string,
  view: string,
): Promise<{ runId: string | null; header: any; publication: any }>;
export function listSchedule(
  db: Db,
  siteId: string,
  runId: string,
  options: { q?: string; filter?: string | null; cursor?: string | null; limit?: number },
): Promise<{ items: any[]; nextCursor: string | null }>;
export function scheduleResources(db: Db, siteId: string, runId: string): Promise<any[]>;
export function scheduleBlocks(
  db: Db,
  siteId: string,
  runId: string,
  options: {
    dayMinutes: number;
    from: number;
    to: number;
    resourceId?: string | null;
    limit?: number;
  },
): Promise<{ blocks: any[]; truncated: boolean }>;
export function leadTimeReality(
  db: Db,
  siteId: string,
  itemId: string,
  today: string,
): Promise<any | null>;
export function plantPlanning(db: Db, siteId: string): Promise<any>;
export function savePlantPlanning(
  db: Db,
  tenantId: string,
  siteId: string,
  value: any,
): Promise<void>;
export function scheduleReadiness(db: Db, siteId: string, today: string): Promise<any>;
export function loadBomUsage(db: Db, today: string): Promise<Map<string, any[]>>;
export function planningDate(db: Db): Promise<string>;
export function decisionContext(db: Db, siteId: string): Promise<any | null>;
export function scheduleWith(dc: any, plan: any): any;
export function savePlan(db: Db, tenantId: string, siteId: string, value: any): Promise<void>;
export function planFromScenario(dc: any, compare: any, scenario: any, decisionNo: number): any;
export function describeImpact(dc: any, imp: any): any;
export function describeScenario(dc: any, s: any): any;
export function recordDecision(
  db: Db,
  actor: any,
  siteId: string,
  runNo: number,
  kind: string,
  orders: string[],
  details: any,
): Promise<{ id: string; no: number }>;
export function listDecisions(db: Db, siteId: string, limit?: number): Promise<any[]>;
export const BOOK_COLUMNS: string;
export function bookRow(row: any): any;
export function insertItem(db: Db, dc: any, code: unknown): Promise<any>;
export function oddSizeFamilies(db: Db, dc: any): Promise<any[]>;
export function oddSizeItem(db: Db, dc: any, familyCode: unknown, dims: number[]): Promise<any>;
export function simulateInsertOrder(dc: any, target: any, line: any, intent: string): any;
export function describeInsert(dc: any, res: any): any;
export function createOddSizeItem(db: Db, actor: any, dc: any, target: any): Promise<string>;
export function nextInsertRef(db: Db): Promise<string>;
export function writeInsertedOrder(
  db: Db,
  tenantId: string,
  siteId: string,
  order: any,
): Promise<string>;
export const NOT_PENDING: string;
export function loadExpediteActions(db: Db, siteId?: string | null): Promise<Map<string, any[]>>;
export function loadOrderPlans(
  db: Db,
  siteId?: string | null,
): Promise<Map<string, Map<string, any>>>;
export function materialsContext(db: Db, dc: any): Promise<any>;
export function orderUnits(
  db: Db,
  dc: any,
  ref: string,
): Promise<{ units: any[]; scheduled: boolean }>;
export function describeActions(dc: any, rows: any[]): any[];
export function expeditePreview(db: Db, dc: any, ref: string): Promise<any>;
export function writeExpediteBundle(
  db: Db,
  actor: any,
  dc: any,
  ids: string[],
  rows: any[],
  decisionNo: number,
): Promise<{ bundleId: string; bundleNo: number; actions: string[] }>;
export function refreshBundles(db: Db, siteId: string): Promise<void>;
export function listExpedites(db: Db, dc: any): Promise<any>;
export function laterPreview(
  db: Db,
  dc: any,
  ref: string,
  candidateDate?: string | null,
): Promise<any>;
export function describeLater(dc: any, res: any): any[];
export function applyLater(
  db: Db,
  actor: any,
  dc: any,
  ref: string,
  res: any,
  s: any,
  mode: string,
  decisionNo: number,
): Promise<any>;
export function listPending(db: Db, siteId: string): Promise<any[]>;
export function loadDowntime(db: Db, siteId?: string | null): Promise<Map<string, any[]>>;
export function downtimeOn(rows: any[] | undefined, dates: string[]): any[];
