-- Temporary MFA exemption for a named account (for repeated test logins while Availability is built).
-- Only the operator script (database owner) can add or remove one; the runtime and identity roles
-- have no access. Every exemption expires, at most 60 days after it was granted, and MFA is required
-- again automatically after that.
CREATE TABLE mfa_exemptions (
  identity_id text PRIMARY KEY,
  email text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 days')
);
REVOKE ALL ON mfa_exemptions FROM PUBLIC;

CREATE OR REPLACE FUNCTION identity_requires_mfa(subject text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS (SELECT 1 FROM mfa_exemptions e WHERE e.identity_id=subject AND e.expires_at > now())
 AND (is_platform_admin(subject) OR EXISTS (
   SELECT 1 FROM app_users u JOIN tenants t ON t.id=u.tenant_id
   JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id
   WHERE u.identity_id=subject AND u.active AND t.active AND
     (r.is_system OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id=r.id
       AND p.tenant_id=r.tenant_id AND p.permission_code IN (
         'roles.create','roles.update','roles.delete','users.create','users.update',
         'users.change_status','users.assign_role','users.reset_password','users.retry_setup',
         'users.invite','users.assign_plants')))
 ))
$$;

-- When an active exemption ends, so the app can show a reminder. NULL when none.
CREATE FUNCTION mfa_exemption_until(subject text) RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT expires_at FROM mfa_exemptions WHERE identity_id=subject AND expires_at > now()
$$;
REVOKE ALL ON FUNCTION mfa_exemption_until(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mfa_exemption_until(text) TO rare_app;
