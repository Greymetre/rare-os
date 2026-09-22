-- AV-8 materials decisions (Nilkamal simulation handover, 21-Sep-2026: Request material expedite,
-- supplier confirmation, Explore / quote later date, Pending Orders to Plan).
-- * An expedite bundle groups the component actions one order (or pinned group) needs. An action
--   asks an existing purchase line to arrive earlier, or a new purchase. Approval records intent
--   only (maker-checker: not by the requester); a recorded supplier confirmation (date, quantity,
--   reference) is the only thing that moves supply.
-- * An order's plan: a proposed later date puts it in Pending (visible demand, no capacity or
--   material reservation) until the planner confirms and reschedules it.

CREATE TABLE expedite_bundles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  bundle_no bigint NOT NULL,
  orders text[] NOT NULL CHECK (cardinality(orders) BETWEEN 1 AND 50),
  order_key text NOT NULL,
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested','approved','confirmed','quote_later_required','pending_evidence','closed')),
  decision_no bigint,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bundle_no),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id)
);
CREATE UNIQUE INDEX expedite_bundles_open_idx ON expedite_bundles(tenant_id, site_id, order_key) WHERE state <> 'closed';

CREATE TABLE expedite_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  action_no bigint NOT NULL,
  action_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXPEDITE_PO','NEW_PO','CANNOT_VALIDATE')),
  component_item_id uuid,
  quantity numeric(24,6) CHECK (quantity > 0),
  required_date date,
  po_line_id uuid,
  current_due date,
  members text[] NOT NULL DEFAULT '{}',
  bundles uuid[] NOT NULL DEFAULT '{}',
  -- The orders' lots that need it: [{ id, lot, qty, date }]
  dependents jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL
    CHECK (state IN ('requested','approved','confirmed','late','rejected','superseded','cannot_validate')),
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  confirmed_date date,
  confirmed_qty numeric(24,6) CHECK (confirmed_qty > 0),
  confirmation_ref text CHECK (length(confirmation_ref) BETWEEN 1 AND 120),
  confirmed_by uuid,
  confirmed_at timestamptz,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, action_no),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, component_item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines(tenant_id, id),
  CHECK ((kind = 'CANNOT_VALIDATE') = (quantity IS NULL)),
  CHECK (kind <> 'EXPEDITE_PO' OR po_line_id IS NOT NULL),
  CHECK ((confirmed_date IS NULL) = (confirmed_qty IS NULL) AND (confirmed_date IS NULL) = (confirmation_ref IS NULL)),
  CHECK (confirmed_qty IS NULL OR confirmed_qty <= quantity),
  CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX expedite_actions_site_idx ON expedite_actions(tenant_id, site_id, state);
CREATE INDEX expedite_actions_component_idx ON expedite_actions(tenant_id, component_item_id);
-- Confirmed supply is a planning input.
CREATE TRIGGER expedite_actions_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON expedite_actions
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

-- One row per order (production order number, or the order reference of inserted lots).
CREATE TABLE order_plans (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  order_ref text NOT NULL,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','awaiting_confirmation','ready_to_reschedule','cancelled')),
  original_date date,
  proposed_date date,
  accepted_date date,
  release_date date,
  bundle_id uuid,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  -- Components that gated the proposal: [{ component, shortage, unknown }]
  gating jsonb NOT NULL DEFAULT '[]',
  last_decision_no bigint,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, order_ref),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id),
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES expedite_bundles(tenant_id, id),
  CHECK (state = 'scheduled' OR proposed_date IS NOT NULL OR state = 'cancelled')
);
CREATE TRIGGER order_plans_planning_inputs AFTER INSERT OR UPDATE OR DELETE ON order_plans
  FOR EACH STATEMENT EXECUTE FUNCTION touch_planning_inputs();

-- The order's decision state on each schedule (see packages/engines/materials-decisions.mjs).
ALTER TABLE schedule_orders ADD COLUMN plan_state text;

ALTER TABLE planning_decisions DROP CONSTRAINT planning_decisions_kind_check;
ALTER TABLE planning_decisions ADD CONSTRAINT planning_decisions_kind_check
  CHECK (kind IN ('club','declub','move','release_manual','insert','quote',
    'expedite_request','expedite_approve','expedite_reject','expedite_confirm',
    'later_propose','later_confirm','later_move','pending_ready','pending_cancel'));

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['expedite_bundles','expedite_actions','order_plans'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tbl);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON expedite_bundles, expedite_actions, order_plans TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('purchase.expedite', 'Availability', 'Approve expedite requests and record supplier confirmations')
ON CONFLICT (code) DO NOTHING;
