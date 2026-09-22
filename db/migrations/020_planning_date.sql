-- A company can plan on a fixed date instead of today: a frozen simulation (the Nilkamal demo
-- runs on its model day). Blank = today. Set by the operator only (scripts/load-nilkamal.mjs).
ALTER TABLE planning_state ADD COLUMN as_of_date date;
