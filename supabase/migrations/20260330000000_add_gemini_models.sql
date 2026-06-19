-- Add Gemini 2.5 models to the allowed list in system_settings.
-- Migration 20260329140000 set allowed models to only Claude + DeepSeek,
-- removing Gemini. This migration adds Gemini 2.5 Flash and Pro back.

UPDATE public.system_settings
SET value = jsonb_set(
  value,
  '{models,allowed}',
  (value->'models'->'allowed')
    || '[{"id":"gemini-2.5-flash","provider":"gemini"},{"id":"gemini-2.5-pro","provider":"gemini"}]'::jsonb
)
WHERE key = 'llm_control'
  AND NOT (value->'models'->'allowed' @> '[{"id":"gemini-2.5-flash"}]');
