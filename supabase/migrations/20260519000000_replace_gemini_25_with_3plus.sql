-- Remove Gemini 2.5 models and replace with Gemini 3+ only.
-- Removes: gemini-2.5-flash, gemini-2.5-pro
-- Adds:    gemini-3-flash-preview, gemini-3.1-pro-preview

UPDATE public.system_settings
SET value = jsonb_set(
  value,
  '{models,allowed}',
  -- Filter out 2.5 models, then append 3+ models (dedup by checking first)
  (
    SELECT jsonb_agg(entry)
    FROM jsonb_array_elements(value->'models'->'allowed') AS entry
    WHERE entry->>'id' NOT IN ('gemini-2.5-flash', 'gemini-2.5-pro')
  )
  || CASE
       WHEN NOT (value->'models'->'allowed' @> '[{"id":"gemini-3-flash-preview"}]')
         THEN '[{"id":"gemini-3-flash-preview","provider":"gemini"},{"id":"gemini-3.1-pro-preview","provider":"gemini"}]'::jsonb
       ELSE '[]'::jsonb
     END
)
WHERE key = 'llm_control'
  AND (
    value->'models'->'allowed' @> '[{"id":"gemini-2.5-flash"}]'
    OR value->'models'->'allowed' @> '[{"id":"gemini-2.5-pro"}]'
  );
