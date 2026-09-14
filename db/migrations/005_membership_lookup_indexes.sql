-- Global identity lookups are narrow security-definer operations, backed by indexes.
CREATE INDEX users_identity_memberships_idx ON app_users(identity_id,tenant_id);
CREATE INDEX users_identity_email_lookup_idx ON app_users(lower(email)) WHERE identity_id NOT LIKE 'pending:%';
