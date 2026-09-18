-- AV-5 purchase loop: purchase proposals (rule AV-01), approval into purchase orders, and goods
-- receipts that post stock. A proposal is not supply; an approved purchase order is open supply,
-- not stock; only a goods receipt adds stock.

CREATE TABLE purchase_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  proposal_no bigint NOT NULL,
  site_id uuid NOT NULL,
  item_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_unit_id uuid NOT NULL,
  unit_factor numeric(24,12) NOT NULL CHECK (unit_factor > 0),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','REJECTED','WITHDRAWN')),
  source text NOT NULL CHECK (source IN ('SYSTEM','MANUAL')),
  -- Planning run the proposal was last calculated from (system proposals).
  run_no bigint,
  zone text,
  nfp numeric(24,6),
  top_of_green numeric(24,6),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  -- Who last created or changed the proposal (NULL subject = the planning system). They cannot approve it.
  changed_by uuid,
  changed_by_subject text,
  decided_by uuid,
  decided_by_subject text,
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '' CHECK (length(decision_note) <= 300),
  po_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'REJECTED' OR decision_note <> ''),
  CHECK ((status = 'APPROVED') = (po_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, proposal_no),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_unit_id) REFERENCES units(tenant_id, id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, id)
);
-- One pending proposal per plant and item.
CREATE UNIQUE INDEX purchase_proposals_pending_idx ON purchase_proposals(tenant_id, site_id, item_id) WHERE status = 'PROPOSED';
CREATE INDEX purchase_proposals_list_idx ON purchase_proposals(tenant_id, site_id, status, proposal_no DESC);

ALTER TABLE purchase_orders
  ADD COLUMN source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','PROPOSAL','IMPORT')),
  ADD COLUMN proposal_id uuid,
  ADD FOREIGN KEY (tenant_id, proposal_id) REFERENCES purchase_proposals(tenant_id, id);
CREATE UNIQUE INDEX purchase_orders_proposal_idx ON purchase_orders(tenant_id, proposal_id) WHERE proposal_id IS NOT NULL;

-- Goods receipts are records of what physically arrived; they are never edited or deleted.
CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  receipt_no bigint NOT NULL,
  site_id uuid NOT NULL,
  po_id uuid NOT NULL,
  location_id uuid NOT NULL,
  receipt_date date NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 60),
  -- Sent by the client for each receipt so a retried request never receives the goods twice.
  request_id uuid NOT NULL,
  created_by uuid,
  created_by_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, location_id) REFERENCES stock_locations(tenant_id, site_id, id)
);
CREATE INDEX goods_receipts_po_idx ON goods_receipts(tenant_id, po_id, receipt_no);

CREATE TABLE goods_receipt_lines (
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  po_line_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  base_quantity numeric(18,6) NOT NULL CHECK (base_quantity > 0),
  movement_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id, po_line_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts(tenant_id, id),
  FOREIGN KEY (tenant_id, movement_id) REFERENCES stock_movements(tenant_id, id)
);
ALTER TABLE purchase_order_lines ADD UNIQUE (tenant_id, id);
ALTER TABLE goods_receipt_lines ADD FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines(tenant_id, id);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['purchase_proposals','goods_receipts','goods_receipt_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON purchase_proposals TO rare_app;
GRANT SELECT, INSERT ON goods_receipts, goods_receipt_lines TO rare_app;

UPDATE permissions SET description = 'Approve or reject purchase proposals' WHERE code = 'purchase.approve';
