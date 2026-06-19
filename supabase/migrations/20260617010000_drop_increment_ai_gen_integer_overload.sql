-- Remove legacy integer overload to avoid RPC ambiguity when calling increment_ai_gen with p_tokens.
--
-- Some environments still have both signatures:
--   increment_ai_gen(UUID, INTEGER)
--   increment_ai_gen(UUID, NUMERIC)
--
-- PostgREST can fail with:
--   "Could not choose the best candidate function between ..."
--
-- Keep NUMERIC overload (supports 0.5 eco) and one-arg wrapper.

DROP FUNCTION IF EXISTS public.increment_ai_gen(UUID, INTEGER);

-- Ensure execute grants remain on the supported signatures.
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID) TO authenticated;
