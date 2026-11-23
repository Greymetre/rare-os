-- RCH-6: what a rep spent on the road, and what the policy allows of it.
--
-- The shape of this module turns on one sentence in the milestone plan: a new policy version
-- always starts **after today**, so that an amount somebody has already approved can never move.
-- Everything else follows from taking that seriously.
--
-- Because a version can only start in the future, and because a version that has started can no
-- longer be edited, recalculating last fortnight's claim always gives last fortnight's answer.
-- That is what lets the amount stay **calculated rather than stored**, the same rule the
-- attendance register, plan-versus-actual, the visit verdict and the outstanding are built on.
-- A claim line keeps what the rep said — the date, the kilometres, the nights, the town and the
-- money they are asking for — and `packages/engines/expense.mjs` works out what the policy makes
-- of it every time anybody looks.
--
-- Two things are therefore deliberately NOT columns here:
--
-- * **What a line comes to.** No `amount`, no `allowed`, no `approved_amount`. The policy version
--   in force on the spend date decides, and that version cannot change under it.
-- * **Whether a day earns a daily allowance.** The attendance register settles that, and it is
--   read again on every request. The milestone's own acceptance case is a day on leave earning
--   nothing, and it works because nothing was written down to go stale.
--
-- Nothing here may be deleted by the runtime role. A claim, a decision and a policy version are
-- all records of what happened or what somebody decided. A line a rep removes from a draft is
-- soft-deleted rather than erased, because "this was claimed and then withdrawn" is exactly the
-- kind of thing an auditor asks about later.
--
-- What this is NOT: a payroll or payments system. Approving a claim records that it was approved
-- and produces a payout file. No money moves from here.

-- ---------- Where a rep is based ----------
-- The daily allowance is a different rate at headquarters, out of headquarters, and away
-- overnight — so the system has to know where "headquarters" is for each rep. Blank means the
-- company has not said, and every day then reads as out of headquarters rather than guessing.
ALTER TABLE field_reps ADD COLUMN hq_town text NOT NULL DEFAULT ''
  CHECK (length(hq_town) <= 80);

-- ---------- What may be claimed ----------
-- A category says how a line turns into money, not how much. The rates live on a policy version,
-- because they are the part that changes.
CREATE TABLE expense_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 30),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- KM: kilometres times a rate that depends on the vehicle.
  -- DAILY: one day's allowance at a rate that depends on where the day was spent.
  -- NIGHTLY: nights times a rate that depends on the rep's grade.
  -- ACTUAL: what the rep actually spent, up to a cap.
  basis text NOT NULL DEFAULT 'ACTUAL' CHECK (basis IN ('KM','DAILY','NIGHTLY','ACTUAL')),
  -- Above this, the policy insists on a receipt. Null means it never does.
  receipt_above numeric(18,2) CHECK (receipt_above IS NULL OR receipt_above >= 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX expense_categories_code_idx
  ON expense_categories(tenant_id, lower(code)) WHERE deleted_at IS NULL;

-- ---------- The policy, as a version ----------
-- A version is a dated set of rates. It may be edited only while its start date is still in the
-- future; from the day it begins it is the thing claims were measured against, and the amounts
-- are only safe to recalculate because this is true. Both halves of that rule are enforced where
-- edits happen, in `reach-expense.controller.ts` — a table cannot see today's date.
CREATE TABLE expense_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 30),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- The first day this version governs. Two versions cannot begin on the same day, or no date
  -- would have one answer.
  effective_from date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX expense_policies_code_idx ON expense_policies(tenant_id, lower(code));
CREATE UNIQUE INDEX expense_policies_from_idx ON expense_policies(tenant_id, effective_from);

-- One rate, under one version.
--
-- `key` is the dimension the basis reads: the vehicle for kilometres, where the day was spent for
-- a daily allowance, the rep's grade for a night's lodging, and empty for a category claimed at
-- actuals. One table rather than four keeps "the rates of a version" a single thing to copy when
-- somebody builds the next one.
CREATE TABLE expense_policy_rates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  policy_id uuid NOT NULL,
  category_id uuid NOT NULL,
  key text NOT NULL DEFAULT '' CHECK (length(key) <= 30),
  -- Money per kilometre, per day or per night. Four decimals, because a rate is not always a
  -- round paisa. Null where the category is claimed at actuals and only the cap applies.
  rate numeric(18,4) CHECK (rate IS NULL OR rate >= 0),
  -- The most one line may come to. Null means the policy sets no limit on a single line.
  cap numeric(18,2) CHECK (cap IS NULL OR cap >= 0),
  -- The most this category may come to across one whole claim — a phone bill capped a fortnight
  -- at a time cannot be judged one line at a time.
  period_cap numeric(18,2) CHECK (period_cap IS NULL OR period_cap >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A rate taken off a version is soft-deleted like everything else here, and for the same
  -- reason: this table also holds the rates of versions that have already governed real claims,
  -- and those can never be removed. The rates of a version are saved as one set, so a row the
  -- new set does not mention is marked gone rather than erased.
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, policy_id, category_id, key),
  -- A rate row that sets neither a rate nor a limit says nothing at all.
  CHECK (rate IS NOT NULL OR cap IS NOT NULL OR period_cap IS NOT NULL),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES expense_policies(tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories(tenant_id, id)
);

-- ---------- The claim ----------
-- One claim per rep per period. The period is a fortnight by the client's own answer, and it is
-- stored on the claim rather than derived, so changing the company's mind later does not reshape
-- the claims already made.
CREATE TABLE expense_claims (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','MANAGER_OK','APPROVED','REJECTED')),
  submitted_at timestamptz,
  -- Who passed it, and who approved it. The constraint below is the milestone's own acceptance
  -- case, and it is in the table rather than only in the controller because it is the one rule
  -- here that somebody has a reason to want around.
  manager_by uuid,
  manager_at timestamptz,
  manager_note text NOT NULL DEFAULT '' CHECK (length(manager_note) <= 300),
  finance_by uuid,
  finance_at timestamptz,
  finance_note text NOT NULL DEFAULT '' CHECK (length(finance_note) <= 300),
  reject_reason text NOT NULL DEFAULT '' CHECK (length(reject_reason) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  -- One person may hold both rights. They may not use both on the same claim.
  CHECK (manager_by IS NULL OR finance_by IS NULL OR manager_by <> finance_by),
  CHECK ((manager_by IS NULL) = (manager_at IS NULL)),
  CHECK ((finance_by IS NULL) = (finance_at IS NULL)),
  CHECK (status <> 'REJECTED' OR reject_reason <> ''),
  CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
  -- Finance cannot have seen a claim a manager never passed.
  CHECK (finance_by IS NULL OR manager_by IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id)
);
CREATE UNIQUE INDEX expense_claims_period_idx
  ON expense_claims(tenant_id, rep_id, period_from);
CREATE INDEX expense_claims_waiting_idx ON expense_claims(tenant_id, status)
  WHERE status IN ('SUBMITTED','MANAGER_OK');

-- ---------- What the rep is claiming for ----------
-- What is kept is what the rep said. What it comes to is worked out from the policy version in
-- force on `spend_date`, every time it is read.
CREATE TABLE expense_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  claim_id uuid NOT NULL,
  category_id uuid NOT NULL,
  spend_date date NOT NULL,
  -- Kilometres, and which vehicle they were on. Both empty for a category that is not by road.
  km numeric(12,4) NOT NULL DEFAULT 0 CHECK (km >= 0 AND km <= 100000),
  vehicle text NOT NULL DEFAULT '' CHECK (length(vehicle) <= 30),
  nights integer NOT NULL DEFAULT 0 CHECK (nights BETWEEN 0 AND 60),
  -- The town the rep says the day was spent in. The tour plan's own town outranks this wherever
  -- there is a plan day, so that a day at headquarters cannot be claimed as a day away.
  town text NOT NULL DEFAULT '' CHECK (length(town) <= 80),
  -- What the rep is asking for. Not what they will get.
  claimed_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (claimed_amount >= 0),
  file_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A line taken off a draft keeps its row. "Claimed and then withdrawn" is worth being able to
  -- see; erasing it is not.
  deleted_at timestamptz,
  deleted_reason text NOT NULL DEFAULT '' CHECK (length(deleted_reason) <= 300),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES expense_claims(tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files(tenant_id, id)
);
CREATE INDEX expense_lines_claim_idx ON expense_lines(tenant_id, claim_id) WHERE deleted_at IS NULL;
CREATE INDEX expense_lines_date_idx ON expense_lines(tenant_id, spend_date);

-- ---------- Settings ----------
-- Whether claims come in a fortnight at a time or a month at a time. The client's answer is a
-- fortnight; a company that works the other way changes one setting.
ALTER TABLE reach_settings ADD COLUMN expense_fortnightly boolean NOT NULL DEFAULT true;
-- How long after a period closes a rep may still send its claim in. Zero means no limit.
ALTER TABLE reach_settings ADD COLUMN expense_window_days integer NOT NULL DEFAULT 15
  CHECK (expense_window_days BETWEEN 0 AND 180);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['expense_categories','expense_policies','expense_policy_rates',
   'expense_claims','expense_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- Nothing here may be deleted. A claim and a decision are records of what happened; a policy
-- version is what somebody was paid against; and a line a rep withdrew is soft-deleted so that
-- the withdrawal itself can still be seen.
GRANT SELECT, INSERT, UPDATE ON expense_categories, expense_policies, expense_policy_rates,
  expense_claims, expense_lines TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
-- Making a claim is a rep's own right and stands alone, like marking your own attendance: a rep
-- who may claim must not thereby be able to read everybody else's.
('reach.expense', 'Reach', 'Make and submit an expense claim of your own'),
('reach.expense_approve', 'Reach', 'Pass an expense claim as its manager'),
('reach.expense_finance', 'Reach', 'Approve or reject a passed expense claim as finance')
ON CONFLICT (code) DO NOTHING;
