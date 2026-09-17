-- AV-1 item masters: items, suppliers, item sourcing, customers and unit conversions.
-- Company-wide records; no hard deletes (deactivate instead); codes are unique per company, case-insensitive.

CREATE TABLE items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  item_type text NOT NULL CHECK (item_type IN ('RM','SFG','FG')),
  make_buy text NOT NULL CHECK (make_buy IN ('MAKE','BUY')),
  base_unit_id uuid NOT NULL,
  family text NOT NULL DEFAULT '' CHECK (length(family) <= 60),
  standard_cost numeric(18,4) CHECK (standard_cost >= 0),
  demand_class text CHECK (demand_class IN ('runner','repeater','stranger')),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, base_unit_id) REFERENCES units(tenant_id, id)
);
CREATE UNIQUE INDEX items_code_ci_idx ON items(tenant_id, lower(code));
CREATE INDEX items_base_unit_idx ON items(tenant_id, base_unit_id);
CREATE INDEX items_name_prefix_idx ON items(tenant_id, lower(name) text_pattern_ops, id);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  lead_time_days integer NOT NULL CHECK (lead_time_days BETWEEN 0 AND 365),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX suppliers_code_ci_idx ON suppliers(tenant_id, lower(code));
CREATE INDEX suppliers_name_prefix_idx ON suppliers(tenant_id, lower(name) text_pattern_ops, id);

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  customer_type text NOT NULL CHECK (customer_type IN ('OEM','DISTRIBUTOR','RETAILER','DIRECT','OTHER')),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 80),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customers_code_ci_idx ON customers(tenant_id, lower(code));
CREATE INDEX customers_name_prefix_idx ON customers(tenant_id, lower(name) text_pattern_ops, id);

-- Which supplier can provide a bought item, and on what purchase terms.
CREATE TABLE item_suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_item_code text NOT NULL DEFAULT '' CHECK (length(supplier_item_code) <= 60),
  purchase_unit_id uuid NOT NULL,
  lead_time_days integer CHECK (lead_time_days BETWEEN 0 AND 365),
  moq numeric(18,6) NOT NULL DEFAULT 0 CHECK (moq >= 0),
  lot_multiple numeric(18,6) NOT NULL DEFAULT 1 CHECK (lot_multiple > 0),
  preferred boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id, supplier_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_unit_id) REFERENCES units(tenant_id, id)
);
-- At most one preferred active source per item.
CREATE UNIQUE INDEX item_suppliers_preferred_idx ON item_suppliers(tenant_id, item_id) WHERE preferred AND active;
CREATE INDEX item_suppliers_supplier_idx ON item_suppliers(tenant_id, supplier_id);

-- 1 from_unit = factor to_unit; item_id NULL means the conversion applies to every item.
CREATE TABLE unit_conversions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  from_unit_id uuid NOT NULL,
  to_unit_id uuid NOT NULL,
  item_id uuid,
  factor numeric(18,6) NOT NULL CHECK (factor > 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_unit_id <> to_unit_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, from_unit_id) REFERENCES units(tenant_id, id),
  FOREIGN KEY (tenant_id, to_unit_id) REFERENCES units(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE UNIQUE INDEX unit_conversions_pair_idx ON unit_conversions(tenant_id, from_unit_id, to_unit_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid));

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['items','suppliers','customers','item_suppliers','unit_conversions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON items, suppliers, customers, item_suppliers, unit_conversions TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('suppliers.manage', 'Masters', 'Maintain suppliers and item sourcing'),
('customers.manage', 'Masters', 'Maintain customers')
ON CONFLICT (code) DO NOTHING;
