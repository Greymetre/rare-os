-- Lists now tell the reader how long they are: which page this is, out of how many, and how many
-- records there are altogether. Every company-scoped list can count its own rows, but the company
-- list itself is owned by the platform, so its count needs the same platform check the listing has.

CREATE FUNCTION platform_company_count(subject text, search text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT is_platform_admin(subject) THEN RAISE EXCEPTION 'Platform access required' USING ERRCODE='42501'; END IF;
  RETURN (SELECT count(*)::int FROM tenants WHERE starts_with(lower(name),coalesce(search,'')));
END $$;
REVOKE ALL ON FUNCTION platform_company_count(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_company_count(text,text) TO rare_app;
