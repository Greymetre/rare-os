type Db = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

export function bootstrapFor(
  db: Db,
  input: { repId: string; workDate: string },
): Promise<{
  date: string;
  rep: {
    id: string;
    code: string;
    name: string;
    hq_town: string | null;
    territory_id: string | null;
    grade: string | null;
  };
  work_types: { id: string; code: string; name: string; needs_location: boolean }[];
  stops: any[];
  prices: any[];
  day: { id: string; version: number; start_time: string | null; end_time: string | null } | null;
  open_visits: any[];
} | null>;

export function recordHeartbeat(
  db: Db,
  tenantId: string,
  input: {
    id: string;
    repId: string;
    deviceRef: string;
    platform?: string;
    appVersion?: string;
    queued?: number;
    blocked?: number;
  },
): Promise<{ id: string; last_seen_at: string }>;

export function devicesSeen(db: Db, options?: { limit?: number }): Promise<any[]>;
