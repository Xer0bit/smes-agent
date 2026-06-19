-- Reduce allowed models to claude-sonnet-4-6 (primary) + deepseek-chat (fallback).
-- Replaces all previous model entries in system_settings.

UPDATE public.system_settings
SET value = jsonb_set(
  jsonb_set(
    value,
    '{models,primary}',
    '"claude-sonnet-4-6"'
  ),
  '{models,allowed}',
  '[{"id":"claude-sonnet-4-6","provider":"anthropic"},{"id":"deepseek-chat","provider":"deepseek"}]'::jsonb
)
WHERE key = 'llm_control';
