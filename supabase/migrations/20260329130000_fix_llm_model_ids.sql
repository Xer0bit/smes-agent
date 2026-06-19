-- Fix invalid model IDs in system_settings llm_control.
--
-- 'claude-sonnet-4-20250514' is not a valid Anthropic model ID (missing minor version).
-- Replace with 'claude-3-5-sonnet-20241022' which is the correct, stable model.
-- Also remove sub-2.5 Gemini models (gemini-2.0-flash, gemini-1.5-flash) and add 2.5 variants.

UPDATE public.system_settings
SET value = jsonb_set(
  jsonb_set(
    value,
    '{models,primary}',
    '"claude-3-5-sonnet-20241022"'
  ),
  '{models,allowed}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN entry->>'id' = 'claude-sonnet-4-20250514'
          THEN '{"id":"claude-3-5-sonnet-20241022","provider":"anthropic"}'::jsonb
        WHEN entry->>'id' IN ('gemini-2.0-flash','gemini-1.5-flash','gemini-1.5-pro','gemini-2.0-pro')
          THEN NULL
        ELSE entry
      END
    ) FILTER (WHERE
      CASE
        WHEN entry->>'id' IN ('gemini-2.0-flash','gemini-1.5-flash','gemini-1.5-pro','gemini-2.0-pro') THEN FALSE
        ELSE TRUE
      END
    )
    || '[{"id":"gemini-2.5-pro","provider":"gemini"},{"id":"gemini-2.5-flash","provider":"gemini"}]'::jsonb
    FROM jsonb_array_elements(value->'models'->'allowed') AS entry
  )
)
WHERE key = 'llm_control'
  AND (
    value->'models'->>'primary' = 'claude-sonnet-4-20250514'
    OR value->'models'->'allowed' @> '[{"id":"claude-sonnet-4-20250514"}]'
    OR value->'models'->'allowed' @> '[{"id":"gemini-2.0-flash"}]'
    OR value->'models'->'allowed' @> '[{"id":"gemini-1.5-flash"}]'
  );
