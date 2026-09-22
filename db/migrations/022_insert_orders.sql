-- AV-7 Insert order (Nilkamal simulation handover, 21-Sep-2026: Insert screen, v4UrgentSim2(),
-- decisionScenarioPlan(), decisionRush(), mtoRoutingMatch(), inheritMaterials()).
-- An order the planner commits is written as production-order lots: one row per lot, all sharing
-- the order reference and the customer's need-by date (due_date). A lot runs no earlier than its
-- lot date unless the order was taken to the front. A rush order runs before the order it was
-- quoted against. Odd sizes become estimated items: routing and BOM scaled from the nearest
-- standard of their family, with the provenance kept.

ALTER TABLE production_orders
  ADD COLUMN source text NOT NULL DEFAULT 'IMPORT' CHECK (source IN ('IMPORT','INSERTED')),
  ADD COLUMN order_ref text CHECK (order_ref ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  ADD COLUMN lot_no smallint CHECK (lot_no BETWEEN 1 AND 99),
  ADD COLUMN lot_count smallint CHECK (lot_count BETWEEN 1 AND 99),
  ADD COLUMN lot_date date,
  ADD COLUMN front boolean NOT NULL DEFAULT false,
  ADD COLUMN rush boolean NOT NULL DEFAULT false,
  -- The order a rush order runs before; NULL with rush = at the end of the book.
  ADD COLUMN rush_before text,
  ADD COLUMN customer text NOT NULL DEFAULT '' CHECK (length(customer) <= 120),
  ADD COLUMN decision_no bigint,
  ADD CONSTRAINT production_orders_lot_check CHECK (
    source = 'IMPORT' OR (order_ref IS NOT NULL AND lot_no IS NOT NULL AND lot_count IS NOT NULL
      AND lot_no <= lot_count AND lot_date IS NOT NULL)),
  ADD CONSTRAINT production_orders_rush_check CHECK (rush OR rush_before IS NULL);
CREATE INDEX production_orders_ref_idx ON production_orders(tenant_id, site_id, order_ref) WHERE order_ref IS NOT NULL;

-- Odd-size families: the code stem the standards of a family share, and the trade name.
CREATE TABLE odd_size_families (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  PRIMARY KEY (tenant_id, code)
);

-- An estimated item: where its routing and materials came from.
CREATE TABLE estimated_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  site_id uuid NOT NULL,
  family text NOT NULL,
  source_item_id uuid NOT NULL,
  dimensions numeric(10,3)[] NOT NULL CHECK (cardinality(dimensions) = 3),
  source_dimensions numeric(10,3)[] NOT NULL CHECK (cardinality(source_dimensions) = 3),
  area_ratio numeric(18,9) NOT NULL CHECK (area_ratio > 0),
  volume_ratio numeric(18,9) NOT NULL CHECK (volume_ratio > 0),
  exact_thickness boolean NOT NULL,
  area_operations text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, source_item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);

-- Operations whose time scales with the area of an odd size (others are carried as they are).
ALTER TABLE plant_planning ADD COLUMN area_operations text[] NOT NULL DEFAULT '{}';

ALTER TABLE planning_decisions DROP CONSTRAINT planning_decisions_kind_check;
ALTER TABLE planning_decisions ADD CONSTRAINT planning_decisions_kind_check
  CHECK (kind IN ('club','declub','move','release_manual','insert','quote'));

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['odd_size_families','estimated_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON odd_size_families TO rare_app;
GRANT SELECT, INSERT ON estimated_items TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('schedule.insert', 'Availability', 'Insert customer orders into the schedule and quote dates')
ON CONFLICT (code) DO NOTHING;
