-- Migration: Fix default Claude model names
-- Updates stale default values in api_usage_logs and ai_generations tables

-- Update default for api_usage_logs
ALTER TABLE public.api_usage_logs 
  ALTER COLUMN model SET DEFAULT 'claude-3-5-sonnet-20241022-latest';

-- Update default for ai_generations
ALTER TABLE public.ai_generations 
  ALTER COLUMN model SET DEFAULT 'claude-3-5-sonnet-20241022-latest';

-- Optional: Update existing records if needed (commented out to preserve history audit trail)
-- UPDATE public.api_usage_logs SET model = 'claude-3-5-sonnet-20241022-latest' WHERE model = 'claude-sonnet-4-5';
-- UPDATE public.ai_generations SET model = 'claude-3-5-sonnet-20241022-latest' WHERE model = 'claude-3-5-sonnet-20241022-latest';
