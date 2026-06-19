-- =============================================================================
-- System Settings
-- Generic key-value store for server-side admin configuration.
-- Used by llm-control.service.ts to persist LLM provider/model/key settings.
-- All access is via the authenticated backend API only (service_role key).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT NOW()
);

-- No RLS policies = no direct authenticated-user access.
-- Service role bypasses RLS entirely.
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.system_settings TO service_role;

COMMENT ON TABLE public.system_settings IS
    'Server-side admin key-value store. Accessed only via service_role through backend API.';

-- =============================================================================
-- Atomic message count increment
-- Replaces the TOCTOU read-then-write pattern in promptService.ts
-- =============================================================================

CREATE OR REPLACE FUNCTION public.increment_message_count(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.projects
    SET message_count = COALESCE(message_count, 0) + 1
    WHERE id = p_project_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_message_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_message_count(uuid) TO service_role;
