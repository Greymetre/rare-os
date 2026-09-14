ALTER TABLE sites ADD COLUMN location text NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE sites ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE sites ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX sites_code_ci_idx ON sites(tenant_id,lower(code));
CREATE INDEX sites_name_prefix_idx ON sites(tenant_id,lower(name) text_pattern_ops,id);
CREATE INDEX user_sites_site_idx ON user_sites(tenant_id,site_id,user_id);
ALTER TABLE audit_log ADD COLUMN actor_subject text;
GRANT INSERT,UPDATE ON sites TO rare_app;
GRANT INSERT,DELETE ON user_sites TO rare_app;
CREATE FUNCTION platform_existing_identity(subject text, email_address text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT is_platform_admin(subject) THEN RAISE EXCEPTION 'Platform access required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT identity_id FROM app_users WHERE lower(email)=lower(email_address) AND identity_id NOT LIKE 'pending:%' LIMIT 1);
END $$;
REVOKE ALL ON FUNCTION platform_existing_identity(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_existing_identity(text,text) TO rare_app;
