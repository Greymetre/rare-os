-- RCH-4: the visit, and the report a rep writes on the way out.
--
-- The milestone plan calls this the heart of Reach, and the handover is explicit that it has to
-- be solid on the server before a mobile app is written against it. Three rules are built into
-- this file.
--
-- **A check-in is never refused.** A rep standing 800 metres from the shop is recorded and
-- flagged. There is no constraint here that can reject one: refusing it would lose a real visit
-- and teach the salesman to distrust the app. `distance_m` and `out_of_fence` are evidence. What
-- a company does about them is a decision taken later, by a person, with the evidence in front
-- of them.
--
-- **The same check-in sent three times is one visit.** A field connection drops and the app
-- retries. Two indexes make that safe rather than hopeful: a rep can hold only one open visit per
-- shop, and a client reference may be used only once.
--
-- **How a visit reads is calculated.** There is no status column, no duration column and no
-- "report complete" flag. The duration is the two timestamps; the status and the completeness
-- are read against the report form as it stands now, so adding a required question makes the
-- older reports say they are missing it instead of a stored flag that has quietly stopped being
-- true.
--
-- The visits table itself was created by RCH-3 (migration 032), which needed something to read
-- for plan-versus-actual. This is the rest of it.

-- ---------- The visit ----------
ALTER TABLE visits ADD COLUMN checked_out_at timestamptz;
ALTER TABLE visits ADD COLUMN out_latitude numeric(9,6) CHECK (out_latitude BETWEEN -90 AND 90);
ALTER TABLE visits ADD COLUMN out_longitude numeric(9,6) CHECK (out_longitude BETWEEN -180 AND 180);
ALTER TABLE visits ADD COLUMN out_accuracy_m integer
  CHECK (out_accuracy_m IS NULL OR out_accuracy_m BETWEEN 0 AND 100000);
ALTER TABLE visits ADD COLUMN out_source text CHECK (out_source IN ('DEVICE','TYPED','PIN'));
-- The answers to the customer type's own report form, keyed by visit_form_fields.field_key.
ALTER TABLE visits ADD COLUMN report jsonb NOT NULL DEFAULT '{}';
-- What the app calls this visit. Sent by the device, so a retry on a bad line carries the same
-- one and is answered with the visit that already exists instead of making a second.
ALTER TABLE visits ADD COLUMN client_ref text NOT NULL DEFAULT ''
  CHECK (length(client_ref) <= 80);
-- Which beat the round was walked under, when the rep was on one. Copied at check-in, because a
-- customer may be moved to another beat later and this visit still happened on that round.
ALTER TABLE visits ADD COLUMN beat_id uuid;

ALTER TABLE visits ADD CONSTRAINT visits_out_after_in
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at);
ALTER TABLE visits ADD CONSTRAINT visits_out_place
  CHECK ((out_latitude IS NULL) = (out_longitude IS NULL));
-- A location can only be recorded for a visit that has ended.
ALTER TABLE visits ADD CONSTRAINT visits_out_needs_checkout
  CHECK (checked_out_at IS NOT NULL OR (out_latitude IS NULL AND out_source IS NULL));
ALTER TABLE visits ADD CONSTRAINT visits_beat_fk
  FOREIGN KEY (tenant_id, beat_id) REFERENCES beats(tenant_id, id);

-- A rep is inside one shop at a time, so a second check-in while one is open is the same visit.
CREATE UNIQUE INDEX visits_open_idx ON visits(tenant_id, rep_id, customer_id)
  WHERE checked_out_at IS NULL;
-- One reference, one visit. This is what makes a retry safe on a dropped connection.
CREATE UNIQUE INDEX visits_client_ref_idx ON visits(tenant_id, client_ref)
  WHERE client_ref <> '';
CREATE INDEX visits_beat_idx ON visits(tenant_id, beat_id, visit_date);

-- ---------- The report form, per customer type ----------
-- The same matrix the customer form uses, and the same engine reads both: a list of questions,
-- and a rule per type saying whether each one is required, optional or not asked. A distributor
-- call and a retailer call are different conversations, so they are different forms.
CREATE TABLE visit_form_fields (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- The key the answer is stored under in visits.report.
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  input text NOT NULL CHECK (input IN ('text','textarea','number','select','date','phone','email','gstin','pan','bool')),
  section text NOT NULL DEFAULT 'Details' CHECK (length(section) BETWEEN 1 AND 60),
  display_order integer NOT NULL DEFAULT 100 CHECK (display_order BETWEEN 1 AND 9999),
  options text NOT NULL DEFAULT '' CHECK (length(options) <= 1000),
  help text NOT NULL DEFAULT '' CHECK (length(help) <= 200),
  default_value text NOT NULL DEFAULT '' CHECK (length(default_value) <= 200),
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
CREATE UNIQUE INDEX visit_form_fields_key_idx ON visit_form_fields(tenant_id, field_key) WHERE deleted_at IS NULL;
CREATE INDEX visit_form_fields_cursor_idx ON visit_form_fields(tenant_id, field_key text_pattern_ops, id);

CREATE TABLE visit_form_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type_id uuid NOT NULL,
  field_id uuid NOT NULL,
  requirement text NOT NULL DEFAULT 'O' CHECK (requirement IN ('R','O','X')),
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
  FOREIGN KEY (tenant_id, field_id) REFERENCES visit_form_fields(tenant_id, id)
);
CREATE UNIQUE INDEX visit_form_rules_pair_idx ON visit_form_rules(tenant_id, type_id, field_id) WHERE deleted_at IS NULL;
CREATE INDEX visit_form_rules_field_idx ON visit_form_rules(tenant_id, field_id);

-- ---------- Settings ----------
-- How long after a check-in the same check-in may arrive again and still be the same visit. This
-- is the retry window a bad field connection needs; beyond it, a second call is a second call.
ALTER TABLE reach_settings ADD COLUMN visit_dedupe_minutes integer NOT NULL DEFAULT 10
  CHECK (visit_dedupe_minutes BETWEEN 0 AND 240);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['visit_form_fields','visit_form_rules'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- The report form is setup and may be withdrawn like any other master, so it is soft-deleted and
-- the runtime role still gets no DELETE. The visit itself was already granted by migration 032,
-- without DELETE, and stays that way: a visit is a record of what happened.
GRANT SELECT, INSERT, UPDATE ON visit_form_fields, visit_form_rules TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.visit', 'Reach', 'Check in and out of the shops on your own round')
ON CONFLICT (code) DO NOTHING;
