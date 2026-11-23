// RCH-7: one place that says what the field organisation is doing, what is waiting for somebody,
// and what the system thinks is worth looking at.
//
// **Nothing in this milestone is stored.** There is no overview table, no alert table and no
// proposal table, and that is not an economy — it is the milestone's own acceptance test made
// structural. "Har tile ka number neeche ki asli activity se mile" is guaranteed when the tile
// and the list beneath it are the same count, read from the same evidence in the same request.
// A stored count is a count that drifts, and then nobody can say which number is true.
//
// **A proposal never acts.** The same acceptance again: "koi bhi proposal bina approval ke kuch
// na badle". Every proposal here is a reading of evidence plus the name of the screen where a
// person does something about it. There is no code path by which one of them changes anything,
// because a proposal is not a row that could be marked done — it stops being made when the thing
// it noticed stops being true. Attendance already works this way: its reminder has always been a
// proposal and never an action.
//
// Pure: no database, no HTTP.

// What the system may notice. Each one says how loud it is, which module it belongs to, and the
// screen a person goes to — a proposal that does not say where to act is a complaint.
export const PROPOSAL_KINDS = {
  DAY_NOT_STARTED: {
    module: 'Attendance',
    screen: 'Today',
    severity: 'WARN',
    title: 'Nobody has heard from this rep today',
    why: 'The shift has been over for longer than the company allows and no day was started.',
  },
  LEAVE_WAITING: {
    module: 'Attendance',
    screen: 'Leave',
    severity: 'DECIDE',
    title: 'Leave is waiting for a decision',
    why: 'A rep cannot plan around an answer nobody has given.',
  },
  CORRECTION_WAITING: {
    module: 'Attendance',
    screen: 'Corrections',
    severity: 'DECIDE',
    title: 'An attendance correction is waiting',
    why: 'Until it is decided the register reads a day that nobody agrees with.',
  },
  PLAN_LATE: {
    module: 'Tour plan',
    screen: 'Plans',
    severity: 'WARN',
    title: 'Next month’s plan has not been sent in',
    why: 'The company’s own due day has passed.',
  },
  PLAN_WAITING: {
    module: 'Tour plan',
    screen: 'Plans',
    severity: 'DECIDE',
    title: 'A month’s plan is waiting for approval',
    why: 'A rep walking an unapproved month is walking without agreement.',
  },
  DAY_CHANGE_WAITING: {
    module: 'Tour plan',
    screen: 'Day changes',
    severity: 'DECIDE',
    title: 'A day change is waiting',
    why: 'The month is approved, so moving a day needs somebody to say yes.',
  },
  VISIT_FLAGGED: {
    module: 'Field work',
    screen: 'Calls today',
    severity: 'WATCH',
    title: 'A check-in was made away from the shop',
    why: 'It was recorded, never refused. Somebody should look at why.',
  },
  REPORT_UNFINISHED: {
    module: 'Field work',
    screen: 'Visits',
    severity: 'WATCH',
    title: 'A visit report is unfinished',
    why: 'The questions the customer type asks were not all answered.',
  },
  CUSTOMER_WAITING: {
    module: 'Customers',
    screen: 'Approvals',
    severity: 'DECIDE',
    title: 'A new customer is waiting for approval',
    why: 'Until it is approved nothing can be sold to it.',
  },
  GEO_WAITING: {
    module: 'Customers',
    screen: 'Approvals',
    severity: 'DECIDE',
    title: 'A shop’s location change is waiting',
    why: 'Check-ins are measured against the location on record.',
  },
  KYC_WAITING: {
    module: 'Trade',
    screen: 'Paperwork',
    severity: 'DECIDE',
    title: 'A KYC document is waiting to be checked',
    why: 'An order may be held for paperwork that is already in the building.',
  },
  ORDER_HELD: {
    module: 'Trade',
    screen: 'Orders',
    severity: 'DECIDE',
    title: 'An order is on hold',
    why: 'It was taken and recorded. Somebody has to decide whether it goes.',
  },
  OVERDUE_CUSTOMER: {
    module: 'Trade',
    screen: 'Customer 360',
    severity: 'WARN',
    title: 'A shop owes money older than its terms allow',
    why: 'New orders from it will be held until something is collected.',
  },
  CLAIM_WAITING: {
    module: 'Expenses',
    screen: 'Expense claims',
    severity: 'DECIDE',
    title: 'An expense claim is waiting at a desk',
    why: 'A rep has spent their own money and is waiting to be paid back.',
  },
};

// Loudest first: a thing somebody has to decide outranks a thing somebody should watch.
export const SEVERITY_ORDER = ['DECIDE', 'WARN', 'WATCH'];

// Which proposals are literally "somebody must say yes or no". These are the ones that make up
// the single approval queue the milestone asks for — one place instead of a queue per module.
export const DECISION_KINDS = Object.entries(PROPOSAL_KINDS)
  .filter(([, k]) => k.severity === 'DECIDE')
  .map(([code]) => code);

// The permission a person needs before a proposal is any use to them. A proposal pointing at a
// screen somebody cannot open is noise, so the overview never shows it to them.
export const PROPOSAL_RIGHTS = {
  DAY_NOT_STARTED: 'reach.read',
  LEAVE_WAITING: 'reach.leave',
  CORRECTION_WAITING: 'reach.leave',
  PLAN_LATE: 'reach.read',
  PLAN_WAITING: 'reach.plan_approve',
  DAY_CHANGE_WAITING: 'reach.plan_approve',
  VISIT_FLAGGED: 'reach.read',
  REPORT_UNFINISHED: 'reach.read',
  CUSTOMER_WAITING: 'reach.approve',
  GEO_WAITING: 'reach.approve',
  KYC_WAITING: 'reach.kyc',
  ORDER_HELD: 'reach.credit',
  OVERDUE_CUSTOMER: 'reach.read',
  CLAIM_WAITING: 'reach.expense_approve',
};

// Turn counted evidence into the proposals worth making.
//
// `counts` is a plain map of kind to how many there are, and anything at nought simply is not a
// proposal — the system says nothing rather than reassuring somebody that there is nothing to
// say. Each proposal carries its own count, so the tile above a list and the list itself are the
// same number by construction.
export function proposalsFrom(counts = {}, { permissions = null } = {}) {
  const rows = [];
  for (const [code, kind] of Object.entries(PROPOSAL_KINDS)) {
    const count = Number(counts[code] ?? 0);
    if (!count) continue;
    const needs = PROPOSAL_RIGHTS[code];
    // A person who cannot act on it is not shown it. `permissions` of null means "do not filter",
    // which is what the register and the tests use.
    if (permissions && needs && !permissions.includes(needs)) continue;
    rows.push({ code, count, ...kind, needs });
  }
  return rows.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}

// The single queue: everything waiting for a yes or a no, whichever module it came from.
export function approvalQueue(proposals = []) {
  const waiting = proposals.filter((p) => p.severity === 'DECIDE');
  return {
    rows: waiting,
    // The one number the overview tile shows. It is the sum of the same rows the queue lists,
    // which is the milestone's acceptance in one line of code.
    total: waiting.reduce((sum, p) => sum + p.count, 0),
    modules: [...new Set(waiting.map((p) => p.module))],
  };
}

// What a company still has to do before Reach can carry real work. Each step reads the counts
// that are already being gathered for the overview, so "ready" never means "somebody ticked it".
export function cutoverSteps(facts = {}) {
  const step = (key, title, detail, done, blocking = true) => ({
    key,
    title,
    detail,
    blocking,
    status: done ? 'ready' : 'missing',
  });
  return [
    step(
      'reps',
      'Field reps exist, and their logins are linked',
      'A rep with no login cannot mark a day, walk a plan or make a claim.',
      Number(facts.repsWithLogin ?? 0) > 0,
    ),
    step(
      'customers',
      'Customers are loaded',
      'The register is what every round, order and collection hangs off.',
      Number(facts.customers ?? 0) > 0,
    ),
    step(
      'beats',
      'Rounds are built and have outlets on them',
      'Without outlets on a round the tour plan has nothing to propose.',
      Number(facts.beatOutlets ?? 0) > 0,
    ),
    step(
      'geo',
      'Shops are tagged where they stand',
      'An untagged shop leaves every check-in’s distance unknown.',
      Number(facts.taggedCustomers ?? 0) > 0,
    ),
    step(
      'shifts',
      'A shift is set so a day can be judged',
      'Without one, nothing about a punch is guessed at.',
      Number(facts.repsWithShift ?? 0) > 0,
    ),
    step(
      'prices',
      'A price list is in force',
      'An order cannot be priced without one, so none can be taken.',
      Number(facts.prices ?? 0) > 0,
      false,
    ),
    step(
      'expense_policy',
      'An expense policy version is in force',
      'Until one is, a claim can be typed but nothing worked out from it.',
      Number(facts.livePolicies ?? 0) > 0,
      false,
    ),
  ];
}

export function cutoverVerdict(steps = []) {
  const blocking = steps.filter((s) => s.blocking);
  const ready = blocking.every((s) => s.status === 'ready');
  return {
    ready,
    done: steps.filter((s) => s.status === 'ready').length,
    total: steps.length,
    blockers: blocking.filter((s) => s.status !== 'ready').map((s) => s.title),
  };
}
