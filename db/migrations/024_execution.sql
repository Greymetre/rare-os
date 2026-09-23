-- AV-9 execution (Nilkamal simulation handover, 21-Sep-2026: work orders released from the buffer,
-- the execution loop on two events, the breakdown / downtime log and the master-data self-audit).
-- * A make order released from a buffer recommendation is an ordinary production order.
-- * Execution needs two events only: release (which freezes the planned minutes of the schedule the
--   planner released) and completion (elapsed working minutes). Released work keeps its place in the
--   book: it is never re-sequenced by grouping, a club or a planner's move.
-- * Downtime is minutes lost on a resource on a day; the schedule loses them and says which
--   promises are now at risk.

-- Lots belong to an inserted order; a make order is one row like an imported one.
ALTER TABLE production_orders
  DROP CONSTRAINT production_orders_lot_check,
  ADD CONSTRAINT production_orders_lot_check CHECK (
    source <> 'INSERTED' OR (order_ref IS NOT NULL AND lot_no IS NOT NULL AND lot_count IS NOT NULL
      AND lot_no <= lot_count AND lot_date IS NOT NULL)),
  DROP CONSTRAINT production_orders_source_check,
  ADD CONSTRAINT production_orders_source_check CHECK (source IN ('IMPORT','INSERTED','MAKE')),
  ADD COLUMN execution_state text NOT NULL DEFAULT 'planned'
    CHECK (execution_state IN ('planned','released','completed')),
  -- The work minutes of the schedule the planner released, kept as the standard to measure against.
  ADD COLUMN planned_minutes numeric(18,4) CHECK (planned_minutes >= 0),
  ADD COLUMN released_date date,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN released_by uuid,
  -- Release order: released work runs in the order it was released, before anything planned.
  ADD COLUMN release_no bigint,
  ADD COLUMN completed_date date,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completed_by uuid,
  ADD COLUMN completed_quantity numeric(18,6) CHECK (completed_quantity > 0),
  ADD COLUMN elapsed_work_minutes numeric(18,4) CHECK (elapsed_work_minutes >= 0),
  ADD COLUMN buffer_item_id uuid,
  ADD CONSTRAINT production_orders_release_check CHECK (
    (execution_state = 'planned') = (released_date IS NULL)
    AND (execution_state = 'planned') = (release_no IS NULL)
    AND (execution_state <> 'planned' OR planned_minutes IS NULL)),
  ADD CONSTRAINT production_orders_completion_check CHECK (
    (execution_state = 'completed') = (completed_date IS NOT NULL)
    AND (completed_date IS NULL) = (elapsed_work_minutes IS NULL)
    AND (completed_date IS NULL) = (completed_quantity IS NULL)
    AND (completed_date IS NULL OR released_date IS NULL OR completed_date >= released_date)),
  ADD FOREIGN KEY (tenant_id, buffer_item_id) REFERENCES items(tenant_id, id);
CREATE INDEX production_orders_execution_idx ON production_orders(tenant_id, site_id, execution_state)
  WHERE execution_state <> 'planned';

-- Minutes lost on a resource (all its machines, or one of them) on a day.
CREATE TABLE downtime_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  event_no bigint NOT NULL,
  resource_id uuid NOT NULL,
  machine smallint CHECK (machine BETWEEN 1 AND 999),
  event_date date NOT NULL,
  minutes numeric(10,2) NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  logged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, event_no),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id)
);
CREATE INDEX downtime_events_open_idx ON downtime_events(tenant_id, site_id, event_date) WHERE state = 'open';
CREATE TRIGGER downtime_events_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON downtime_events
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

-- Adopted cycle-time corrections: what the standard was, what production actually took.
CREATE TABLE cycle_time_adoptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  routing_id uuid NOT NULL,
  standard_minutes numeric(18,6) NOT NULL CHECK (standard_minutes > 0),
  actual_minutes numeric(18,6) NOT NULL CHECK (actual_minutes > 0),
  drift_pct numeric(8,2) NOT NULL,
  completions integer NOT NULL CHECK (completions > 0),
  adopted_by uuid,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, routing_id) REFERENCES routings(tenant_id, id)
);

-- The protective buffer the execution loop measures completions against (Nilkamal demo: 25%).
ALTER TABLE plant_planning ADD COLUMN execution_buffer_pct numeric(6,2) NOT NULL DEFAULT 25
  CHECK (execution_buffer_pct >= 0 AND execution_buffer_pct <= 200);

ALTER TABLE planning_decisions DROP CONSTRAINT planning_decisions_kind_check;
ALTER TABLE planning_decisions ADD CONSTRAINT planning_decisions_kind_check
  CHECK (kind IN ('club','declub','move','release_manual','insert','quote',
    'expedite_request','expedite_approve','expedite_reject','expedite_confirm',
    'later_propose','later_confirm','later_move','pending_ready','pending_cancel',
    'make_release','work_release','work_complete','downtime','cycle_time_adopt'));

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['downtime_events','cycle_time_adoptions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON downtime_events TO rare_app;
GRANT SELECT, INSERT ON cycle_time_adoptions TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('production.execute', 'Availability', 'Release make orders, release and complete work orders, log downtime'),
('masters.cycle_time', 'Availability', 'Adopt corrected cycle times from completed work orders')
ON CONFLICT (code) DO NOTHING;
