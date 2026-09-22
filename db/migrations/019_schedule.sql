-- AV-6 capacity and scheduler (Nilkamal simulation handover, 21-Sep-2026: Scheduler, Gantt,
-- Resource load, Release schedule, Lead time reality). The schedule is derived: every planning
-- run schedules each plant's open production orders forward on its resources and stores the
-- result with the run. A planner publishes a run's schedule as the committed plan.

-- Planned utilisation of a resource (the work centre master's plan figure); it drives the queue
-- time in the dynamic lead time of made items. Blank = no queue.
ALTER TABLE resources ADD COLUMN planned_utilization_pct numeric(12,6)
  CHECK (planned_utilization_pct >= 0 AND planned_utilization_pct <= 1000);
-- Reference lot for a made item's dynamic lead time (the average order quantity).
ALTER TABLE item_buffers ADD COLUMN reference_lot numeric(18,6) CHECK (reference_lot > 0);

-- One row per plant: scheduling and lead-time policy.
CREATE TABLE plant_planning (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  -- Same-item orders whose due dates are at most this many days apart run back to back, unless
  -- pulling one forward makes another order later than its promise. 0 = no grouping.
  club_window_days integer NOT NULL DEFAULT 1 CHECK (club_window_days BETWEEN 0 AND 30),
  -- FIXED: made-item zones on the master lead time. PLANNED_LOAD: master lead time plus the
  -- queue each routed resource adds at its planned utilisation (shaped by the day profile).
  lead_time_basis text NOT NULL DEFAULT 'FIXED' CHECK (lead_time_basis IN ('FIXED','PLANNED_LOAD')),
  -- Despatch profile: share of a month's volume on each day 1..31 (sums to about 100).
  day_weights numeric(10,6)[] CHECK (day_weights IS NULL OR array_length(day_weights, 1) = 31),
  profile_day integer NOT NULL DEFAULT 7 CHECK (profile_day BETWEEN 1 AND 31),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);
CREATE TRIGGER plant_planning_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON plant_planning
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['calendars','calendar_shifts','calendar_holidays','resources','routings','routing_operations'] LOOP
 EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs()', tbl || '_planning_inputs', tbl);
 END LOOP;
END $$;

ALTER TABLE planning_results
  ADD COLUMN lead_time_live numeric(12,4),
  ADD COLUMN lead_time_factor numeric(12,6);

-- Per plant and run: the time axis and the result summary.
-- Minutes are plant working minutes from the start of the first schedule day.
CREATE TABLE schedule_plants (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  site_id uuid NOT NULL,
  start_date date NOT NULL,
  day_minutes integer NOT NULL,
  -- The working dates of the axis: day index i is day_dates[i+1].
  day_dates date[] NOT NULL,
  -- Clock start of each working minute block: [{ offset, minutes, start }] per shift, minutes of day.
  shifts jsonb NOT NULL DEFAULT '[]',
  drum_resource_id uuid,
  orders integer NOT NULL DEFAULT 0,
  late integer NOT NULL DEFAULT 0,
  unscheduled integer NOT NULL DEFAULT 0,
  makespan_min numeric(18,4) NOT NULL DEFAULT 0,
  changeover_saved_min numeric(18,4) NOT NULL DEFAULT 0,
  messages jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, run_id, site_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);

CREATE TABLE schedule_orders (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  site_id uuid NOT NULL,
  production_order_id uuid NOT NULL,
  position integer NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','unscheduled')),
  start_min numeric(18,4),
  finish_min numeric(18,4),
  release_date date,
  finish_date date,
  promise_date date NOT NULL,
  slack_min numeric(18,4),
  late_days integer,
  grouped_with uuid,
  material_check text,
  messages jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, run_id, site_id, production_order_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);
CREATE INDEX schedule_orders_position_idx ON schedule_orders(tenant_id, run_id, site_id, position);

CREATE TABLE schedule_operations (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  site_id uuid NOT NULL,
  production_order_id uuid NOT NULL,
  sequence integer NOT NULL,
  operation_code text NOT NULL,
  resource_id uuid NOT NULL,
  machine integer NOT NULL,
  changeover_min numeric(18,4) NOT NULL,
  run_min numeric(18,4) NOT NULL,
  start_min numeric(18,4) NOT NULL,
  finish_min numeric(18,4) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, production_order_id, sequence),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);
CREATE INDEX schedule_operations_lane_idx ON schedule_operations(tenant_id, run_id, resource_id, machine, start_min);

CREATE TABLE schedule_resources (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  site_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  drum boolean NOT NULL DEFAULT false,
  machines integer NOT NULL,
  run_min numeric(18,4) NOT NULL,
  changeover_min numeric(18,4) NOT NULL,
  changeovers integer NOT NULL,
  -- Effective capacity per working day of all machines, in the resource's own minutes.
  capacity_per_day numeric(18,4) NOT NULL,
  utilization numeric(12,6) NOT NULL,
  -- [{ machine, run, changeover, changeovers, finish }] and per-day busy share [0..1].
  lanes jsonb NOT NULL DEFAULT '[]',
  days jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, run_id, site_id, resource_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);

-- A planner commits a run's schedule for a plant. The newest row per plant is the published plan.
CREATE TABLE schedule_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  run_id uuid NOT NULL,
  run_no bigint NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  published_by uuid,
  published_by_subject text,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);
CREATE INDEX schedule_publications_recent_idx ON schedule_publications(tenant_id, site_id, published_at DESC);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['plant_planning','schedule_plants','schedule_orders','schedule_operations','schedule_resources','schedule_publications'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON plant_planning TO rare_app;
-- Schedules are derived with their run and pruned with it; publications are a permanent record.
GRANT SELECT, INSERT, DELETE ON schedule_plants, schedule_orders, schedule_operations, schedule_resources TO rare_app;
GRANT SELECT, INSERT ON schedule_publications TO rare_app;

UPDATE permissions SET description = 'Publish a calculated schedule as the committed plan' WHERE code = 'schedule.publish';
UPDATE permissions SET description = 'View buffers, schedules and planning results' WHERE code = 'planning.read';
