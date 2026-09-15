-- Bound latest delivery lookup to one company's admin, even with large audit history.
CREATE INDEX audit_admin_delivery_idx ON audit_log(tenant_id,entity_id,id DESC)
WHERE action IN ('company.admin_invited','company.admin_invitation_failed','company.admin_email_corrected');
