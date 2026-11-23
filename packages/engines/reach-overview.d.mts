export type Severity = 'DECIDE' | 'WARN' | 'WATCH';

export type ProposalKind = {
  module: string;
  screen: string;
  severity: Severity;
  title: string;
  why: string;
};

export const PROPOSAL_KINDS: Record<string, ProposalKind>;
export const SEVERITY_ORDER: Severity[];
export const DECISION_KINDS: string[];
export const PROPOSAL_RIGHTS: Record<string, string>;

export type Proposal = ProposalKind & { code: string; count: number; needs: string };

export function proposalsFrom(
  counts?: Record<string, number | string | null | undefined>,
  options?: { permissions?: string[] | null },
): Proposal[];

export function approvalQueue(proposals?: Proposal[]): {
  rows: Proposal[];
  total: number;
  modules: string[];
};

export type CutoverStep = {
  key: string;
  title: string;
  detail: string;
  blocking: boolean;
  status: 'ready' | 'missing';
};

export function cutoverSteps(facts?: Record<string, number | string | null>): CutoverStep[];
export function cutoverVerdict(steps?: CutoverStep[]): {
  ready: boolean;
  done: number;
  total: number;
  blockers: string[];
};
