type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type Problem = { column: string; message: string };
export function syncProposals(db: Db, tenantId: string, run: any): Promise<any>;
export function proposalDetail(db: Db, id: string): Promise<any | null>;
export function listProposals(
  db: Db,
  siteId: string,
  options: { status?: string | null; q?: string; cursor?: string | null; limit?: number },
): Promise<{ items: any[]; counts: Record<string, number>; nextCursor: string | null }>;
export function approveProposal(
  db: Db,
  tenantId: string,
  actor: any,
  proposal: any,
  today: string,
): Promise<{ poId?: string; poNo?: string; error?: string }>;
export function rejectProposal(db: Db, actor: any, proposal: any, reason: string): Promise<void>;
export function changeProposal(
  db: Db,
  actor: any,
  proposal: any,
  change: { quantity: string; due_date: string; note: string },
): Promise<{ errors: Problem[] }>;
export function createManualProposal(
  db: Db,
  tenantId: string,
  actor: any,
  siteId: string,
  input: { item: string; quantity: string; due_date: string; note: string },
): Promise<{ errors: Problem[]; id?: string; proposalNo?: string; supplier?: string }>;
export function receiptsFor(db: Db, poId: string): Promise<any[]>;
export function postReceipt(
  db: Db,
  tenantId: string,
  actor: any,
  po: any,
  body: any,
  today: string,
): Promise<{ errors: Problem[]; receiptNo?: string; duplicate?: boolean }>;
