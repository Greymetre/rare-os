-- AV-4 material buffers: buffer profiles, per-plant buffer settings and versioned planning runs.
-- Planning results are derived and recomputable. Input changes leave markers; queueing a run
-- consumes the visible markers, so a change committed later always triggers another run. Runs are
-- promoted in queue order: a run queued earlier never replaces the result of a later one.

CREATE TABLE buffer_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- red = yellow x red_base_pct x (1 + red_safety_pct); green = max(yellow x green_pct, ADU x order cycle, MOQ)
  red_base_pct numeric(6,2) NOT NULL CHECK (red_base_pct > 0 AND red_base_pct <= 200),
  red_safety_pct numeric(6,2) NOT NULL DEFAULT 0 CHECK (red_safety_pct BETWEEN 0 AND 200),
  green_pct numeric(6,2) NOT NULL CHECK (green_pct > 0 AND green_pct <= 300),
  order_cycle_days integer CHECK (order_cycle_days BETWEEN 1 AND 365),
  -- A future order qualifies as a spike when that day's demand reaches this share of the red zone.
  spike_threshold_pct numeric(6,2) NOT NULL DEFAULT 50 CHECK (spike_threshold_pct > 0 AND spike_threshold_pct <= 500),
  adu_window_days integer NOT NULL DEFAULT 90 CHECK (adu_window_days BETWEEN 7 AND 365),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX buffer_profiles_code_idx ON buffer_profiles(tenant_id, lower(code));

-- Which items a plant buffers (BUFFER) or makes/buys to order (MTO: no buffer, demand passes down).
CREATE TABLE item_buffers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  policy text NOT NULL CHECK (policy IN ('BUFFER','MTO')),
  profile_id uuid,
  -- NULL: the preferred supplier's lead time for bought items; required for made items.
  lead_time_days integer CHECK (lead_time_days BETWEEN 0 AND 365),
  adu_override numeric(18,6) CHECK (adu_override > 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (policy <> 'BUFFER' OR profile_id IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, item_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES buffer_profiles(tenant_id, id)
);

-- Every statement that changes a planning input appends a marker. Appending (not updating one
-- counter row) keeps concurrent writers from waiting on each other.
CREATE SEQUENCE planning_input_seq;
CREATE TABLE planning_input_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version bigint NOT NULL DEFAULT nextval('planning_input_seq'),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- One row per company: the current run and its run number (the promotion order).
CREATE TABLE planning_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  current_run_id uuid,
  current_run_no bigint
);

CREATE TABLE planning_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_no bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','completed','superseded','failed')),
  trigger text NOT NULL CHECK (trigger IN ('auto','manual')),
  -- Highest input marker consumed when queued (for support; ordering uses run_no).
  input_version bigint NOT NULL,
  as_of date,
  requested_by uuid,
  requested_by_subject text,
  summary jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_no)
);
CREATE INDEX planning_runs_recent_idx ON planning_runs(tenant_id, run_no DESC);
ALTER TABLE planning_state ADD FOREIGN KEY (tenant_id, current_run_id) REFERENCES planning_runs(tenant_id, id);

CREATE TABLE planning_results (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  policy text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','missing','not_applicable')),
  adu numeric(24,6) NOT NULL,
  dlt integer,
  top_of_red numeric(24,6),
  top_of_yellow numeric(24,6),
  top_of_green numeric(24,6),
  on_hand numeric(24,6) NOT NULL,
  open_supply numeric(24,6) NOT NULL,
  qualified_demand numeric(24,6) NOT NULL,
  spike_demand numeric(24,6) NOT NULL,
  outside_horizon numeric(24,6) NOT NULL,
  nfp numeric(24,6),
  zone text CHECK (zone IN ('breach','red','yellow','green','excess')),
  priority_pct numeric(24,6),
  on_hand_alert text,
  recommended_kind text,
  recommended_qty numeric(24,6),
  recommended_purchase_qty numeric(24,6),
  purchase_unit text,
  supplier_id uuid,
  due_date date,
  messages jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, run_id, site_id, item_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES planning_runs(tenant_id, id)
);
-- Board order: most urgent first (lowest net flow as % of top of green).
CREATE INDEX planning_results_board_idx ON planning_results(tenant_id, run_id, site_id, priority_pct, item_id);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['buffer_profiles','item_buffers','planning_input_events','planning_state','planning_runs','planning_results'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON buffer_profiles, item_buffers, planning_state, planning_runs TO rare_app;
-- Results are derived: old runs are pruned, and settled input events are compacted.
GRANT SELECT, INSERT, DELETE ON planning_results, planning_input_events TO rare_app;
GRANT USAGE ON SEQUENCE planning_input_seq TO rare_app;

-- Every change to a planning input moves the company's input version forward.
CREATE FUNCTION touch_planning_inputs() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE company uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF company IS NOT NULL THEN
    INSERT INTO planning_input_events(tenant_id) VALUES (company);
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['sites','units','items','unit_conversions','suppliers','item_suppliers','boms','bom_lines',
   'stock_locations','stock_movements','sales_orders','sales_order_lines','purchase_orders','purchase_order_lines',
   'demand_history','buffer_profiles','item_buffers'] LOOP
 EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs()', tbl || '_planning_inputs', tbl);
 END LOOP;
END $$;

-- The worker's recompute tick across companies: only ids, and only after inputs settle for a moment.
CREATE FUNCTION planning_due(max_companies integer) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT tenant_id FROM planning_input_events GROUP BY tenant_id
  HAVING max(changed_at) < now() - interval '2 seconds'
  ORDER BY max(changed_at) LIMIT least(greatest(max_companies, 1), 100)
$$;
REVOKE ALL ON FUNCTION planning_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION planning_due(integer) TO rare_app;

-- Makes a finished run current unless a later-queued run is already current. Returns true if promoted.
CREATE FUNCTION promote_planning_run(run uuid, run_number bigint) RETURNS boolean
LANGUAGE sql SET search_path=public,pg_temp AS $$
  WITH promoted AS (
    UPDATE planning_state SET current_run_id = run, current_run_no = run_number
    WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND (current_run_no IS NULL OR current_run_no < run_number)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM promoted)
$$;
REVOKE ALL ON FUNCTION promote_planning_run(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_planning_run(uuid, bigint) TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('buffers.manage', 'Availability', 'Maintain buffer profiles and buffer settings')
ON CONFLICT (code) DO NOTHING;
UPDATE permissions SET description = 'View buffer board and planning results' WHERE code = 'planning.read';
UPDATE permissions SET description = 'Recalculate buffers on demand' WHERE code = 'planning.run';
