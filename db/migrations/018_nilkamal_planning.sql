-- Nilkamal planning rules (reference: Nilkamal simulation handover, 21-Sep-2026).
--  * A weekly buffer method: zones from the mean of recent Monday weeks, red safety from the
--    52-week coefficient of variation, lead time rounded to whole weeks.
--  * Open production orders: they consume components; made-item recommendations beyond them do too.
--  * SAP source data: repeated BOM component lines stay separate, net daily demand can be negative
--    (returns), and material codes may contain a double quote (e.g. TP12GM40"WPOLYMRN).

ALTER TABLE items DROP CONSTRAINT items_code_check;
ALTER TABLE items ADD CONSTRAINT items_code_check CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./"-]{0,39}$');

-- A component can appear on several source lines of one BOM; each line counts once.
ALTER TABLE bom_lines DROP CONSTRAINT bom_lines_tenant_id_bom_id_component_item_id_key;
CREATE INDEX bom_lines_bom_component_idx ON bom_lines(tenant_id, bom_id, component_item_id);

-- Net invoiced quantity per day: returns can exceed sales on a day.
ALTER TABLE demand_history DROP CONSTRAINT demand_history_quantity_check;

-- STANDARD: yellow = ADU x lead time, red = yellow x red % x (1 + safety %), green = max(...).
-- WEEKLY:   yellow = weekly mean x DLT weeks, red = yellow x red % x (1 + CV safety),
--           green = weekly mean x order cycle days / 7; see packages/engines/ddmrp.mjs.
ALTER TABLE buffer_profiles
  ADD COLUMN method text NOT NULL DEFAULT 'STANDARD' CHECK (method IN ('STANDARD','WEEKLY')),
  ADD COLUMN zone_weeks integer NOT NULL DEFAULT 13 CHECK (zone_weeks BETWEEN 1 AND 104),
  ADD COLUMN cv_weeks integer NOT NULL DEFAULT 52 CHECK (cv_weeks BETWEEN 4 AND 104),
  -- Made items (and bought items without a source): order multiple and MOQ in days of ADU.
  ADD COLUMN order_multiple numeric(18,6) CHECK (order_multiple > 0),
  ADD COLUMN moq_adu_days numeric(8,3) CHECK (moq_adu_days > 0 AND moq_adu_days <= 365);

CREATE TABLE production_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  order_no text NOT NULL CHECK (order_no ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  start_date date,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  order_type text NOT NULL DEFAULT '' CHECK (length(order_type) <= 20),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 120),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR start_date <= due_date),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE UNIQUE INDEX production_orders_no_idx ON production_orders(tenant_id, site_id, lower(order_no));
CREATE INDEX production_orders_open_idx ON production_orders(tenant_id, site_id, due_date) WHERE status = 'OPEN';
ALTER TABLE production_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON production_orders USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE ON production_orders TO rare_app;
CREATE TRIGGER production_orders_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON production_orders
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

ALTER TABLE planning_results
  ADD COLUMN zone_adu numeric(24,6),
  ADD COLUMN zone_days integer,
  ADD COLUMN cv numeric(12,3),
  ADD COLUMN safety_pct numeric(6,2),
  ADD COLUMN lead_time_demand numeric(24,6) NOT NULL DEFAULT 0,
  ADD COLUMN production_demand numeric(24,6) NOT NULL DEFAULT 0,
  ADD COLUMN planned_make_demand numeric(24,6) NOT NULL DEFAULT 0,
  ADD COLUMN required_date date,
  -- The parents whose demand qualified here: [{ kind, ref, item, qty, need, requiredDate }].
  ADD COLUMN drivers jsonb NOT NULL DEFAULT '[]';

UPDATE permissions SET description = 'View customer and production orders' WHERE code = 'orders.read';
UPDATE permissions SET description = 'Create customer orders and import production orders' WHERE code = 'orders.create';
