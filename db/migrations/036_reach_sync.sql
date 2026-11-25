-- RCH-8: what the server needs so that a phone can send the same thing twice without harm.
--
-- The milestone plan's test for the mobile app is a whole beat done in airplane mode, then
-- reconnected on a bad line, with everything arriving **exactly once**. A phone cannot reach
-- that on its own. When a request dies in the air the device learns nothing: not whether the
-- server acted, not whether it refused. The only safe thing it can do is send it again, and the
-- only way sending again is safe is if the server recognises the repeat.
--
-- RCH-4 already did this for the check-in, which is why `visits.client_ref` exists. This
-- migration finishes the job for the rest of a rep's day. Three records are at risk, and they
-- are at risk for different reasons:
--
--   An **order** is not unique in itself. A rep may legitimately take two orders at one counter
--   in one morning, for the same lines, at the same price. Nothing about the content tells a
--   repeat apart from a second order, so only a reference the device minted can.
--
--   A **receipt** is the same, and worse: two collections of the same amount on the same day
--   from the same shop are ordinary, and getting it wrong means a shop is credited twice.
--
--   A **stored file** already keeps its bytes once, because the path is the sha256 of the
--   content. But the row is not deduplicated, so a retried photo leaves an orphan row behind it.
--   Harmless to the books, untrue to the promise, and easy to close.
--
-- The rest of a rep's day needs nothing here, and it is worth saying why rather than leaving it
-- to be rediscovered. Starting a day, ending a day and checking out are each unique by their own
-- nature: one day per rep per date, one open visit per rep per shop. The server already answers a
-- repeat of those with a plain 409 saying it has happened, which is the same information a
-- reference would have carried.
--
-- Why the index is partial: the great majority of rows are written from the web, which has no
-- device and no reference. An empty reference must never collide with another empty reference,
-- so only non-empty ones are constrained.

ALTER TABLE trade_orders ADD COLUMN client_ref text NOT NULL DEFAULT ''
  CHECK (length(client_ref) <= 80);
ALTER TABLE trade_receipts ADD COLUMN client_ref text NOT NULL DEFAULT ''
  CHECK (length(client_ref) <= 80);
ALTER TABLE stored_files ADD COLUMN client_ref text NOT NULL DEFAULT ''
  CHECK (length(client_ref) <= 80);

CREATE UNIQUE INDEX trade_orders_client_ref_idx ON trade_orders(tenant_id, client_ref)
  WHERE client_ref <> '';
CREATE UNIQUE INDEX trade_receipts_client_ref_idx ON trade_receipts(tenant_id, client_ref)
  WHERE client_ref <> '';
CREATE UNIQUE INDEX stored_files_client_ref_idx ON stored_files(tenant_id, client_ref)
  WHERE client_ref <> '';

-- A photo taken at the counter.
--
-- `shelf` has been one of the five allowed upload purposes since RCH-0, and the field app is
-- what it was waiting for: until now there was a purpose for a shop photo and nowhere to put
-- one. A check-in may carry a photo and is never refused for lacking one, exactly as a check-in
-- is never refused for being outside the fence — the evidence is kept, and what a company does
-- about its absence is a decision taken later by a person.
ALTER TABLE visits ADD COLUMN file_id uuid;
ALTER TABLE visits ADD CONSTRAINT visits_file_fk
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files(tenant_id, id);

-- Using the app from a phone is not a different right from using it from a desk: a rep who may
-- take an order may take it at the counter. So there is no `reach.mobile` permission, and adding
-- one later would only create a way to be allowed to do something and not allowed to do it in
-- the place where it happens.
--
-- What the phone does need is somewhere to record that a device is syncing, so that a rep can be
-- told plainly when their own queue last reached the server, and so that an administrator
-- looking at a stuck rep can see whether the phone has been heard from at all. This is a log of
-- contact, not of content: no part of a rep's work is stored here.
CREATE TABLE device_syncs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rep_id uuid NOT NULL,
  -- The phone's own name for itself, kept so that a rep with a new handset does not look like a
  -- rep who stopped syncing.
  device_ref text NOT NULL CHECK (length(device_ref) BETWEEN 1 AND 80),
  platform text NOT NULL DEFAULT '' CHECK (length(platform) <= 40),
  app_version text NOT NULL DEFAULT '' CHECK (length(app_version) <= 40),
  -- What the phone said about itself at that moment. Counts, never the work itself.
  queued integer NOT NULL DEFAULT 0 CHECK (queued >= 0),
  blocked integer NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_id) REFERENCES field_reps(tenant_id, id)
);
CREATE UNIQUE INDEX device_syncs_device_idx ON device_syncs(tenant_id, rep_id, device_ref);
CREATE INDEX device_syncs_seen_idx ON device_syncs(tenant_id, last_seen_at DESC);

ALTER TABLE device_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON device_syncs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A heartbeat is overwritten in place, never removed: a phone that stops reporting should leave
-- its last contact behind, because that is exactly the row somebody needs when a rep says their
-- day did not go in.
GRANT SELECT, INSERT, UPDATE ON device_syncs TO rare_app;
