-- RCH-3: the tour plan.
--
-- A plan is an intention, and what is stored here is only the intention plus every decision
-- taken about it: what the rep proposed for each day, when it was submitted, who approved it or
-- sent it back and why, and which single day a change request moved after approval.
--
-- What is NOT stored is how the month turned out. Followed, Partial, Deviated, Missed and
-- Unplanned are read from the plan, the visits and the attendance register each time they are
-- asked for, by `packages/engines/tour-plan.mjs`. The milestone asks for exactly the case this
-- protects: leave approved after a plan was built must stop that day counting as missed. A
-- stored verdict would have to be found and rewritten; a calculated one simply answers again.
--
-- Leave, holidays and week-offs are not repeated here. Attendance owns them, and a company that
-- keeps the same holiday in two places eventually disagrees with itself.

-- ---------- One rep's month ----------
CREATE TABLE tour_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  -- Always the first of the month, so a month is one value and not a pair to keep in step.
  plan_month date NOT NULL,
  -- DRAFT is being built; SUBMITTED is waiting; APPROVED is the committed month; SENT_BACK is
  -- back with the rep, with a reason they can read.
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','SENT_BACK')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  submitted_at timestamptz,
  submitted_by uuid,
  decided_at timestamptz,
  decided_by uuid,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (plan_month = date_trunc('month', plan_month)::date),
  -- Sending a month back without saying why teaches the rep nothing, so the reason is required.
  CHECK (status <> 'SENT_BACK' OR decision_reason <> ''),
  CHECK ((status IN ('APPROVED','SENT_BACK')) = (decided_at IS NOT NULL)),
  CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id)
);
-- One plan per rep per month. A second attempt at the same month edits the first.
CREATE UNIQUE INDEX tour_plans_rep_month_idx ON tour_plans(tenant_id, rep_id, plan_month);
CREATE INDEX tour_plans_month_idx ON tour_plans(tenant_id, plan_month, status);

-- ---------- The days on it ----------
-- A day with no beat is a day in the month that is not a field day. Days are never deleted: a
-- day taken off the round keeps its row with no beat on it, so the month always reads as a
-- whole and the audit trail never has a hole where a decision used to be.
CREATE TABLE tour_plan_days (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL,
  work_date date NOT NULL,
  beat_id uuid,
  -- Copied from the beat when the day is laid out, because a beat may be renamed or moved later
  -- and last month's plan should still say which town the rep was sent to.
  town text NOT NULL DEFAULT '' CHECK (length(town) <= 80),
  outlet_count integer NOT NULL DEFAULT 0 CHECK (outlet_count BETWEEN 0 AND 500),
  objective text NOT NULL DEFAULT '' CHECK (length(objective) <= 200),
  -- AUTO is what the beat calendar proposed; MANUAL is what a rep typed. A re-run of the
  -- auto-fill refreshes its own rows and leaves a rep's own edits alone.
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('AUTO','MANUAL')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, plan_id, work_date),
  -- A day with no round to walk cannot promise outlets.
  CHECK (beat_id IS NOT NULL OR outlet_count = 0),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES tour_plans(tenant_id, id),
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id)
);
CREATE INDEX tour_plan_days_beat_idx ON tour_plan_days(tenant_id, beat_id);

-- ---------- Moving one day of an approved month ----------
-- Once a month is approved it stops being editable. A day that has to move is a request, and
-- approving it moves that one day and nothing else. What the day said before is kept on the
-- request itself, so the old record survives the change that replaced it.
CREATE TABLE tour_plan_changes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL,
  rep_id uuid NOT NULL,
  work_date date NOT NULL,
  -- What the day is to become.
  beat_id uuid,
  town text NOT NULL DEFAULT '' CHECK (length(town) <= 80),
  outlet_count integer NOT NULL DEFAULT 0 CHECK (outlet_count BETWEEN 0 AND 500),
  objective text NOT NULL DEFAULT '' CHECK (length(objective) <= 200),
  -- What it said before, kept here rather than only in the audit log, so the request reads on
  -- its own: a manager deciding it can see both sides without leaving the screen.
  previous_beat_id uuid,
  previous_town text NOT NULL DEFAULT '' CHECK (length(previous_town) <= 80),
  previous_outlet_count integer NOT NULL DEFAULT 0,
  previous_objective text NOT NULL DEFAULT '' CHECK (length(previous_objective) <= 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (beat_id IS NOT NULL OR outlet_count = 0),
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  CHECK ((status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES tour_plans(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id)
);
-- One request in flight per day, so two cannot be approved into each other.
CREATE UNIQUE INDEX tour_plan_changes_pending_idx
  ON tour_plan_changes(tenant_id, plan_id, work_date) WHERE status = 'PENDING';
CREATE INDEX tour_plan_changes_rep_idx ON tour_plan_changes(tenant_id, rep_id, work_date DESC);

-- ---------- A visit, as adherence needs to read it ----------
-- RCH-4 owns the visit: the check-out, the report form for each customer type, the duration and
-- the rule that three check-ins sent by a bad network collapse into one visit. Only the part
-- adherence has to read is created here — one row per visit, where and when it happened — and
-- RCH-4 adds its columns to this same row rather than starting a second table beside it.
--
-- A check-in from outside the shop's radius is recorded and flagged. It is never rejected:
-- refusing it loses a real visit and teaches the salesman to distrust the app.
CREATE TABLE visits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  -- Which working day the visit belongs to, in the company's own zone. Held as a date so a
  -- month's adherence is one index scan and not a timezone conversion per row.
  visit_date date NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m integer CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
  source text CHECK (source IN ('DEVICE','TYPED','PIN')),
  -- How far the check-in was from the shop's own tagged location, when both are known.
  distance_m integer CHECK (distance_m IS NULL OR distance_m >= 0),
  out_of_fence boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NOT NULL OR (source IS NULL AND accuracy_m IS NULL AND distance_m IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id)
);
-- The two reads adherence makes: one rep's month, and one shop's history.
CREATE INDEX visits_rep_date_idx ON visits(tenant_id, rep_id, visit_date);
CREATE INDEX visits_customer_date_idx ON visits(tenant_id, customer_id, visit_date DESC);

-- ---------- Settings ----------
-- Every number the plan is judged by lives on the same Reach settings row as the rest, so a
-- company that walks twenty outlets a day or works a six-day week changes it from a screen.
-- The defaults are the prototype's; the client has not answered these yet.
ALTER TABLE reach_settings ADD COLUMN plan_due_day integer NOT NULL DEFAULT 25
  CHECK (plan_due_day BETWEEN 1 AND 28);
ALTER TABLE reach_settings ADD COLUMN plan_max_outlets integer NOT NULL DEFAULT 12
  CHECK (plan_max_outlets BETWEEN 1 AND 100);
ALTER TABLE reach_settings ADD COLUMN plan_field_days_pct integer NOT NULL DEFAULT 75
  CHECK (plan_field_days_pct BETWEEN 0 AND 100);
-- What share of a planned round must be visited for the day to read as Followed.
ALTER TABLE reach_settings ADD COLUMN plan_followed_pct integer NOT NULL DEFAULT 60
  CHECK (plan_followed_pct BETWEEN 1 AND 100);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['tour_plans','tour_plan_days','tour_plan_changes','visits'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- Nothing here may be deleted. A plan, the decision taken on it, a change request and a visit
-- are all records of what was intended or what happened; they are superseded, never removed.
GRANT SELECT, INSERT, UPDATE ON tour_plans, tour_plan_days, tour_plan_changes, visits TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.plan', 'Reach', 'Build and submit your own tour plan'),
('reach.plan_approve', 'Reach', 'Approve tour plans and day change requests')
ON CONFLICT (code) DO NOTHING;
