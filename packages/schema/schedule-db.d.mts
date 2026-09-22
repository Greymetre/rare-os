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
