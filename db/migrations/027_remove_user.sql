-- Removing a user for good, and with it the login behind it. Until now a user could only be
-- deactivated: the record stayed, the login stayed, and the email could never be used again.
-- One login can serve app users in several companies, so it is only removed when no company
-- still points at it. That question spans tenants, which row-level security hides, so it is
-- answered by a function that returns a count and nothing else.

CREATE FUNCTION identity_company_count(subject text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT count(*)::int FROM app_users WHERE identity_id = subject
$$;
REVOKE ALL ON FUNCTION identity_company_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_company_count(text) TO rare_app;

GRANT DELETE ON app_users TO rare_app;

INSERT INTO permissions(code, module, description) VALUES
('users.delete', 'Users', 'Remove a user and free their email')
ON CONFLICT (code) DO NOTHING;
