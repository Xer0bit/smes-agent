-- Follow-up to 20260805060000_edge_functions_least_privilege.sql: that
-- migration added is_public with DEFAULT true to preserve pre-existing
-- behavior for already-live functions. In practice this meant every new
-- function an agent wrote, going forward, was public unless the agent
-- explicitly opted OUT -- and nothing in the prompt or tooling ever told it
-- to. Confirmed 2026-08-09: 100% of live edge functions (82/82) are
-- is_public=true, and one insert path (ecg-dev-agent.routes.ts's
-- "ecg-overview" starter function, explicitly documented as server-side-only,
-- credentials-never-reach-the-browser) never set is_public at all and was
-- silently inheriting the public default despite being meant to be private.
--
-- This does NOT rewrite any existing row -- a column DEFAULT only applies to
-- future inserts that omit the value. Every currently-live function keeps
-- whatever is_public value is already stored (all currently true), so
-- nothing already deployed changes behavior from this migration alone.
-- Going forward, a function must explicitly opt IN to public via
-- write_edge_function's isPublic: true argument (see write_edge_function.ts /
-- confirm_edge_function_deploy.ts, updated in the same change as this
-- migration).

ALTER TABLE edge_functions ALTER COLUMN is_public SET DEFAULT false;

COMMENT ON COLUMN edge_functions.is_public IS
  'If false (new default as of 2026-08-09), only an owner platform-session caller may invoke this function -- the project''s public anon/service key is rejected. Functions must explicitly opt into is_public=true. Rows created before 2026-08-09 keep their existing stored value (all currently true; see 20260805060000_edge_functions_least_privilege.sql).';
