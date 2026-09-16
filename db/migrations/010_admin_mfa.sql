-- Account-wide requirement: platform admins, company Main Admins and access administrators.
-- Return only a boolean; identity service receives no tenant/business-table privileges.
CREATE FUNCTION identity_requires_mfa(subject text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT is_platform_admin(subject) OR EXISTS (
   SELECT 1 FROM app_users u JOIN tenants t ON t.id=u.tenant_id
   JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id
   WHERE u.identity_id=subject AND u.active AND t.active AND
     (r.is_system OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id=r.id
       AND p.tenant_id=r.tenant_id AND p.permission_code IN (
         'roles.create','roles.update','roles.delete','users.create','users.update',
         'users.change_status','users.assign_role','users.reset_password','users.retry_setup',
         'users.invite','users.assign_plants')))
 )
$$;
REVOKE ALL ON FUNCTION identity_requires_mfa(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_requires_mfa(text) TO rare_app,rare_keycloak;
