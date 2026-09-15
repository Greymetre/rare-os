-- Preserve legacy capabilities while retiring combined access permissions.
INSERT INTO permissions(code,module,description) VALUES
('users.create','Users','Create company users'),
('users.update','Users','Edit company users'),
('users.change_status','Users','Activate or deactivate users'),
('users.assign_role','Users','Change a user role'),
('users.invite','Users','Send invitations'),
('users.reset_password','Users','Send password resets'),
('users.retry_setup','Users','Retry account setup'),
('users.assign_plants','Users','Assign user plant access'),
('roles.create','Roles','Create custom roles'),
('roles.update','Roles','Edit custom roles'),
('roles.delete','Roles','Delete unassigned custom roles'),
('sites.create','Plants','Create plants'),
('sites.update','Plants','Edit plants'),
('sites.change_status','Plants','Activate or deactivate plants'),
('sites.read_all','Plants','Access all company plants')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT tenant_id,role_id,unnest(ARRAY['users.create','users.update','users.change_status','users.assign_role','users.invite','users.reset_password','users.retry_setup','users.read','roles.read']) FROM role_permissions WHERE permission_code='users.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT tenant_id,role_id,unnest(ARRAY['roles.create','roles.update','roles.delete','roles.read']) FROM role_permissions WHERE permission_code='roles.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT tenant_id,role_id,unnest(ARRAY['sites.create','sites.update','sites.change_status','sites.read_all','sites.read']) FROM role_permissions WHERE permission_code='sites.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT u.tenant_id,u.role_id,'users.assign_plants' FROM role_permissions u JOIN role_permissions s ON u.tenant_id=s.tenant_id AND u.role_id=s.role_id WHERE u.permission_code='users.manage' AND s.permission_code='sites.manage' ON CONFLICT DO NOTHING;
UPDATE roles SET version=version+1 WHERE id IN (SELECT role_id FROM role_permissions WHERE permission_code IN ('users.manage','roles.manage','sites.manage'));
DELETE FROM role_permissions WHERE permission_code IN ('users.manage','roles.manage','sites.manage');
DELETE FROM permissions WHERE code IN ('users.manage','roles.manage','sites.manage');
