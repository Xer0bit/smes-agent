-- M1 (agent-v2-architecture.md): optimistic concurrency for client saves.
--
-- Client saves used to be a plain INSERT into revisions -- last writer wins,
-- no ordering. A browser tab holding a stale in-memory copy of the project
-- could (and did, 2026-08-16 05:27, project c5a4973a) republish broken code
-- over a newer fix, because nothing compared the save's parentage against the
-- current head.
--
-- create_revision_checked inserts a revision only if the caller's expected
-- parent IS the current head for the project. An advisory transaction lock on
-- the project id serializes concurrent savers so two saves that both read the
-- same head cannot both win. On mismatch it raises 'stale_parent' and the
-- client rebases (re-fetch head id, retry -- unchanged files are carried by
-- manifest reference from the new head, so only the caller's dirty files ride
-- the retry).
--
-- SECURITY INVOKER on purpose: the revisions RLS insert policy
-- ("Users can insert revisions", has_project_access) keeps applying to the
-- insert exactly as it does for the direct-insert path this replaces.

CREATE OR REPLACE FUNCTION public.create_revision_checked(
  p_project_id uuid,
  p_expected_parent uuid,   -- null = caller believes the project has no revisions yet
  p_prompt text,
  p_generated_code text,
  p_generated_files jsonb,
  p_summary text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
) RETURNS public.revisions
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_head uuid;
  v_row public.revisions;
BEGIN
  -- Serialize savers per project for the duration of this transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  SELECT id INTO v_head
    FROM public.revisions
   WHERE project_id = p_project_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_head IS DISTINCT FROM p_expected_parent THEN
    RAISE EXCEPTION 'stale_parent: head is %, caller expected %',
      COALESCE(v_head::text, 'none'), COALESCE(p_expected_parent::text, 'none')
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.revisions
    (project_id, prompt, generated_code, generated_files, summary, user_id, created_by)
  VALUES
    (p_project_id, p_prompt, p_generated_code, p_generated_files, p_summary,
     p_user_id, p_user_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_revision_checked(uuid, uuid, text, text, jsonb, text, uuid)
  TO authenticated;
