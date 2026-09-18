export function proposalAction(input: { pending: any; wanted: any; lastRejected?: any }): string;
export function approvalProblem(input: {
  proposal: any;
  actorSubject: string | null;
  version: number;
  planning: { upToDate: boolean; currentRunNo?: number | string | null };
}): string | null;
export function receiptProblems(
  lines: { line_no: number; quantity: number }[],
  orderLines: {
    line_no: number;
    status: string;
    quantity: string | number;
    received_quantity: string | number;
  }[],
): string[];
