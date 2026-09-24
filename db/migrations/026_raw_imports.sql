-- AV-12 raw imports: the file exactly as it arrived from the ERP, the mapping that reads a sheet
-- of it, and the trail from any imported number back to the row it came from.
-- Reference: Nilkamal simulation handover (21-Sep-2026), "Import contracts and source traps":
-- preserve source filename, sheet, row, plant, material code and UOM; SAP headers repeat, so a
-- column is addressed by position; a missing value is unknown, not zero.

CREATE TABLE import_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_no bigint NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  file_format text NOT NULL CHECK (file_format IN ('xlsx', 'xls', 'csv')),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The bytes themselves, so a reconciliation can always be run against the original.
  content bytea NOT NULL,
  sheets jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  uploaded_by uuid,
  uploaded_by_subject text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, file_no)
);
-- The same bytes are kept once per company, however many sheets are imported from them.
CREATE UNIQUE INDEX import_files_sha_idx ON import_files(tenant_id, sha256);
CREATE INDEX import_files_cursor_idx ON import_files(tenant_id, uploaded_at DESC, id);

-- A saved mapping: which sheet, which header row, and which column feeds each of our fields.
CREATE TABLE import_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  sheet text NOT NULL DEFAULT '' CHECK (length(sheet) <= 120),
  header_row integer NOT NULL DEFAULT 1 CHECK (header_row BETWEEN 1 AND 1000),
  first_data_row integer CHECK (first_data_row IS NULL OR first_data_row > 1),
  -- { field: { by: 'position'|'name'|'constant', index, name, occurrence, transform, format } }
  columns jsonb NOT NULL,
  -- { dateFormat, decimal, uomAliases, skipBlankRows }
  options jsonb NOT NULL DEFAULT '{}',
  -- The header as a signature, so the same export shape suggests this mapping next month.
  fingerprint text NOT NULL DEFAULT '' CHECK (length(fingerprint) <= 4000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX import_mappings_code_idx ON import_mappings(tenant_id, lower(code));
CREATE INDEX import_mappings_kind_idx ON import_mappings(tenant_id, kind, lower(code));

-- What a batch was read from, and what could be said about the reading.
ALTER TABLE import_batches
  ADD COLUMN file_id uuid,
  ADD COLUMN sheet text NOT NULL DEFAULT '',
  ADD COLUMN header_row integer,
  ADD COLUMN mapping jsonb,
  ADD COLUMN source_rows integer,
  ADD COLUMN reconciliation jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT import_batches_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES import_files(tenant_id, id);

-- The row number in the sheet, which is not the same as the staged line once a header row moves.
ALTER TABLE import_rows ADD COLUMN source_row integer;

-- One workbook holds a sheet per plant, so the same file is legitimately imported more than once
-- for the same kind. What may not repeat is the same file, kind AND sheet.
DROP INDEX import_committed_file_idx;
CREATE UNIQUE INDEX import_committed_file_idx
  ON import_batches(tenant_id, kind, file_sha256, sheet) WHERE status = 'committed';

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['import_files','import_mappings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON import_files, import_mappings TO rare_app;

-- The file number comes from next_number('import_file'), which creates its own series row.
