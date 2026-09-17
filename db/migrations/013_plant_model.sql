-- AV-2 plant model: calendars, resources, BOM versions and routings.
-- Calendars, resources and routings belong to a plant; BOMs are company-wide.
-- Header + lines are saved together; lines are replaced as a set. No hard deletes of headers.

CREATE TABLE calendars (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Seven characters Monday..Sunday, '1' = working day, e.g. 1111110.
  working_days text NOT NULL CHECK (working_days ~ '^[01]{7}$' AND working_days <> '0000000'),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);
CREATE UNIQUE INDEX calendars_code_idx ON calendars(tenant_id, site_id, lower(code));
CREATE UNIQUE INDEX calendars_default_idx ON calendars(tenant_id, site_id) WHERE is_default AND active;

-- end_time <= start_time means the shift crosses midnight.
CREATE TABLE calendar_shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 10),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes smallint NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 600),
  UNIQUE (tenant_id, calendar_id, sequence),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES calendars(tenant_id, id)
);

CREATE TABLE calendar_holidays (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  UNIQUE (tenant_id, calendar_id, holiday_date),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES calendars(tenant_id, id)
);

CREATE TABLE resources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  resource_type text NOT NULL CHECK (resource_type IN ('MACHINE','LINE','MANUAL')),
  machine_count integer NOT NULL CHECK (machine_count BETWEEN 1 AND 999),
  efficiency_pct numeric(5,2) NOT NULL DEFAULT 100 CHECK (efficiency_pct > 0 AND efficiency_pct <= 100),
  changeover_minutes numeric(10,2) NOT NULL DEFAULT 0 CHECK (changeover_minutes BETWEEN 0 AND 1440),
  -- NULL: use the plant's default calendar.
  calendar_id uuid,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES calendars(tenant_id, id)
);
CREATE UNIQUE INDEX resources_code_idx ON resources(tenant_id, site_id, lower(code));

-- `revision` is the business version label (e.g. V1); `version` is the optimistic-lock counter.
CREATE TABLE boms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  effective_from date NOT NULL,
  effective_to date,
  base_quantity numeric(18,6) NOT NULL DEFAULT 1 CHECK (base_quantity > 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE UNIQUE INDEX boms_revision_idx ON boms(tenant_id, item_id, lower(revision));

CREATE TABLE bom_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  bom_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  component_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit_id uuid NOT NULL,
  scrap_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),
  UNIQUE (tenant_id, bom_id, line_no),
  UNIQUE (tenant_id, bom_id, component_item_id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms(tenant_id, id),
  FOREIGN KEY (tenant_id, component_item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE INDEX bom_lines_component_idx ON bom_lines(tenant_id, component_item_id);

CREATE TABLE routings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  effective_from date NOT NULL,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE UNIQUE INDEX routings_revision_idx ON routings(tenant_id, site_id, item_id, lower(revision));

-- Operations are ordered by sequence and identified by operation code, never by position.
CREATE TABLE routing_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  routing_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 9999),
  operation_code text NOT NULL CHECK (operation_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 120),
  resource_id uuid NOT NULL,
  setup_minutes numeric(10,2) NOT NULL DEFAULT 0 CHECK (setup_minutes BETWEEN 0 AND 1440),
  run_minutes_per_unit numeric(18,6) NOT NULL CHECK (run_minutes_per_unit > 0),
  UNIQUE (tenant_id, routing_id, sequence),
  FOREIGN KEY (tenant_id, routing_id) REFERENCES routings(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id)
);
CREATE UNIQUE INDEX routing_operations_code_idx ON routing_operations(tenant_id, routing_id, lower(operation_code));
CREATE INDEX routing_operations_resource_idx ON routing_operations(tenant_id, resource_id);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['calendars','calendar_shifts','calendar_holidays','resources','boms','bom_lines','routings','routing_operations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON calendars, resources, boms, routings TO rare_app;
-- Line tables are replaced as a set when their header is saved.
GRANT SELECT, INSERT, DELETE ON calendar_shifts, calendar_holidays, bom_lines, routing_operations TO rare_app;
