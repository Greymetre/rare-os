-- RCH-1 Customers and Beats (developer handover 27-Oct-2026, build note v17 of 14-Oct-2026).
--
-- * A beat outlet IS the customer: one record, visited in a beat and sold to. That is why this
--   milestone comes first — Tour Plan, visits and orders all hang off it.
-- * These are trade customers: the shops, distributors, institutions and influencers the field
--   force calls on. They are NOT the planning `customers` of AV-1, which are the accounts a
--   sales order is raised against. The handover keeps them apart too and links them: a distributor
--   that is also a planning account carries `sales_customer_id`. Keeping one table would put 120
--   retail outlets in front of a planner choosing an account for a sales order.
-- * A type decides the shape of a customer: which form fields are asked, whether a geo tag is
--   needed and how close a check-in must be, whether it sits on a beat plan, and whether a new
--   account waits for approval. Every one of those is a row a company edits in Setup, not a
--   constant in the code.
-- * Answers to the per-type form live in `attrs`, because the questions differ by type and a
--   company adds its own. What every type has in common is a column.

-- ---------- Company-wide Reach settings (AS-R39..R42 of the handover) ----------
-- One row per company; absent means the defaults below, so nothing has to be seeded.
CREATE TABLE reach_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- A device fix at or inside this distance counts as verified. AS-R39.
  gps_verified_m integer NOT NULL DEFAULT 50 CHECK (gps_verified_m BETWEEN 5 AND 1000),
  -- Two customers tagged this close to each other are flagged as a possible duplicate. AS-R40.
  duplicate_within_m integer NOT NULL DEFAULT 30 CHECK (duplicate_within_m BETWEEN 5 AND 1000),
  -- Moving a tag further than this needs the Sales Head. AS-R41.
  retag_approval_m integer NOT NULL DEFAULT 100 CHECK (retag_approval_m BETWEEN 10 AND 5000),
  -- Remind when missing KYC has blocked ordering for longer than this. AS-R42.
  kyc_reminder_days integer NOT NULL DEFAULT 7 CHECK (kyc_reminder_days BETWEEN 1 AND 365),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- The six types, and the rules each one carries ----------
CREATE TABLE customer_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Reading order on the register and the tiles; 1 is the top of the channel.
  tier smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 20),
  -- Suggested start of a new customer's code, e.g. DIST.
  prefix text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Za-z0-9_.-]{0,10}$'),
  geo_required boolean NOT NULL DEFAULT true,
  -- How close a check-in has to be to the tag. AS-R43, per type.
  checkin_radius_m integer NOT NULL DEFAULT 100 CHECK (checkin_radius_m BETWEEN 10 AND 5000),
  min_visit_minutes integer NOT NULL DEFAULT 5 CHECK (min_visit_minutes BETWEEN 0 AND 480),
  visit_norm_per_month integer NOT NULL DEFAULT 4 CHECK (visit_norm_per_month BETWEEN 0 AND 60),
  -- Whether a customer of this type is a stop on a beat, or carries a beat for territory only.
  on_beat_plan boolean NOT NULL DEFAULT true,
  -- Whether a new account of this type waits for a decision before it goes live.
  needs_approval boolean NOT NULL DEFAULT false,
  -- Read by later milestones (RCH-4 visits, RCH-6 expenses, orders); maintained here in Setup.
  kyc_before_order boolean NOT NULL DEFAULT false,
  order_route text NOT NULL DEFAULT 'NONE' CHECK (order_route IN ('ERP','DISTRIBUTOR','NONE')),
  credit_limit numeric(18,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  credit_days integer CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
  -- Hold orders when overdue beyond this many days. AS-R44, per type.
  hold_days integer CHECK (hold_days IS NULL OR hold_days BETWEEN 0 AND 365),
  loyalty boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customer_types_code_idx ON customer_types(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX customer_types_cursor_idx ON customer_types(tenant_id, lower(code) text_pattern_ops, id);

-- ---------- The questions a customer form may ask ----------
CREATE TABLE customer_form_fields (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- The key the answer is stored under in trade_customers.attrs.
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- What the question reads as on the form. Called name like every other master's name, so the
  -- shared master screens search and sort it without a special case.
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  input text NOT NULL CHECK (input IN ('text','textarea','number','select','date','phone','email','gstin','pan','bool')),
  section text NOT NULL DEFAULT 'Details' CHECK (length(section) BETWEEN 1 AND 60),
  display_order integer NOT NULL DEFAULT 100 CHECK (display_order BETWEEN 1 AND 9999),
  -- Choices for a select, one per line in the form, stored pipe-separated.
  options text NOT NULL DEFAULT '' CHECK (length(options) <= 1000),
  help text NOT NULL DEFAULT '' CHECK (length(help) <= 200),
  default_value text NOT NULL DEFAULT '' CHECK (length(default_value) <= 200),
  -- A field the product itself relies on: its key and input cannot be changed or removed.
  locked boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK (input <> 'select' OR options <> ''),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customer_form_fields_key_idx ON customer_form_fields(tenant_id, field_key) WHERE deleted_at IS NULL;
CREATE INDEX customer_form_fields_cursor_idx ON customer_form_fields(tenant_id, field_key text_pattern_ops, id);

-- Which field is asked of which type, and how: the form-by-type matrix.
-- No row at all means the field is not asked of that type, same as 'X'.
CREATE TABLE customer_form_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type_id uuid NOT NULL,
  field_id uuid NOT NULL,
  requirement text NOT NULL DEFAULT 'O' CHECK (requirement IN ('R','O','X')),
  -- A type may word the same question its own way.
  label_override text NOT NULL DEFAULT '' CHECK (length(label_override) <= 120),
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES customer_types(tenant_id, id),
  FOREIGN KEY (tenant_id, field_id) REFERENCES customer_form_fields(tenant_id, id)
);
CREATE UNIQUE INDEX customer_form_rules_pair_idx ON customer_form_rules(tenant_id, type_id, field_id) WHERE deleted_at IS NULL;
CREATE INDEX customer_form_rules_field_idx ON customer_form_rules(tenant_id, field_id);

-- ---------- Beats: an ordered round of outlets on a repeating day pattern ----------
CREATE TABLE beats (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  territory_id uuid NOT NULL,
  -- WEEKLY runs on its days every week; FORTNIGHTLY runs on them in alternate weeks.
  frequency text NOT NULL DEFAULT 'WEEKLY' CHECK (frequency IN ('WEEKLY','FORTNIGHTLY')),
  -- The days it runs, as a canonical comma-separated list in week order, e.g. MON,THU.
  run_days text NOT NULL CHECK (run_days ~ '^(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*$'),
  -- Which half of the fortnight a FORTNIGHTLY beat runs in; ALL for a weekly beat.
  week_parity text NOT NULL DEFAULT 'ALL' CHECK (week_parity IN ('ALL','ODD','EVEN')),
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  -- A weekly beat has no parity to choose; a fortnightly one must choose.
  CHECK ((frequency = 'WEEKLY') = (week_parity = 'ALL')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id)
);
CREATE UNIQUE INDEX beats_code_idx ON beats(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX beats_cursor_idx ON beats(tenant_id, lower(code) text_pattern_ops, id);
CREATE INDEX beats_territory_idx ON beats(tenant_id, territory_id);

-- ---------- The customers themselves ----------
CREATE TABLE trade_customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  type_id uuid NOT NULL,
  -- AWAITING_APPROVAL only for a type that asks for it; REJECTED keeps the record and the reason.
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('AWAITING_APPROVAL','ACTIVE','DORMANT','REJECTED')),
  -- The beat this customer belongs to. A type that is not on the beat plan still carries one, for
  -- territory; only a type that is on the plan becomes an ordered stop in beat_outlets.
  beat_id uuid,
  territory_id uuid NOT NULL,
  -- Who it buys from: the distributor above a dealer or a retailer.
  buys_from_id uuid,
  rep_id uuid,
  -- The planning account of AV-1, where this customer is also one. Most outlets are not.
  sales_customer_id uuid,
  town text NOT NULL DEFAULT '' CHECK (length(town) <= 80),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  -- Answers to its type's form. Keys are customer_form_fields.field_key.
  attrs jsonb NOT NULL DEFAULT '{}',
  -- Where the shop is. Both or neither; a type may require it.
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  geo_source text CHECK (geo_source IN ('DEVICE','TYPED','PIN')),
  geo_accuracy_m integer CHECK (geo_accuracy_m IS NULL OR geo_accuracy_m BETWEEN 0 AND 100000),
  -- A device fix inside the company's gps_verified_m; a typed or dropped pin never is.
  geo_verified boolean NOT NULL DEFAULT false,
  geo_tagged_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK ((latitude IS NULL) = (geo_tagged_at IS NULL)),
  CHECK (latitude IS NOT NULL OR (geo_source IS NULL AND geo_accuracy_m IS NULL AND NOT geo_verified)),
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  CHECK (buys_from_id <> id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES customer_types(tenant_id, id),
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id),
  FOREIGN KEY (tenant_id, buys_from_id) REFERENCES trade_customers(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_customer_id) REFERENCES customers(tenant_id, id)
);
CREATE UNIQUE INDEX trade_customers_code_idx ON trade_customers(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX trade_customers_cursor_idx ON trade_customers(tenant_id, lower(code) text_pattern_ops, id);
CREATE INDEX trade_customers_beat_idx ON trade_customers(tenant_id, beat_id) WHERE deleted_at IS NULL;
CREATE INDEX trade_customers_type_idx ON trade_customers(tenant_id, type_id, status);
CREATE INDEX trade_customers_rep_idx ON trade_customers(tenant_id, rep_id) WHERE deleted_at IS NULL;
CREATE INDEX trade_customers_territory_idx ON trade_customers(tenant_id, territory_id);
-- One planning account is one trade customer at most, so sales never double-counts.
CREATE UNIQUE INDEX trade_customers_sales_idx ON trade_customers(tenant_id, sales_customer_id)
  WHERE deleted_at IS NULL AND sales_customer_id IS NOT NULL;

-- ---------- The ordered stops of a beat ----------
-- Only customers whose type is on the beat plan appear here. The sequence is the walking order.
CREATE TABLE beat_outlets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  beat_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 500),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, beat_id, customer_id),
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id)
);
-- Two outlets never share a position in the same beat. Deferrable, because re-ordering a round
-- swaps positions and would collide halfway through an otherwise valid new order; the check still
-- runs, just at the end of the transaction that does the re-ordering.
ALTER TABLE beat_outlets
  ADD CONSTRAINT beat_outlets_order_uniq UNIQUE (tenant_id, beat_id, sequence)
  DEFERRABLE INITIALLY IMMEDIATE;
-- A customer is a stop on one beat only, so a visit is never ambiguous.
CREATE UNIQUE INDEX beat_outlets_customer_idx ON beat_outlets(tenant_id, customer_id);

-- ---------- Who walks a beat, and from when ----------
-- Dated, so last quarter's adherence still reads against the rep who actually had the beat.
CREATE TABLE beat_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  beat_id uuid NOT NULL,
  rep_id uuid NOT NULL,
  from_date date NOT NULL,
  -- Open-ended until someone else takes the beat over.
  to_date date,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK (to_date IS NULL OR to_date >= from_date),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id)
);
-- One spell per beat per start date: the target an import's upsert matches on.
CREATE UNIQUE INDEX beat_assignments_spell_idx ON beat_assignments(tenant_id, beat_id, from_date)
  WHERE deleted_at IS NULL;
CREATE INDEX beat_assignments_beat_idx ON beat_assignments(tenant_id, beat_id, from_date);
CREATE INDEX beat_assignments_rep_idx ON beat_assignments(tenant_id, rep_id, from_date);
-- A beat has one open holder at a time. Closed spells may sit side by side; the overlap rule for
-- those is checked in code, which can give the reader the dates that clash.
CREATE UNIQUE INDEX beat_assignments_open_idx ON beat_assignments(tenant_id, beat_id)
  WHERE deleted_at IS NULL AND to_date IS NULL;

-- ---------- Every tag and re-tag of a shop's location ----------
CREATE TABLE customer_geo_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  source text NOT NULL CHECK (source IN ('DEVICE','TYPED','PIN')),
  accuracy_m integer CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
  -- How far this moved the tag from where it was. Null for the first tag.
  moved_m integer CHECK (moved_m IS NULL OR moved_m >= 0),
  -- APPLIED straight away, or PENDING because it moved further than retag_approval_m.
  status text NOT NULL CHECK (status IN ('APPLIED','PENDING','APPROVED','REJECTED')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  requested_by uuid,
  requested_by_subject text,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id)
);
CREATE INDEX customer_geo_log_customer_idx ON customer_geo_log(tenant_id, customer_id, created_at DESC);
-- One request at a time per customer, so two reps cannot queue conflicting moves.
CREATE UNIQUE INDEX customer_geo_log_pending_idx ON customer_geo_log(tenant_id, customer_id)
  WHERE status = 'PENDING';

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['reach_settings','customer_types','customer_form_fields','customer_form_rules','beats','trade_customers','beat_outlets','beat_assignments','customer_geo_log'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- No DELETE on anything that is a record of a decision or a customer. beat_outlets is the one
-- exception: an outlet leaving a beat is a change to a round, not a record to keep, and the walk
-- order has to stay a clean 1..n.
GRANT SELECT, INSERT, UPDATE ON reach_settings, customer_types, customer_form_fields,
  customer_form_rules, beats, trade_customers, beat_assignments, customer_geo_log TO rare_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON beat_outlets TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.approve', 'Reach', 'Approve new customer accounts and location re-tags'),
('reach.setup', 'Reach', 'Change customer types, customer forms and Reach settings')
ON CONFLICT (code) DO NOTHING;
