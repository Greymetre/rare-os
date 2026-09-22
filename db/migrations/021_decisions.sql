-- AV-7 planning decisions (Nilkamal simulation handover, 21-Sep-2026: Club / date scenarios,
-- drag resequencing, time-phased material readiness). A planner's decisions are explicit records:
-- a manual order of work, pinned groups with their release day, and per-lot release days. The
-- schedule of every planning run applies them; the decision history is append-only.

CREATE TABLE plant_sequence (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  -- Production order numbers in the planner's order; NULL = the computed sequence.
  manual_order text[],
  -- Pinned groups: [{ id, ids: [order numbers], item, day: 'YYYY-MM-DD', beforeId, savedMin, carryUnits, decisionNo }]
  groups jsonb NOT NULL DEFAULT '[]',
  -- Earliest release per production order id: { "<uuid>": "YYYY-MM-DD" }
  releases jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  CHECK (jsonb_typeof(groups) = 'array' AND jsonb_typeof(releases) = 'object')
);
CREATE TRIGGER plant_sequence_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON plant_sequence
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

CREATE TABLE planning_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  decision_no bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('club','declub','move','release_manual')),
  orders text[] NOT NULL DEFAULT '{}',
  -- Calculation the planner reviewed, the scenario and the measured impact.
  run_no bigint NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  decided_by uuid,
  decided_by_subject text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, decision_no),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);
CREATE INDEX planning_decisions_recent_idx ON planning_decisions(tenant_id, site_id, decision_no DESC);

ALTER TABLE schedule_orders
  -- Time-phased readiness lines: [{ component, lot, release, requirement, onHand, timely, before, available, shortage, unknown, replenish, later }]
  ADD COLUMN material_lines jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN plan_group text,
  ADD COLUMN manual_placed boolean NOT NULL DEFAULT false,
  ADD COLUMN release_min numeric(18,4);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['plant_sequence','planning_decisions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON plant_sequence TO rare_app;
GRANT SELECT, INSERT ON planning_decisions TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('schedule.plan', 'Availability', 'Change the schedule: move, club and declub orders')
ON CONFLICT (code) DO NOTHING;
