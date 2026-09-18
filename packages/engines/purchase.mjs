// Rule AV-01 (purchase proposals) and goods receipt checks. Pure: the database layer applies the
// decisions. Quantities are numbers in the purchase unit of the proposal or order line.

const same = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// What the latest planning run means for one plant and item.
// pending: the item's PROPOSED proposal or null; wanted: { supplierId, unitId, quantity, due } or
// null when the buffer needs no order; lastRejected: the most recent rejected proposal or null.
export function proposalAction({ pending, wanted, lastRejected }) {
  // A person raised or changed it: planning keeps their quantity and never withdraws it.
  if (pending?.source === 'MANUAL' || pending?.changed_by_subject) return 'keep';
  if (!wanted) return pending ? 'withdraw' : 'none';
  if (!pending) {
    // A rejected suggestion is not raised again until the need changes.
    if (
      lastRejected &&
      lastRejected.supplier_id === wanted.supplierId &&
      same(lastRejected.quantity, wanted.quantity)
    )
      return 'none';
    return 'create';
  }
  const changed =
    pending.supplier_id !== wanted.supplierId ||
    pending.purchase_unit_id !== wanted.unitId ||
    !same(pending.quantity, wanted.quantity) ||
    pending.due_date !== wanted.due;
  return changed ? 'update' : 'keep';
}

// Why a person may not approve a proposal right now, or null when they may.
export function approvalProblem({ proposal, actorSubject, version, planning }) {
  if (proposal.status !== 'PROPOSED')
    return `Proposal #${proposal.proposal_no} is already ${proposal.status.toLowerCase()}.`;
  if (proposal.version !== version)
    return `Proposal #${proposal.proposal_no} changed after you opened it. Review the new quantity and approve again.`;
  if (proposal.changed_by_subject && proposal.changed_by_subject === actorSubject)
    return 'You created or last changed this proposal, so someone else must approve it.';
  if (proposal.source === 'SYSTEM') {
    if (!planning.upToDate)
      return 'Buffers are being recalculated after recent changes. Review the proposal again in a few seconds.';
    if (Number(planning.currentRunNo) !== Number(proposal.run_no))
      return `Proposal #${proposal.proposal_no} is from an older calculation. Review the latest quantity and approve again.`;
  }
  return null;
}

// Receipt lines against open order lines. lines: [{ line_no, quantity }] as numbers;
// orderLines: [{ line_no, status, quantity, received_quantity }]. Returns problem messages.
export function receiptProblems(lines, orderLines) {
  const problems = [];
  if (!lines.length) problems.push('Enter a received quantity for at least one line.');
  const seen = new Set();
  for (const l of lines) {
    const ol = orderLines.find((o) => o.line_no === l.line_no);
    if (seen.has(l.line_no)) problems.push(`Line ${l.line_no} is listed more than once.`);
    seen.add(l.line_no);
    if (!ol) {
      problems.push(`Line ${l.line_no} is not on this purchase order.`);
      continue;
    }
    if (ol.status !== 'OPEN') {
      problems.push(`Line ${l.line_no} is cancelled.`);
      continue;
    }
    const remaining = Number(ol.quantity) - Number(ol.received_quantity);
    if (!(l.quantity > 0))
      problems.push(`Line ${l.line_no}: received quantity must be greater than 0.`);
    else if (l.quantity > remaining + 1e-9)
      problems.push(
        remaining > 1e-9
          ? `Line ${l.line_no}: only ${Number(remaining.toFixed(6))} is still due; ${l.quantity} is more than ordered.`
          : `Line ${l.line_no} is already fully received.`,
      );
  }
  return problems;
}
