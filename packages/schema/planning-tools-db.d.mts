type Db = import('pg').PoolClient;
export function weeklyDemand(db: Db, siteId: string, today: string, weeks?: number): Promise<any>;
export function toolItems(db: Db, siteId: string): Promise<any[]>;
export function constraintOf(db: Db, siteId: string): Promise<any | null>;
export function monthShapeView(db: Db, siteId: string): Promise<any>;
export function bufferVsMtoView(db: Db, siteId: string, options?: any): Promise<any>;
export function recommendedBuffersView(db: Db, siteId: string, service?: number): Promise<any>;
export function listEvents(db: Db, siteId: string): Promise<any[]>;
export function listSchemes(db: Db, siteId: string): Promise<any[]>;
export function eventCurveView(
  db: Db,
  siteId: string,
  itemCode: string,
  weeks?: number,
): Promise<any | null>;
export function targetView(db: Db, siteId: string, target: any): Promise<any>;
export function spaceView(db: Db, siteId: string, service?: number): Promise<any>;
export function networkView(db: Db): Promise<any>;
export function whatIfView(
  db: Db,
  siteId: string,
  resourceCode: string,
  machines: number,
): Promise<any | null>;
export function assumptionsView(db: Db, siteId: string): Promise<any>;
