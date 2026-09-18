-- AV-3 demand and stock: stock locations, append-only stock ledger with derived balances,
-- customer orders, open purchase orders and demand history.
-- Posted movements are never edited or deleted; a reversal movement corrects them.

CREATE TABLE stock_locations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  location_type text NOT NULL CHECK (location_type IN ('STORES','PRODUCTION','FINISHED','QUARANTINE')),
  -- Nettable stock counts as available for planning; quarantine usually does not.
  nettable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);
CREATE UNIQUE INDEX stock_locations_code_idx ON stock_locations(tenant_id, site_id, lower(code));

-- quantity is signed and in the item's base unit; entered_quantity/entered_unit keep what the user typed.
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  movement_no bigint NOT NULL,
  site_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('OPENING','RECEIPT','ISSUE','ADJUSTMENT','REVERSAL')),
  quantity numeric(18,6) NOT NULL CHECK (quantity <> 0),
  entered_quantity numeric(18,6) NOT NULL CHECK (entered_quantity > 0),
  entered_unit_id uuid NOT NULL,
  movement_date date NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 60),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  -- Source document id from a file; the same external reference is never posted twice.
  external_ref text CHECK (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,59}$'),
  reverses_id uuid,
  import_batch_id uuid,
  created_by uuid,
  created_by_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (movement_type IN ('OPENING','RECEIPT') AND quantity > 0)
    OR (movement_type = 'ISSUE' AND quantity < 0)
    OR movement_type IN ('ADJUSTMENT','REVERSAL')
  ),
  CHECK (movement_type NOT IN ('ADJUSTMENT','REVERSAL') OR reason <> ''),
  CHECK ((movement_type = 'REVERSAL') = (reverses_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, movement_no),
  FOREIGN KEY (tenant_id, site_id, location_id) REFERENCES stock_locations(tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, entered_unit_id) REFERENCES units(tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES stock_movements(tenant_id, id)
);
CREATE UNIQUE INDEX stock_movements_external_idx ON stock_movements(tenant_id, lower(external_ref)) WHERE external_ref IS NOT NULL;
-- A movement can be reversed once.
CREATE UNIQUE INDEX stock_movements_reversal_idx ON stock_movements(tenant_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX stock_movements_site_idx ON stock_movements(tenant_id, site_id, movement_no DESC);
CREATE INDEX stock_movements_item_idx ON stock_movements(tenant_id, item_id, location_id, movement_no);

-- Current stock per location and item, maintained from the ledger in the same transaction.
-- Never written by the application; the CHECK refuses any movement that would make stock negative.
CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CONSTRAINT stock_not_negative CHECK (quantity >= 0),
  last_movement_no bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, location_id, item_id),
  FOREIGN KEY (tenant_id, site_id, location_id) REFERENCES stock_locations(tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE INDEX stock_balances_site_idx ON stock_balances(tenant_id, site_id, item_id);

CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- Create the row at zero first: an INSERT ... ON CONFLICT would check a negative quantity before
  -- noticing the existing row. The UPDATE locks the row, so concurrent movements apply one by one.
  INSERT INTO stock_balances(tenant_id, site_id, location_id, item_id, quantity, last_movement_no)
  VALUES (NEW.tenant_id, NEW.site_id, NEW.location_id, NEW.item_id, 0, NEW.movement_no)
  ON CONFLICT (tenant_id, location_id, item_id) DO NOTHING;
  UPDATE stock_balances
    SET quantity = quantity + NEW.quantity, last_movement_no = NEW.movement_no, updated_at = now()
    WHERE tenant_id = NEW.tenant_id AND location_id = NEW.location_id AND item_id = NEW.item_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_stock_movement() FROM PUBLIC;
CREATE TRIGGER stock_movements_balance AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

CREATE TABLE sales_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  order_no text NOT NULL CHECK (order_no ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  customer_id uuid NOT NULL,
  order_date date NOT NULL,
  promise_date date NOT NULL,
  allow_partial boolean NOT NULL DEFAULT true,
  customer_ref text NOT NULL DEFAULT '' CHECK (length(customer_ref) <= 60),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (promise_date >= order_date),
  CHECK (status <> 'CANCELLED' OR cancel_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE UNIQUE INDEX sales_orders_no_idx ON sales_orders(tenant_id, lower(order_no));
CREATE INDEX sales_orders_site_idx ON sales_orders(tenant_id, site_id, lower(order_no));

-- Lines keep their line number for life; removed lines are cancelled, never deleted.
CREATE TABLE sales_order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 9999),
  item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  promise_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE INDEX sales_order_lines_item_idx ON sales_order_lines(tenant_id, item_id, promise_date) WHERE status = 'OPEN';

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  po_no text NOT NULL CHECK (po_no ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  supplier_id uuid NOT NULL,
  order_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CANCELLED' OR cancel_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id)
);
CREATE UNIQUE INDEX purchase_orders_no_idx ON purchase_orders(tenant_id, lower(po_no));
CREATE INDEX purchase_orders_site_idx ON purchase_orders(tenant_id, site_id, lower(po_no));

-- quantity/received_quantity are in the line unit; unit_factor converts them to the item base unit.
CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  po_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 9999),
  item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  unit_factor numeric(24,12) NOT NULL CHECK (unit_factor > 0),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  received_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  UNIQUE (tenant_id, po_id, line_no),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE INDEX purchase_order_lines_item_idx ON purchase_order_lines(tenant_id, item_id, due_date) WHERE status = 'OPEN';

-- One quantity per plant, item and day; re-importing a day replaces its quantity.
CREATE TABLE demand_history (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  demand_date date NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, item_id, demand_date),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE INDEX demand_history_date_idx ON demand_history(tenant_id, site_id, demand_date DESC);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['stock_locations','stock_movements','stock_balances','sales_orders','sales_order_lines','purchase_orders','purchase_order_lines','demand_history'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON stock_locations, sales_orders, sales_order_lines, purchase_orders, purchase_order_lines, demand_history TO rare_app;
-- The ledger is append-only for the application; balances are read-only.
GRANT SELECT, INSERT ON stock_movements TO rare_app;
GRANT SELECT ON stock_balances TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('orders.update', 'Demand', 'Edit and cancel customer orders'),
('inventory.move', 'Materials', 'Post stock receipts and issues'),
('purchase.create', 'Materials', 'Create, edit and import purchase orders'),
('demand.import', 'Demand', 'Import demand history')
ON CONFLICT (code) DO NOTHING;
UPDATE permissions SET description = 'Post opening stock, adjustments and reversals' WHERE code = 'inventory.adjust';
UPDATE permissions SET description = 'View purchase orders and proposals' WHERE code = 'purchase.read';
