-- Audit finding (2026-08-07): github_connections has zero consumers in current
-- application code (repo-wide grep, src/ + server/src/ + supabase/functions/ --
-- zero hits outside this table's own creation migration). The live GitHub
-- export flow (server/src/services/github.service.ts) takes a PAT per-request
-- instead of reading this table.
--
-- No explicit GRANT to anon/authenticated was ever issued for this table (it
-- was never touched by the profiles-style runtime-permissions fixes), so RLS
-- was very likely already the only thing standing between it and exposure --
-- this REVOKE is defense-in-depth / explicit documentation of that state, not
-- a behavior change.
--
-- Deliberately NOT dropping the table or touching row data in this pass: it
-- may hold real orphaned GitHub OAuth tokens from before the PAT-based flow
-- replaced it. Follow-up decision needed (not made here): confirm via a
-- one-time production row-count/read (explicit authorization required, same
-- rule as any other tenant/user data query) whether it holds any rows --
-- if so, treat those tokens as compromised and rotate/revoke them at GitHub
-- before dropping the table; if it's always been empty, just drop it.

REVOKE ALL ON TABLE public.github_connections FROM anon, authenticated;

COMMENT ON TABLE public.github_connections IS
  'UNUSED as of 2026-08 security audit: zero code paths in this repo read or write this table (the live GitHub export flow takes a PAT per-request instead, see server/src/services/github.service.ts). Contains plaintext OAuth access_token values that predate that change -- do not build new features on this table without first confirming whether it holds live data and rotating any tokens found.';
