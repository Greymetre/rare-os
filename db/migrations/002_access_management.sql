ALTER TABLE roles ADD COLUMN is_system boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN version integer NOT NULL DEFAULT 1;
UPDATE roles SET is_system=true WHERE id='20000000-0000-4000-8000-000000000001';
CREATE UNIQUE INDEX roles_name_ci_idx ON roles(tenant_id,lower(name));
CREATE INDEX users_role_idx ON app_users(tenant_id,role_id,id);
CREATE INDEX users_email_prefix_idx ON app_users(tenant_id,lower(email) text_pattern_ops,id);
CREATE UNIQUE INDEX users_email_ci_idx ON app_users(lower(email));
ALTER TABLE app_users ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE app_users ADD COLUMN sync_state text NOT NULL DEFAULT 'ready' CHECK(sync_state IN ('pending','ready','failed'));
ALTER TABLE app_users ADD COLUMN sync_error text;
ALTER TABLE app_users ADD COLUMN invitation_sent_at timestamptz;
ALTER TABLE app_users ADD COLUMN email_attempt_at timestamptz;
ALTER TABLE app_users ADD COLUMN created_by uuid;
GRANT INSERT,UPDATE,DELETE ON roles,role_permissions TO rare_app;
GRANT INSERT,UPDATE ON app_users TO rare_app;
-- All these writes are tenant-isolated. API checks permission and last-admin invariants.
CREATE OR REPLACE FUNCTION resolve_identity(subject text) RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT tenant_id FROM app_users WHERE identity_id=subject AND active AND (sync_state='ready' OR identity_id NOT LIKE 'pending:%') $$;
