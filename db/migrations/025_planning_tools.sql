-- AV-11 planning tools (Nilkamal simulation handover, 21-Sep-2026: Events & Seasons, Scheme Intake,
-- Target Mode, Space Mode, Recommended Buffers, Month Shape and the network screens).
-- * An event or a season is demand the history has not seen yet: inside its window the item's zones
--   are sized for the higher rate, and they rise early enough for its lead time.
-- * A scheme's expected volume is demand once the planner accepts it.
-- * A target and a space limit are simulations: they change nothing until the planner acts on them.

CREATE TABLE demand_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'EVENT' CHECK (kind IN ('EVENT','SEASON')),
  from_date date NOT NULL,
  to_date date NOT NULL,
  -- How much more than the trailing rate the window is expected to run at.
  uplift_pct numeric(8,2) NOT NULL CHECK (uplift_pct > -100 AND uplift_pct <= 1000),
  -- Empty = every item of the plant; otherwise the items named here.
  item_ids uuid[] NOT NULL DEFAULT '{}',
  family text NOT NULL DEFAULT '' CHECK (length(family) <= 60),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  CHECK (to_date >= from_date)
);
CREATE UNIQUE INDEX demand_events_code_idx ON demand_events(tenant_id, site_id, lower(code));
CREATE TRIGGER demand_events_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON demand_events
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

-- A scheme's expected volume: visible while it is proposed, demand once it is accepted.
CREATE TABLE demand_schemes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  item_id uuid NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  expected_units numeric(18,6) NOT NULL CHECK (expected_units > 0),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','accepted','declined')),
  decided_by uuid,
  decided_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  CHECK (to_date >= from_date)
);
CREATE UNIQUE INDEX demand_schemes_code_idx ON demand_schemes(tenant_id, site_id, lower(code));
CREATE TRIGGER demand_schemes_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON demand_schemes
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

-- What a stock location can hold, so a buffer set can be fitted to the space it has.
CREATE TABLE space_limits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  location_id uuid,
  measure text NOT NULL DEFAULT 'UNITS' CHECK (measure IN ('UNITS','VOLUME')),
  capacity numeric(18,4) NOT NULL CHECK (capacity > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_locations(tenant_id, id)
);
-- One limit per plant, and one per location.
CREATE UNIQUE INDEX space_limits_scope_idx ON space_limits(tenant_id, site_id,
  coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A sales target for a period, priced against history by the target screen.
CREATE TABLE sales_targets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  family text NOT NULL DEFAULT '' CHECK (length(family) <= 60),
  from_date date NOT NULL,
  to_date date NOT NULL,
  target_units numeric(18,6) NOT NULL CHECK (target_units > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  CHECK (to_date >= from_date)
);
CREATE UNIQUE INDEX sales_targets_code_idx ON sales_targets(tenant_id, site_id, lower(code));

-- Why a number is what it is: the assumptions the plan rests on.
CREATE TABLE planning_assumptions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  confirmed boolean NOT NULL DEFAULT false,
  confirmed_by uuid,
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, code),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);

-- What an event or a scheme did to a row, kept with the calculation that used it.
ALTER TABLE planning_results
  ADD COLUMN event_factor numeric(8,4),
  ADD COLUMN scheme_demand numeric(24,6);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['demand_events','demand_schemes','space_limits','sales_targets','planning_assumptions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON demand_events, demand_schemes, space_limits, sales_targets, planning_assumptions TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('planning.tools', 'Availability', 'Maintain events, schemes, targets and space limits')
ON CONFLICT (code) DO NOTHING;
