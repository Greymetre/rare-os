-- AV-0 Availability foundation: company-wide units, number series, staged CSV imports and
-- cross-company outbox dispatch without giving the runtime role cross-tenant table access.

CREATE TABLE number_series (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  series text NOT NULL,
  next_value bigint NOT NULL CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, series)
);

-- Concurrency-safe: the upsert row lock serialises callers per company and series.
CREATE FUNCTION next_number(series_name text) RETURNS bigint LANGUAGE sql SET search_path=public,pg_temp AS $$
  INSERT INTO number_series(tenant_id, series, next_value)
  VALUES (nullif(current_setting('app.tenant_id', true), '')::uuid, series_name, 2)
  ON CONFLICT (tenant_id, series) DO UPDATE SET next_value = number_series.next_value + 1
  RETURNING next_value - 1
$$;

CREATE TABLE units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  decimals smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 6),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX units_code_ci_idx ON units(tenant_id, lower(code));
CREATE INDEX units_cursor_idx ON units(tenant_id, lower(code) text_pattern_ops, id);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  batch_no bigint NOT NULL,
  kind text NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('validating','validated','committing','committed','failed','cancelled')),
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}',
  error text,
  created_by uuid,
  created_by_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  committed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, batch_no)
);
-- The same file content can only be committed once per company and import type.
CREATE UNIQUE INDEX import_committed_file_idx ON import_batches(tenant_id, kind, file_sha256) WHERE status = 'committed';
CREATE INDEX import_batches_cursor_idx ON import_batches(tenant_id, created_at DESC, id);

CREATE TABLE import_rows (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no >= 2),
  data jsonb NOT NULL,
  value jsonb,
  errors jsonb NOT NULL DEFAULT '[]',
  action text CHECK (action IN ('create','update','unchanged')),
  PRIMARY KEY (tenant_id, batch_id, line_no),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches(tenant_id, id)
);
CREATE INDEX import_rows_errors_idx ON import_rows(tenant_id, batch_id, line_no) WHERE errors <> '[]';

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['number_series','units','import_batches','import_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- Import rows are staging data: never deleted or edited by the API outside validation/commit.
GRANT SELECT, INSERT, UPDATE ON number_series, units, import_batches TO rare_app;
GRANT SELECT, INSERT ON import_rows TO rare_app;
GRANT UPDATE(errors, action, value) ON import_rows TO rare_app;
REVOKE ALL ON FUNCTION next_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_number(text) TO rare_app;

-- Outbox dispatch across companies: expose only ids and kinds; payloads stay tenant-scoped.
CREATE FUNCTION outbox_pending(max_events integer) RETURNS TABLE(id bigint, tenant_id uuid, kind text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT id, tenant_id, kind FROM outbox_events WHERE delivered_at IS NULL ORDER BY id LIMIT least(greatest(max_events, 1), 500)
$$;
REVOKE ALL ON FUNCTION outbox_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_pending(integer) TO rare_app;
