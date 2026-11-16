type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Actor = { id: string | null; actor_subject?: string | null };
type Settings = {
  gps_verified_m: number;
  duplicate_within_m: number;
  retag_approval_m: number;
  kyc_reminder_days: number;
  version: number;
};
export const SETTING_DEFAULTS: Omit<Settings, 'version'>;
export function reachSettings(db: Db): Promise<Settings>;
export function saveReachSettings(db: Db, tenantId: string, value: any): Promise<void>;
export function customerType(db: Db, typeId: string): Promise<any | null>;
export function customerTypes(db: Db): Promise<any[]>;
export function formFor(db: Db, typeId: string): Promise<any[]>;
export function validateAnswers(
  form: any[],
  raw: Record<string, unknown> | null | undefined,
): { value: any; errors: { column: string; message: string }[] };
export function listCustomers(
  db: Db,
  filters?: {
    q?: string;
    type?: string;
    status?: string;
    beat?: string;
    territory?: string;
    geo?: string;
    cursor?: string[] | null;
    limit?: number;
  },
): Promise<{ items: any[]; total: number; nextCursor: string[] | null }>;
export function findCustomer(db: Db, id: string): Promise<any | null>;
export function customerTiles(db: Db): Promise<any>;
export function createCustomer(db: Db, tenantId: string, value: any): Promise<string>;
export function updateCustomer(db: Db, id: string, value: any): Promise<void>;
export function setCustomerStatus(
  db: Db,
  id: string,
  status: string,
  options?: { actorId?: string | null; reason?: string },
): Promise<void>;
export function removeCustomer(
  db: Db,
  id: string,
  actorId: string | null,
  reason: string,
): Promise<boolean>;
export function customerBlockers(db: Db, id: string): Promise<string[]>;
export function beatOutlets(db: Db, beatId: string): Promise<any[]>;
export function syncBeatMembership(db: Db, tenantId: string, customer: any): Promise<string>;
export function reorderBeat(db: Db, beatId: string, customerIds: string[]): Promise<void>;
export function nearbyCustomers(
  db: Db,
  point: { latitude: number | string; longitude: number | string },
  within: number,
  excludeId?: string | null,
): Promise<any[]>;
export function tagCustomer(
  db: Db,
  tenantId: string,
  actor: Actor,
  customer: any,
  next: any,
  settings: Settings,
): Promise<{
  moved: number | null;
  needsApproval: boolean;
  verified: boolean;
  status: string;
  logId: string;
}>;
export function pendingTag(db: Db, customerId: string): Promise<any | null>;
export function geoHistory(db: Db, customerId: string, limit?: number): Promise<any[]>;
export function decideTag(
  db: Db,
  actor: Actor,
  request: any,
  customer: any,
  approve: boolean,
  reason: string,
  settings: Settings,
): Promise<void>;
export function pendingApprovals(db: Db): Promise<{ accounts: any[]; retags: any[] }>;
