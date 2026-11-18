-- RCH-2: attendance and leave.
--
-- The monthly register is never stored. Present, Late, Half day, Leave, Absent, Week-off and
-- Holiday are read from the punch, the shift, the holiday list and the approved leave every time
-- they are asked for. Storing them would mean a shift change, a corrected punch or a
-- back-dated holiday leaving last month's register saying something the evidence no longer
-- supports. What is stored here is only evidence: when a rep started, when they ended, where
-- they were, what leave was approved, and what a correction changed.

CREATE TABLE work_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Field work must say where it began; office work need not.
  needs_location boolean NOT NULL DEFAULT true,
  -- A day of training still counts as attended; a day marked as personal does not.
  counts_present boolean NOT NULL DEFAULT true,
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
CREATE UNIQUE INDEX work_types_code_idx ON work_types(tenant_id, lower(code)) WHERE deleted_at IS NULL;

CREATE TABLE shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  -- Minutes after the start a rep may still arrive without being late.
  grace_minutes integer NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 0 AND 240),
  -- Work shorter than this is half a day. Shorter than the half-day floor is nothing at all.
  half_day_minutes integer NOT NULL DEFAULT 240 CHECK (half_day_minutes BETWEEN 30 AND 1440),
  min_minutes integer NOT NULL DEFAULT 60 CHECK (min_minutes BETWEEN 0 AND 1440),
  -- Days this shift does not run, in week order, e.g. SUN or SAT,SUN. Blank means every day.
  week_off text NOT NULL DEFAULT 'SUN'
    CHECK (week_off = '' OR week_off ~ '^(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*$'),
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK (min_minutes <= half_day_minutes),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX shifts_code_idx ON shifts(tenant_id, lower(code)) WHERE deleted_at IS NULL;

-- Which shift a rep works. Left blank until the company sets one, and the register then says so
-- rather than guessing office hours on the rep's behalf.
ALTER TABLE field_reps ADD COLUMN shift_id uuid;
ALTER TABLE field_reps ADD CONSTRAINT field_reps_shift_fk
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id);

-- One row per rep per day: the evidence, never the verdict.
CREATE TABLE attendance_days (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  work_date date NOT NULL CHECK (work_date BETWEEN '2000-01-01' AND '2100-12-31'),
  work_type_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  start_latitude numeric(9,6) CHECK (start_latitude BETWEEN -90 AND 90),
  start_longitude numeric(9,6) CHECK (start_longitude BETWEEN -180 AND 180),
  start_accuracy_m integer CHECK (start_accuracy_m BETWEEN 0 AND 100000),
  start_source text NOT NULL DEFAULT 'DEVICE' CHECK (start_source IN ('DEVICE','TYPED','PIN')),
  -- The selfie, if the work type asked for one. Bytes live on the volume, not here.
  start_file_id uuid,
  -- Whether the start fix fell inside the company's attendance fence, decided once at punch time
  -- because the fence may be moved afterwards and the day should keep what was true then.
  start_in_fence boolean,
  ended_at timestamptz,
  end_latitude numeric(9,6) CHECK (end_latitude BETWEEN -90 AND 90),
  end_longitude numeric(9,6) CHECK (end_longitude BETWEEN -180 AND 180),
  end_accuracy_m integer CHECK (end_accuracy_m BETWEEN 0 AND 100000),
  end_source text NOT NULL DEFAULT 'DEVICE' CHECK (end_source IN ('DEVICE','TYPED','PIN')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, work_type_id) REFERENCES work_types(tenant_id, id),
  FOREIGN KEY (tenant_id, start_file_id) REFERENCES stored_files(tenant_id, id)
);
-- A rep starts a day once. A second start is a correction, not a new row.
CREATE UNIQUE INDEX attendance_days_rep_date_idx ON attendance_days(tenant_id, rep_id, work_date);
CREATE INDEX attendance_days_date_idx ON attendance_days(tenant_id, work_date, rep_id);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  from_date date NOT NULL CHECK (from_date BETWEEN '2000-01-01' AND '2100-12-31'),
  to_date date NOT NULL CHECK (to_date BETWEEN '2000-01-01' AND '2100-12-31'),
  -- A single day taken as half. Only meaningful when the spell is one day long.
  half_day boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  CHECK (NOT half_day OR from_date = to_date),
  CHECK ((status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id)
);
CREATE INDEX leave_requests_rep_idx ON leave_requests(tenant_id, rep_id, from_date DESC);
CREATE INDEX leave_requests_open_idx ON leave_requests(tenant_id, from_date) WHERE status = 'PENDING';

-- A missed or wrong punch, corrected. The values that were there before are kept on the row, so
-- the register can always be explained without reading the audit log.
CREATE TABLE attendance_edits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  work_date date NOT NULL CHECK (work_date BETWEEN '2000-01-01' AND '2100-12-31'),
  requested_start_at timestamptz,
  requested_end_at timestamptz,
  previous_start_at timestamptz,
  previous_end_at timestamptz,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_start_at IS NOT NULL OR requested_end_at IS NOT NULL),
  CHECK (requested_end_at IS NULL OR requested_start_at IS NULL
         OR requested_end_at >= requested_start_at),
  CHECK ((status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id)
);
CREATE INDEX attendance_edits_rep_idx ON attendance_edits(tenant_id, rep_id, work_date DESC);
-- One correction in flight per rep per day, so two cannot be approved into each other.
CREATE UNIQUE INDEX attendance_edits_pending_idx ON attendance_edits(tenant_id, rep_id, work_date)
  WHERE status = 'PENDING';

-- Attendance settings sit with the rest of Reach's, so there is one place to change them.
ALTER TABLE reach_settings ADD COLUMN attendance_fence_m integer NOT NULL DEFAULT 200
  CHECK (attendance_fence_m BETWEEN 10 AND 10000);
ALTER TABLE reach_settings ADD COLUMN absent_after_minutes integer NOT NULL DEFAULT 120
  CHECK (absent_after_minutes BETWEEN 15 AND 1440);
ALTER TABLE reach_settings ADD COLUMN selfie_required boolean NOT NULL DEFAULT true;
-- Which midnight a working day belongs to. A field force is not tied to a plant, so Reach keeps
-- its own zone rather than borrowing one from a site the reps may never visit. The name is
-- checked against the platform's own zone list before it is saved.
ALTER TABLE reach_settings ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Kolkata'
  CHECK (length(timezone) BETWEEN 3 AND 80);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['work_types','shifts','attendance_days','leave_requests','attendance_edits'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- Nothing here may be deleted. A punch, a leave decision and a correction are all records of what
-- happened; they are cancelled or superseded, never removed.
GRANT SELECT, INSERT, UPDATE ON work_types, shifts, attendance_days, leave_requests,
  attendance_edits TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.attend', 'Reach', 'Start and end your own working day'),
('reach.leave', 'Reach', 'Approve leave requests and attendance corrections')
ON CONFLICT (code) DO NOTHING;
