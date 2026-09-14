CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE permissions (code text PRIMARY KEY, module text NOT NULL, description text NOT NULL);
CREATE TABLE roles (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, UNIQUE(tenant_id,name), UNIQUE(tenant_id,id));
CREATE TABLE role_permissions (tenant_id uuid NOT NULL, role_id uuid NOT NULL, permission_code text NOT NULL REFERENCES permissions(code), PRIMARY KEY(tenant_id,role_id,permission_code), FOREIGN KEY(tenant_id,role_id) REFERENCES roles(tenant_id,id));
CREATE TABLE app_users (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), identity_id text NOT NULL UNIQUE, email text NOT NULL, name text NOT NULL, role_id uuid NOT NULL, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,email), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,role_id) REFERENCES roles(tenant_id,id));
CREATE TABLE sites (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), code text NOT NULL, name text NOT NULL, UNIQUE(tenant_id,code), UNIQUE(tenant_id,id));
CREATE TABLE user_sites (tenant_id uuid NOT NULL, user_id uuid NOT NULL, site_id uuid NOT NULL, PRIMARY KEY(tenant_id,user_id,site_id), FOREIGN KEY(tenant_id,user_id) REFERENCES app_users(tenant_id,id), FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id));
CREATE TABLE audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_tenant_cursor_idx ON audit_log(tenant_id,id DESC);
CREATE INDEX users_tenant_cursor_idx ON app_users(tenant_id,id);
CREATE INDEX user_identity_active_idx ON app_users(identity_id) WHERE active;
CREATE TABLE outbox_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz);
CREATE INDEX outbox_pending_idx ON outbox_events(id) WHERE delivered_at IS NULL;
CREATE TABLE processed_events (tenant_id uuid NOT NULL REFERENCES tenants(id), event_id bigint NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,event_id));
-- Permission catalog is global. Business rows are tenant scoped; the runtime is not an owner.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants USING(id = nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['roles','role_permissions','app_users','sites','user_sites','audit_log','outbox_events','processed_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON %I USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,tbl);
 END LOOP;
END $$;
-- Minimal identity lookup before tenant context is known; only returns active subject's tenant.
CREATE FUNCTION resolve_identity(subject text) RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT tenant_id FROM app_users WHERE identity_id=subject AND active $$;
REVOKE ALL ON FUNCTION resolve_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_identity(text) TO rare_app;
GRANT SELECT ON tenants,permissions,roles,role_permissions,app_users,sites,user_sites TO rare_app;
GRANT SELECT,INSERT ON audit_log,outbox_events,processed_events TO rare_app;
GRANT UPDATE(delivered_at) ON outbox_events TO rare_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rare_app;
