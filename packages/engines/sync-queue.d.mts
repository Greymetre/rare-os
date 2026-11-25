export type OutboxState = 'QUEUED' | 'SENT' | 'BLOCKED';

export type OutboxKind = {
  kind: string;
  title: string;
  method: 'POST' | 'PUT';
  path: string;
  permission: string;
  ref: boolean;
  binary?: boolean;
  dependsOn?: string;
  settled: string[];
};

export type OutboxItem = {
  localId: string;
  kind: string;
  seq: number;
  payload: Record<string, unknown>;
  clientRef: string;
  state: OutboxState;
  attempts: number;
  retryAfter: number;
  createdAt: number;
  sentAt: number | null;
  serverId: string | null;
  lastError: string;
  lastCode: string;
  settled?: boolean;
  needsSignIn?: boolean;
};

export type SendResult =
  | { ok: true; status?: number; body?: { id?: string } & Record<string, unknown> }
  | { ok: false; status: number; code?: string; message?: string };

export const LOCAL_PREFIX: string;
export const OUTBOX_KINDS: OutboxKind[];
export const OUTBOX_STATES: OutboxState[];
export const FIRST_RETRY_MS: number;
export const MAX_RETRY_MS: number;

export function isLocalId(value: unknown): value is string;
export function kindOf(kind: string): OutboxKind | null;
export function retryDelayMs(attempts: number): number;

export function resolveLinks(options: {
  path?: string;
  payload?: Record<string, unknown>;
  idMap?: Record<string, string>;
}): {
  path: string;
  payload: Record<string, unknown>;
  missing: string[];
  ready: boolean;
};

export function readyToSend(
  items?: OutboxItem[],
  options?: { now?: number; limit?: number },
): OutboxItem[];

export function parentOf(
  item: { kind?: string; payload?: Record<string, unknown> } | null,
): string | null;

export function applyResult(
  item: OutboxItem,
  result: SendResult,
  options?: { now?: number },
): OutboxItem;

export function cascadeBlocks(items?: OutboxItem[]): OutboxItem[];

export function queueSummary(items?: OutboxItem[]): {
  total: number;
  queued: number;
  sent: number;
  blocked: number;
  headline: string;
  settled: boolean;
  problems: { localId: string; kind: string; title: string; why: string; code: string }[];
};

export function queueItem(options: {
  kind: string;
  payload?: Record<string, unknown>;
  localId: string;
  clientRef: string;
  seq?: number;
  now?: number;
}): OutboxItem;

export function idMapOf(items?: OutboxItem[]): Record<string, string>;
