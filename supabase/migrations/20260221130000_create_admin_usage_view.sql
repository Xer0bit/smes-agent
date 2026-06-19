-- ─────────────────────────────────────────────────────────────────────────────
-- Admin Usage Summary View
-- Aggregates usage_tracking per user, joining with profiles + organizations.
-- Only admins/super_admins can select this view (enforced by the underlying
-- RLS on usage_tracking AND by the security_invoker setting below).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.admin_user_usage_summary
WITH (security_invoker = true)
AS
SELECT
  p.id                                                                      AS user_id,
  p.email,
  p.full_name,
  p.avatar_url,
  p.created_at                                                              AS registered_at,

  -- Totals
  COUNT(ut.id)                                                              AS total_events,
  COUNT(ut.id) FILTER (WHERE ut.action = 'generate')                       AS total_prompts,
  COALESCE(SUM((ut.metadata->>'files_created')::int)  FILTER (WHERE ut.action = 'generate'), 0)   AS total_files_created,
  COALESCE(SUM((ut.metadata->>'files_modified')::int) FILTER (WHERE ut.action = 'generate'), 0)   AS total_files_modified,
  COALESCE(SUM((ut.metadata->>'input_tokens')::bigint + (ut.metadata->>'output_tokens')::bigint)
           FILTER (WHERE ut.metadata->>'input_tokens' IS NOT NULL), 0)     AS total_tokens_used,

  -- Activity window
  MAX(ut.created_at)                                                        AS last_active_at,
  MIN(ut.created_at)                                                        AS first_active_at,

  -- Distinct dimensions
  COUNT(DISTINCT ut.project_id)                                             AS projects_used,
  COUNT(DISTINCT ut.org_id)                                                 AS orgs_used,

  -- Rolling windows
  COUNT(ut.id) FILTER (WHERE ut.created_at >= NOW() - INTERVAL '7 days')   AS events_last_7d,
  COUNT(ut.id) FILTER (WHERE ut.created_at >= NOW() - INTERVAL '30 days')  AS events_last_30d,
  COUNT(ut.id) FILTER (WHERE ut.action = 'generate'
                         AND ut.created_at >= NOW() - INTERVAL '7 days')   AS prompts_last_7d

FROM public.profiles p
LEFT JOIN public.usage_tracking ut ON ut.user_id = p.id
GROUP BY p.id, p.email, p.full_name, p.avatar_url, p.created_at;

-- Admin read access only
GRANT SELECT ON public.admin_user_usage_summary TO authenticated;

COMMENT ON VIEW public.admin_user_usage_summary IS
  'Per-user usage aggregation for the admin panel. Readable only by admin/super_admin (via RLS on profiles + usage_tracking).';


-- ─────────────────────────────────────────────────────────────────────────────
-- Daily prompt volume view (last 90 days) for the trend chart
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.admin_daily_usage
WITH (security_invoker = true)
AS
SELECT
  DATE(created_at AT TIME ZONE 'UTC')                                       AS day,
  COUNT(*)                                                                  AS total_events,
  COUNT(*) FILTER (WHERE action = 'generate')                               AS prompts,
  COUNT(DISTINCT user_id)                                                   AS active_users,
  COALESCE(SUM((metadata->>'files_created')::int)
           FILTER (WHERE action = 'generate'), 0)                           AS files_created,
  COALESCE(SUM((metadata->>'input_tokens')::bigint +
              (metadata->>'output_tokens')::bigint)
           FILTER (WHERE metadata->>'input_tokens' IS NOT NULL), 0)        AS tokens_used
FROM public.usage_tracking
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE(created_at AT TIME ZONE 'UTC')
ORDER BY day DESC;

GRANT SELECT ON public.admin_daily_usage TO authenticated;

COMMENT ON VIEW public.admin_daily_usage IS
  'Daily usage aggregates for the 90-day activity chart in the admin panel.';
