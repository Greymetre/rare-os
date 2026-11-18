-- RCH-5: Customer 360 — what a shop owes, what it may order, and what it has bought.
--
-- Scope, stated once so nobody has to guess later. `customer_types.order_route` already says
-- where an order goes: to an ERP, to a distributor, or nowhere. So this module takes an order,
-- prices it, credit-checks it and routes it. A collection is recorded by the rep with the receipt
-- in their hand. Outstanding is then invoices less collections, aged. Nothing here posts a ledger
-- entry: this is not an accounting system.
--
-- An invoice reaches this module two ways, and both are built because which one a company wants
-- is still an open question:
--
-- * **Recorded** — it was raised in an ERP and arrives here as a record (`source` ERP or IMPORT),
--   or somebody enters one by hand (MANUAL). No number is issued here.
-- * **Raised** — this module issues the number itself from `invoice_series` and writes the lines
--   (`source` RAISED). It is gated by the `reach.invoice` permission, so a company that does not
--   want it simply grants that right to nobody: there is no setting to deploy and no code path to
--   turn on later.
--
-- Both shapes are the same shape. A line carries its rate, its tax rate and its amounts whichever
-- way the invoice arrived, because adding a column later is cheap but changing what a column
-- means when a company already holds thousands of invoices is not.
--
-- What this is NOT, and should not be mistaken for: a GST tax invoice of record. That needs the
-- seller's GSTIN per place of business, place of supply, HSN codes, the CGST/SGST/IGST split and,
-- above the turnover threshold, an e-invoice IRN. Those are columns and an integration to add on
-- top of this shape when a client asks for it — not a different design.
--
-- Three things are deliberately NOT stored, because `packages/engines/trade.mjs` reads them from
-- the evidence every time:
--
-- * **What is outstanding.** It is the invoices less the collections, aged as at the moment it is
--   asked for. A stored balance drifts the first time an invoice is cancelled or a receipt is
--   corrected, and then nobody can say which number is true.
-- * **Whether an order may go.** The hold is calculated from the limit, the outstanding, the age
--   of the oldest bill and the KYC. That is what lets a held order clear the instant a collection
--   lands, with nothing to rewrite — the milestone's own acceptance test.
-- * **Where the KYC stands.** Read from the documents against what the type asks for today, so
--   adding a required document tomorrow shows the shops that now fall short.
--
-- What IS stored on an order is the price it was taken at. A rate list changes; last month's
-- order must still read at last month's rate, so the line keeps its own rate, discount and tax.

-- ---------- Per-customer terms ----------
-- The type sets the company's default; a single shop may be given its own. Null means "whatever
-- the type says", which is why these are nullable rather than copied down at creation: changing
-- the type's limit should move every shop that never negotiated its own.
ALTER TABLE trade_customers ADD COLUMN credit_limit numeric(18,2)
  CHECK (credit_limit IS NULL OR credit_limit >= 0);
ALTER TABLE trade_customers ADD COLUMN credit_days integer
  CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365);
ALTER TABLE trade_customers ADD COLUMN hold_days integer
  CHECK (hold_days IS NULL OR hold_days BETWEEN 0 AND 365);

-- ---------- The documents a type asks for ----------
CREATE TABLE kyc_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Whether the number on the document is checked, and how. 'gstin' and 'pan' are checked against
  -- the same validators the customer form uses; 'none' is a document with no number to check.
  number_check text NOT NULL DEFAULT 'none' CHECK (number_check IN ('none','gstin','pan','text')),
  -- How long the document is good for, when it expires at all.
  valid_months integer CHECK (valid_months IS NULL OR valid_months BETWEEN 1 AND 600),
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
CREATE UNIQUE INDEX kyc_types_code_idx ON kyc_types(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX kyc_types_cursor_idx ON kyc_types(tenant_id, lower(code) text_pattern_ops, id);

-- Which document is asked of which customer type: the same R/O/X matrix the customer form and
-- the visit report use, so there is one idea of "asked for" in the system.
CREATE TABLE kyc_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type_id uuid NOT NULL,
  kyc_type_id uuid NOT NULL,
  requirement text NOT NULL DEFAULT 'O' CHECK (requirement IN ('R','O','X')),
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES customer_types(tenant_id, id),
  FOREIGN KEY (tenant_id, kyc_type_id) REFERENCES kyc_types(tenant_id, id)
);
CREATE UNIQUE INDEX kyc_rules_pair_idx ON kyc_rules(tenant_id, type_id, kyc_type_id) WHERE deleted_at IS NULL;
CREATE INDEX kyc_rules_doc_idx ON kyc_rules(tenant_id, kyc_type_id);

-- ---------- The documents a shop has given ----------
-- Every upload is kept. A rejected document is not removed and replaced; a new one is uploaded
-- beside it and the newest is what the shop stands on now. That is why there is no unique index
-- per customer and document: the history is the point.
CREATE TABLE kyc_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  kyc_type_id uuid NOT NULL,
  -- The file itself lives in stored_files, whose purpose column already allows 'kyc'.
  file_id uuid,
  number text NOT NULL DEFAULT '' CHECK (length(number) <= 40),
  valid_to date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '' CHECK (length(decision_reason) <= 300),
  uploaded_by uuid,
  -- The wall clock when the document arrived, not when its transaction began. A shop that
  -- re-uploads after a refusal must read as the newer document, and `now()` is the same instant
  -- for every row written in one transaction — which would leave "newest" undecided.
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A refusal has to say why; a decision has to have a moment.
  CHECK (status <> 'REJECTED' OR decision_reason <> ''),
  CHECK ((status IN ('VERIFIED','REJECTED')) = (decided_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id),
  FOREIGN KEY (tenant_id, kyc_type_id) REFERENCES kyc_types(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files(tenant_id, id)
);
CREATE INDEX kyc_documents_customer_idx ON kyc_documents(tenant_id, customer_id, uploaded_at DESC);
CREATE INDEX kyc_documents_pending_idx ON kyc_documents(tenant_id, status) WHERE status = 'PENDING';

-- ---------- The price a type pays ----------
-- Dated rows, per customer type, so a company may extend a list or open a new one without
-- rewriting history. Two rows may cover the same day; the engine takes the one that started
-- latest, because the alternative is an answer that depends on row order.
CREATE TABLE price_list_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type_id uuid NOT NULL,
  item_id uuid NOT NULL,
  -- Money per unit, to four places: a bulk list may quote a piece at 0.3333.
  rate numeric(18,4) NOT NULL CHECK (rate >= 0),
  gst_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_pct BETWEEN 0 AND 100),
  from_date date NOT NULL,
  to_date date,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK (to_date IS NULL OR to_date >= from_date),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES customer_types(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
-- One row per type, item and start date: the target an import's upsert matches on.
CREATE UNIQUE INDEX price_list_items_key_idx
  ON price_list_items(tenant_id, type_id, item_id, from_date) WHERE deleted_at IS NULL;
CREATE INDEX price_list_items_live_idx ON price_list_items(tenant_id, type_id, item_id, from_date DESC);

-- ---------- The slab a quantity earns ----------
CREATE TABLE trade_schemes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  item_id uuid NOT NULL,
  -- Read as "from this quantity upwards". The highest slab a line reaches is the one it earns.
  min_quantity numeric(18,6) NOT NULL CHECK (min_quantity > 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  free_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (free_quantity >= 0),
  from_date date NOT NULL,
  to_date date,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 200),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR delete_reason = ''),
  CHECK (to_date IS NULL OR to_date >= from_date),
  -- A slab that gives nothing is a slab somebody forgot to fill in.
  CHECK (discount_pct > 0 OR free_quantity > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE UNIQUE INDEX trade_schemes_code_idx ON trade_schemes(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX trade_schemes_item_idx ON trade_schemes(tenant_id, item_id, min_quantity DESC);
CREATE INDEX trade_schemes_cursor_idx ON trade_schemes(tenant_id, lower(code) text_pattern_ops, id);

-- ---------- The order taken at the counter ----------
-- HELD is an order that was taken and cannot go yet, with the reasons recorded as they stood.
-- It is never refused and never thrown away: a rep who is told "no" with no record of why stops
-- trusting the app, exactly as with a check-in from outside the fence.
CREATE TABLE trade_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_no text NOT NULL CHECK (order_no ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  customer_id uuid NOT NULL,
  rep_id uuid NOT NULL,
  -- The visit it was taken on, when it was taken on one. An order may also be entered from the
  -- office, so this is nullable rather than required.
  visit_id uuid,
  order_date date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','HELD','PLACED','ROUTED','CANCELLED')),
  -- Where it went once it was placed, copied from the type at that moment.
  route text NOT NULL DEFAULT 'NONE' CHECK (route IN ('ERP','DISTRIBUTOR','NONE')),
  routed_at timestamptz,
  external_ref text NOT NULL DEFAULT '' CHECK (length(external_ref) <= 60),
  -- The totals as the order was taken. Kept because the rate list moves: last month's order must
  -- still read at last month's price.
  gross numeric(18,2) NOT NULL DEFAULT 0 CHECK (gross >= 0),
  discount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable numeric(18,2) NOT NULL DEFAULT 0 CHECK (taxable >= 0),
  gst numeric(18,2) NOT NULL DEFAULT 0 CHECK (gst >= 0),
  total numeric(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- Why it was held, as it stood when it was placed. Evidence, not a gate: the live decision is
  -- always recalculated, so this is what a person reads when they come to release it.
  hold_reasons text NOT NULL DEFAULT '' CHECK (length(hold_reasons) <= 200),
  released_by uuid,
  released_at timestamptz,
  release_reason text NOT NULL DEFAULT '' CHECK (length(release_reason) <= 300),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 300),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CANCELLED' OR cancel_reason <> ''),
  CHECK (status <> 'ROUTED' OR routed_at IS NOT NULL),
  -- Releasing a held order is a decision, so it says who and why.
  CHECK (released_at IS NULL OR release_reason <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id)
);
CREATE UNIQUE INDEX trade_orders_no_idx ON trade_orders(tenant_id, lower(order_no));
CREATE INDEX trade_orders_customer_idx ON trade_orders(tenant_id, customer_id, order_date DESC);
CREATE INDEX trade_orders_rep_idx ON trade_orders(tenant_id, rep_id, order_date DESC);
CREATE INDEX trade_orders_held_idx ON trade_orders(tenant_id, status) WHERE status = 'HELD';

CREATE TABLE trade_order_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  item_id uuid NOT NULL,
  units numeric(18,6) NOT NULL CHECK (units > 0),
  rate numeric(18,4) NOT NULL CHECK (rate >= 0),
  gst_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_pct BETWEEN 0 AND 100),
  scheme_id uuid,
  scheme_code text NOT NULL DEFAULT '' CHECK (length(scheme_code) <= 40),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  free_units numeric(18,6) NOT NULL DEFAULT 0 CHECK (free_units >= 0),
  gross numeric(18,2) NOT NULL CHECK (gross >= 0),
  discount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable numeric(18,2) NOT NULL CHECK (taxable >= 0),
  gst numeric(18,2) NOT NULL DEFAULT 0 CHECK (gst >= 0),
  total numeric(18,2) NOT NULL CHECK (total >= 0),
  PRIMARY KEY (tenant_id, order_id, line_no),
  -- One item once per order, so two lines cannot quietly double a quantity.
  UNIQUE (tenant_id, order_id, item_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES trade_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, scheme_id) REFERENCES trade_schemes(tenant_id, id)
);
CREATE INDEX trade_order_lines_item_idx ON trade_order_lines(tenant_id, item_id);

-- ---------- What was billed ----------
-- Recorded, not raised. An invoice arrives from the ERP or is entered; this module never
-- generates one, so there is no numbering authority here and `invoice_no` is whatever the
-- document itself says.
CREATE TABLE trade_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_no text NOT NULL CHECK (length(invoice_no) BETWEEN 1 AND 40),
  customer_id uuid NOT NULL,
  order_id uuid,
  invoice_date date NOT NULL,
  due_date date,
  -- What the bill comes to, tax included. A recorded invoice may know only this; one raised here
  -- always knows its parts too.
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  taxable numeric(18,2) CHECK (taxable IS NULL OR taxable >= 0),
  gst numeric(18,2) CHECK (gst IS NULL OR gst >= 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 300),
  -- RAISED is a bill this module numbered itself, from invoice_series. The other three arrived
  -- already numbered somewhere else.
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT','ERP','RAISED')),
  -- The series row the number came from, when this module issued it. Null for a recorded bill,
  -- which is how the two numbering authorities stay told apart for ever.
  series_id uuid,
  raised_by uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CANCELLED' OR cancel_reason <> ''),
  CHECK (due_date IS NULL OR due_date >= invoice_date),
  -- A bill this module raised knows where its number came from and who raised it; a recorded one
  -- has no series here at all.
  CHECK ((source = 'RAISED') = (series_id IS NOT NULL)),
  CHECK (source <> 'RAISED' OR (taxable IS NOT NULL AND gst IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES trade_orders(tenant_id, id)
);
-- One invoice number per company, so the same bill cannot be recorded twice.
CREATE UNIQUE INDEX trade_invoices_no_idx ON trade_invoices(tenant_id, lower(invoice_no));
CREATE INDEX trade_invoices_customer_idx ON trade_invoices(tenant_id, customer_id, invoice_date);
CREATE INDEX trade_invoices_open_idx ON trade_invoices(tenant_id, invoice_date) WHERE status = 'OPEN';

-- The lines of a bill. A bill raised here always has them; a bill recorded from an ERP has them
-- when the source gave them, and is perfectly usable as a single amount when it did not — it just
-- does not reach "top SKU".
--
-- The same shape as an order line on purpose. Whichever way an invoice arrived, a line says what
-- was sold, at what rate, at what tax rate and for how much, so one reader serves both.
CREATE TABLE trade_invoice_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  item_id uuid NOT NULL,
  units numeric(18,6) NOT NULL CHECK (units > 0),
  rate numeric(18,4) CHECK (rate IS NULL OR rate >= 0),
  gst_pct numeric(5,2) CHECK (gst_pct IS NULL OR gst_pct BETWEEN 0 AND 100),
  taxable numeric(18,2) CHECK (taxable IS NULL OR taxable >= 0),
  gst numeric(18,2) CHECK (gst IS NULL OR gst >= 0),
  total numeric(18,2) NOT NULL CHECK (total >= 0),
  PRIMARY KEY (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES trade_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE INDEX trade_invoice_lines_item_idx ON trade_invoice_lines(tenant_id, item_id);

-- ---------- The number a bill raised here is given ----------
-- A number series belongs to a financial year, because that is how a GST series runs: it restarts
-- each year and may not have gaps. The counter is incremented inside the same statement that
-- reads it, so two reps raising a bill at the same moment cannot be handed the same number.
--
-- This table exists only for invoices raised here. A bill that arrived from an ERP keeps the
-- number that ERP gave it and never touches a series, so the two numbering authorities can always
-- be told apart.
CREATE TABLE invoice_series (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- What the numbers look like: PREFIX/FY/0001.
  prefix text NOT NULL CHECK (prefix ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,19}$'),
  -- The financial year the series runs in, as its starting year.
  fy integer NOT NULL CHECK (fy BETWEEN 2000 AND 2200),
  -- The next number to issue. Never decreased: a cancelled bill keeps its number used, which is
  -- what "no gaps" means in practice.
  next_no integer NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  width integer NOT NULL DEFAULT 4 CHECK (width BETWEEN 1 AND 10),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- One series per prefix per year, which is the row the counter is taken from.
CREATE UNIQUE INDEX invoice_series_key_idx ON invoice_series(tenant_id, lower(prefix), fy);

-- Said here rather than on the table above, because the series is declared after the bills it
-- numbers and a foreign key cannot point at a table that does not exist yet.
ALTER TABLE trade_invoices ADD CONSTRAINT trade_invoices_series_fk
  FOREIGN KEY (tenant_id, series_id) REFERENCES invoice_series(tenant_id, id);

-- ---------- What was collected ----------
-- A collection is money against a shop. A rep at the counter is not told which invoice the cash
-- settles, so `invoice_id` is optional: named, it settles that bill; unnamed, the engine applies
-- it oldest bill first. The receipt photo uses the 'receipt' purpose RCH-0 already allows.
CREATE TABLE trade_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  receipt_no text NOT NULL CHECK (receipt_no ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  customer_id uuid NOT NULL,
  rep_id uuid,
  invoice_id uuid,
  received_on date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  mode text NOT NULL CHECK (mode IN ('CASH','CHEQUE','UPI','NEFT','ADJUSTMENT')),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 60),
  file_id uuid,
  status text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','CANCELLED')),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 300),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CANCELLED' OR cancel_reason <> ''),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  -- A cheque or a transfer without its number cannot be traced to a bank line.
  CHECK (mode NOT IN ('CHEQUE','NEFT','UPI') OR reference <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES trade_customers(tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES trade_invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files(tenant_id, id)
);
CREATE UNIQUE INDEX trade_receipts_no_idx ON trade_receipts(tenant_id, lower(receipt_no));
CREATE INDEX trade_receipts_customer_idx ON trade_receipts(tenant_id, customer_id, received_on DESC);
CREATE INDEX trade_receipts_rep_idx ON trade_receipts(tenant_id, rep_id, received_on DESC);

-- ---------- Settings ----------
-- The three numbers Customer 360 is read on. Each sits on the same Reach settings row as the
-- rest, so a company changes them from a screen.
ALTER TABLE reach_settings ADD COLUMN ageing_buckets text NOT NULL DEFAULT '30,60,90'
  CHECK (ageing_buckets ~ '^[0-9]{1,3}(,[0-9]{1,3}){0,4}$');
-- The month a company's financial year starts in. April here; not a constant in the code.
ALTER TABLE reach_settings ADD COLUMN fy_start_month integer NOT NULL DEFAULT 4
  CHECK (fy_start_month BETWEEN 1 AND 12);
-- The window days-sales-outstanding is measured over.
ALTER TABLE reach_settings ADD COLUMN dso_window_days integer NOT NULL DEFAULT 90
  CHECK (dso_window_days BETWEEN 7 AND 730);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['kyc_types','kyc_rules','kyc_documents','price_list_items',
   'trade_schemes','trade_orders','trade_order_lines','trade_invoices','trade_invoice_lines',
   'trade_receipts','invoice_series'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

-- Nothing here may be deleted. An order, a bill, a collection and a KYC decision are all records
-- of what happened or what was decided; they are cancelled or superseded, never removed. The
-- setup tables are soft-deleted like every other master and still get no DELETE.
GRANT SELECT, INSERT, UPDATE ON kyc_types, kyc_rules, kyc_documents, price_list_items,
  trade_schemes, trade_orders, trade_order_lines, trade_invoices, trade_invoice_lines,
  trade_receipts, invoice_series TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('reach.order', 'Reach', 'Take an order at the shop'),
('reach.collect', 'Reach', 'Record a collection against a shop'),
('reach.kyc', 'Reach', 'Verify or reject a customer KYC document'),
('reach.credit', 'Reach', 'Release an order held for credit'),
-- Granted to nobody, no invoice can be raised here and bills only arrive from an ERP. Granted,
-- this module numbers its own. That is the whole switch: no setting, no release.
('reach.invoice', 'Reach', 'Raise an invoice from here, and record or cancel a bill')
ON CONFLICT (code) DO NOTHING;
