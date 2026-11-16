-- RCH-0 Reach foundation (developer handover 27-Oct-2026): the field masters every Reach screen
-- stands on, a place to keep photos that is not the database, and soft delete.
-- * Field masters are ordinary company-wide masters, so they reach the screens, the forms and the
--   Excel/CSV import through the same machinery the planning masters already use.
-- * A field rep is a master record first and a login second: the rep list arrives from a
--   spreadsheet long before anyone issues logins, so user_id is filled in later and may stay empty.
-- * Soft delete: 'removing' a record only stamps deleted_at (deleted_by stays empty for a
--   platform administrator, who has no row in this company). The runtime role is never granted
--   DELETE on these tables, so a bug cannot lose field data. A removed code is free to use again,
--   which is why every uniqueness rule here is a partial index over the rows still in use.
-- * Photos and documents live on a disk volume. Only what is needed to find and serve them again
--   is stored here; the bytes are addressed by their own sha256, so the same photo is kept once.

CREATE TABLE territories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- A zone holds territories: the parent is a territory too, one level up.
  parent_id uuid,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id <> id),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES territories(tenant_id, id)
);
CREATE UNIQUE INDEX territories_code_ci_idx ON territories(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX territories_cursor_idx ON territories(tenant_id, lower(code) text_pattern_ops, id);
CREATE INDEX territories_parent_idx ON territories(tenant_id, parent_id);

CREATE TABLE rep_grades (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Seniority, lowest first. The expense slabs of RCH-6 are read in this order.
  rank smallint NOT NULL DEFAULT 1 CHECK (rank BETWEEN 1 AND 99),
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
CREATE UNIQUE INDEX rep_grades_code_ci_idx ON rep_grades(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX rep_grades_cursor_idx ON rep_grades(tenant_id, lower(code) text_pattern_ops, id);

CREATE TABLE leave_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  paid boolean NOT NULL DEFAULT true,
  -- Days a rep may take in a year. Half days are why this is not an integer.
  annual_quota numeric(6,1) NOT NULL DEFAULT 0 CHECK (annual_quota >= 0 AND annual_quota <= 999),
  carry_forward boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT true,
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
CREATE UNIQUE INDEX leave_types_code_ci_idx ON leave_types(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX leave_types_cursor_idx ON leave_types(tenant_id, lower(code) text_pattern_ops, id);

-- What a photo or document is, and where to find its bytes on the volume. The bytes themselves are
-- never here: this row is the handle the rest of the system holds.
CREATE TABLE stored_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_no bigint NOT NULL,
  -- What the file is for. The purpose decides who may see it and how long it is kept.
  purpose text NOT NULL CHECK (purpose IN ('selfie','kyc','receipt','shelf','other')),
  -- Allowlist, not a guess from the name: the file is served back with exactly this type.
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Path under the volume root, derived from the sha256 and never from anything a caller sent.
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.(jpg|png|webp|pdf)$'),
  pixel_width integer CHECK (pixel_width > 0),
  pixel_height integer CHECK (pixel_height > 0),
  uploaded_by uuid,
  uploaded_by_subject text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, file_no)
);
CREATE INDEX stored_files_cursor_idx ON stored_files(tenant_id, uploaded_at DESC, id);
CREATE INDEX stored_files_sha_idx ON stored_files(tenant_id, sha256);

CREATE TABLE field_reps (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  grade_id uuid NOT NULL,
  territory_id uuid NOT NULL,
  -- The login, once there is one. A rep imported from a spreadsheet has none.
  user_id uuid,
  photo_file_id uuid,
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  joined_on date,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES rep_grades(tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users(tenant_id, id),
  FOREIGN KEY (tenant_id, photo_file_id) REFERENCES stored_files(tenant_id, id)
);
CREATE UNIQUE INDEX field_reps_code_ci_idx ON field_reps(tenant_id, lower(code)) WHERE deleted_at IS NULL;
-- One login belongs to one rep: two reps punching in as the same person would break attendance.
CREATE UNIQUE INDEX field_reps_user_idx ON field_reps(tenant_id, user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX field_reps_cursor_idx ON field_reps(tenant_id, lower(code) text_pattern_ops, id);
CREATE INDEX field_reps_territory_idx ON field_reps(tenant_id, territory_id);
CREATE INDEX field_reps_grade_idx ON field_reps(tenant_id, grade_id);

CREATE TABLE holidays (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  holiday_date date NOT NULL CHECK (holiday_date BETWEEN '2000-01-01' AND '2100-12-31'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  holiday_type text NOT NULL DEFAULT 'NATIONAL' CHECK (holiday_type IN ('NATIONAL','REGIONAL','OPTIONAL')),
  -- Blank territory means the whole company is off that day.
  territory_id uuid,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories(tenant_id, id)
);
CREATE UNIQUE INDEX holidays_day_idx
  ON holidays(tenant_id, holiday_date, coalesce(territory_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;
CREATE INDEX holidays_cursor_idx ON holidays(tenant_id, holiday_date, id);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['territories','rep_grades','leave_types','field_reps','holidays','stored_files'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- No DELETE: removal is an UPDATE that stamps deleted_at, so field data cannot be lost by mistake.
GRANT SELECT, INSERT, UPDATE ON territories, rep_grades, leave_types, field_reps, holidays, stored_files TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.read', 'Reach', 'View Reach field masters and readiness'),
('reach.manage', 'Reach', 'Maintain Reach field masters'),
('reach.delete', 'Reach', 'Remove a Reach record (it stays in the database)'),
('files.read', 'Reach', 'View uploaded photos and documents'),
('files.upload', 'Reach', 'Upload photos and documents')
ON CONFLICT (code) DO NOTHING;

-- The file number comes from next_number('stored_file'), which creates its own series row.
