-- Only returns whether a login is shared; no other company's data is exposed.
CREATE FUNCTION identity_is_shared(subject text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT count(*)>1 FROM app_users WHERE identity_id=subject $$;
REVOKE ALL ON FUNCTION identity_is_shared(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_is_shared(text) TO rare_app;
