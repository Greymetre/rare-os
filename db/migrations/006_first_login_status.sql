ALTER TABLE app_users ADD COLUMN first_login_at timestamptz;
-- Backfill only from successful, tenant-specific authentication/selection evidence.
WITH first_logins AS (
 SELECT tenant_id,actor_id,min(created_at) AS first_login_at
 FROM audit_log WHERE action IN ('auth.login','company.selected') AND actor_id IS NOT NULL
 GROUP BY tenant_id,actor_id
)
UPDATE app_users u SET first_login_at=f.first_login_at
FROM first_logins f WHERE u.tenant_id=f.tenant_id AND u.id=f.actor_id;
