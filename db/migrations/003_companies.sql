ALTER TABLE tenants ADD COLUMN code text;
UPDATE tenants SET code=CASE WHEN id='10000000-0000-4000-8000-000000000001' THEN 'RARE' ELSE upper(left(id::text,8)) END;
ALTER TABLE tenants ALTER COLUMN code SET NOT NULL;
ALTER TABLE tenants ALTER COLUMN code SET DEFAULT upper(left(gen_random_uuid()::text,8));
CREATE UNIQUE INDEX tenants_code_ci ON tenants(lower(code));
CREATE INDEX tenants_name_prefix ON tenants(lower(name) text_pattern_ops,id);
ALTER TABLE tenants ADD COLUMN contact_email text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE app_users DROP CONSTRAINT app_users_identity_id_key;
DROP INDEX users_email_ci_idx;
CREATE UNIQUE INDEX users_email_ci_idx ON app_users(tenant_id,lower(email));
CREATE UNIQUE INDEX users_company_identity_idx ON app_users(tenant_id,identity_id);
CREATE TABLE platform_admins(identity_id text PRIMARY KEY, active boolean NOT NULL DEFAULT true);
REVOKE ALL ON platform_admins FROM PUBLIC,rare_app;
CREATE TABLE platform_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,subject text NOT NULL,action text NOT NULL,company_id uuid,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON platform_audit FROM PUBLIC,rare_app;
CREATE FUNCTION session_memberships(subject text) RETURNS TABLE(tenant_id uuid,company text,code text,auth_version integer) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.id,t.name,t.code,u.auth_version FROM app_users u JOIN tenants t ON t.id=u.tenant_id WHERE u.identity_id=subject AND u.active AND t.active AND u.identity_id NOT LIKE 'pending:%' ORDER BY t.name,t.id
$$;
CREATE FUNCTION is_platform_admin(subject text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM platform_admins WHERE identity_id=subject AND active) $$;
CREATE OR REPLACE FUNCTION resolve_identity(subject text) RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT tenant_id FROM session_memberships(subject) $$;
-- Narrow platform operations: no tenant business-table read grants or RLS bypass for runtime.
CREATE FUNCTION platform_company(subject text, operation text, data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE company_id uuid; role_id uuid; user_id uuid; oldrow tenants; result jsonb; identity text;
BEGIN
 IF NOT is_platform_admin(subject) THEN RAISE EXCEPTION 'Platform access required' USING ERRCODE='42501'; END IF;
 IF operation='list' THEN
   SELECT jsonb_agg(to_jsonb(t)) INTO result FROM (SELECT * FROM tenants WHERE (data->>'after' IS NULL OR id>(data->>'after')::uuid) AND starts_with(lower(name),coalesce(data->>'q','')) ORDER BY id LIMIT least((data->>'limit')::int,101)) t;
   RETURN coalesce(result,'[]');
 ELSIF operation='create' THEN
   company_id := (data->>'id')::uuid;
   PERFORM pg_advisory_xact_lock(hashtextextended(company_id::text,73));
   SELECT * INTO oldrow FROM tenants WHERE id=company_id;
   IF FOUND THEN
     IF oldrow.code<>data->>'code' OR oldrow.name<>data->>'name' OR oldrow.contact_email<>data->>'contactEmail' OR NOT EXISTS(SELECT 1 FROM app_users WHERE tenant_id=company_id AND lower(email)=data->>'adminEmail' AND name=data->>'adminName') THEN RAISE EXCEPTION 'Request already used' USING ERRCODE='23505'; END IF;
     RETURN jsonb_build_object('id',company_id,'existing',true);
   END IF;
   role_id:=gen_random_uuid(); user_id:=gen_random_uuid();
   -- Only the platform may attach a known login to a second company; company admins cannot discover other memberships.
   SELECT identity_id INTO identity FROM app_users WHERE lower(email)=data->>'adminEmail' AND identity_id NOT LIKE 'pending:%' LIMIT 1;
   INSERT INTO tenants(id,name,code,contact_email) VALUES(company_id,data->>'name',data->>'code',data->>'contactEmail');
   INSERT INTO roles(id,tenant_id,name,is_system) VALUES(role_id,company_id,'Main Admin',true);
   INSERT INTO role_permissions SELECT company_id,role_id,code FROM permissions;
   INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id,sync_state) VALUES(user_id,company_id,coalesce(identity,'pending:'||user_id),data->>'adminEmail',data->>'adminName',role_id,CASE WHEN identity IS NULL THEN 'pending' ELSE 'ready' END);
   INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES(company_id,'company.created','company',company_id::text,jsonb_build_object('name',data->>'name'));
   INSERT INTO platform_audit(subject,action,company_id,details) VALUES(subject,'company.created',company_id,data-'adminName');
   RETURN jsonb_build_object('id',company_id,'existing',false);
 ELSIF operation='update' THEN
   company_id:=(data->>'id')::uuid;
   SELECT * INTO oldrow FROM tenants WHERE id=company_id FOR UPDATE;
   IF NOT FOUND THEN RETURN NULL; END IF;
   IF oldrow.version<>(data->>'version')::int THEN RAISE EXCEPTION 'Stale company' USING ERRCODE='40001'; END IF;
   UPDATE tenants SET name=data->>'name',contact_email=data->>'contactEmail',active=(data->>'active')::boolean,version=version+1 WHERE id=company_id;
   IF oldrow.active IS DISTINCT FROM (data->>'active')::boolean THEN UPDATE app_users SET auth_version=auth_version+1 WHERE tenant_id=company_id; END IF;
   INSERT INTO platform_audit(subject,action,company_id,details) VALUES(subject,'company.updated',company_id,jsonb_build_object('before',to_jsonb(oldrow),'after',data));
   RETURN jsonb_build_object('id',company_id);
 ELSIF operation='onboarding' THEN
   company_id:=(data->>'id')::uuid;
   SELECT jsonb_build_object('id',u.id,'tenant_id',u.tenant_id,'identity_id',u.identity_id,'name',u.name,'email',u.email,'active',u.active,'sync_state',u.sync_state,'sync_error',u.sync_error,'version',u.version,'invitation_sent_at',u.invitation_sent_at,'email_attempt_at',u.email_attempt_at) INTO result FROM app_users u JOIN roles r ON r.id=u.role_id WHERE u.tenant_id=company_id AND r.is_system ORDER BY u.created_at,u.id LIMIT 1;
   RETURN result;
 END IF;
 RAISE EXCEPTION 'Unsupported operation';
END $$;
REVOKE ALL ON FUNCTION session_memberships(text),is_platform_admin(text),platform_company(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_memberships(text),is_platform_admin(text),platform_company(text,text,jsonb) TO rare_app;
