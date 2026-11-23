import type { CutoverStep, Proposal } from '../engines/reach-overview.d.mts';

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> };

export const REACH_TABLES: string[];

export function proposalCounts(
  db: Db,
  input: { date: string; settings: Record<string, unknown> },
): Promise<Record<string, number>>;

export function overviewFor(
  db: Db,
  options?: { date?: string | null; permissions?: string[] | null },
): Promise<{
  date: string;
  today: {
    started: number;
    still_out: number;
    visits: number;
    in_a_shop: number;
    orders: number;
    order_value: number;
    collected: number;
    reps: number;
  };
  proposals: Proposal[];
  queue: { rows: Proposal[]; total: number; modules: string[] };
  counts: Record<string, number>;
}>;

export function cutoverFor(db: Db): Promise<{
  facts: Record<string, number>;
  steps: CutoverStep[];
  ready: boolean;
  done: number;
  total: number;
  blockers: string[];
}>;

export function reachAudit(
  db: Db,
  filters: { from: string; to: string; action?: string | null; limit?: number },
): Promise<{
  items: {
    id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    details: unknown;
    created_at: string;
    actor: string;
  }[];
  total: number;
  kinds: { action: string; n: number }[];
}>;
