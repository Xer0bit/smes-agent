-- 2026-08 security audit (Domain 6): every edge function ran with the
-- RLS-bypassing service key unconditionally, and there was no way to mark a
-- function admin/owner-only -- the public anon/service key authorized
-- invoking EVERY function in a project, including ones meant to be
-- privileged. Both new columns default to the PRE-EXISTING behavior
-- (service role + publicly invocable) so no currently-working function
-- breaks; this only adds the capability to opt specific functions into a
-- stricter posture going forward. See functions.routes.ts / write_edge_function.ts.

ALTER TABLE edge_functions ADD COLUMN IF NOT EXISTS requires_service_role boolean NOT NULL DEFAULT true;
ALTER TABLE edge_functions ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN edge_functions.requires_service_role IS
  'If false, the function''s db.* calls use the project''s anon key (RLS-scoped, read-only per anon role grants) instead of the RLS-bypassing service key. Default true preserves pre-2026-08 behavior for existing functions.';
COMMENT ON COLUMN edge_functions.is_public IS
  'If false, only an owner platform-session caller may invoke this function -- the project''s public anon/service key is rejected. Default true preserves pre-2026-08 behavior (anon key can invoke any function in the project).';
