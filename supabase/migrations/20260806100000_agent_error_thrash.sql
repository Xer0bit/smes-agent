-- Thrash-audit fix (Phase 2 of the agent-loop root-cause audit): the existing
-- get_build_errors.ts circuit breaker (build_error_breaker table) detects the
-- SAME error repeating twice in a row and tells the model to rewrite from
-- scratch -- but it DELETES its row on trip, so it has no memory of whether
-- that rewrite actually worked. A fix run can trip the breaker, get told to
-- rewrite, still fail, trip again on a fresh (reset) counter, get told to
-- rewrite AGAIN, indefinitely -- this is the exact "6 different root causes,
-- 7 runs" pattern from the original incident. This table is a SEPARATE,
-- longer-lived counter keyed by the same error fingerprint that survives
-- breaker resets, so a SECOND trip on the same underlying error can be told
-- to stop and surface the failure honestly instead of trying yet another
-- confident rewrite.
CREATE TABLE IF NOT EXISTS agent_error_thrash (
  project_id       UUID        REFERENCES public.projects(id) ON DELETE CASCADE,
  fingerprint      TEXT        NOT NULL,
  hit_count        INTEGER     NOT NULL DEFAULT 1,
  trip_count       INTEGER     NOT NULL DEFAULT 0,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_agent_error_thrash_last_seen ON agent_error_thrash(last_seen_at DESC);

ALTER TABLE agent_error_thrash ENABLE ROW LEVEL SECURITY;

-- Written server-side only (service-role key, from get_build_errors.ts /
-- thrashDetector.ts) -- no anon/authenticated write path. Owners can read
-- their own project's thrash history for debugging.
CREATE POLICY "service_role_all_agent_error_thrash" ON agent_error_thrash
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "owner_read_own_agent_error_thrash" ON agent_error_thrash
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p WHERE p.id = agent_error_thrash.project_id AND p.user_id = auth.uid()
    )
  );
