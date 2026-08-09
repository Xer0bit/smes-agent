import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface UsageQuotaResult {
  allowed: boolean;
  reason?: string;
}

const MAX_FREE_COST_USD = 5.00;
const MAX_FREE_TOKENS = 500_000;

/**
 * Enforces usage quotas based on subscription tier (Free vs. Pro).
 * Free tier is limited to $5.00 or 500,000 tokens per 30-day billing cycle.
 */
// Billing is NOT live: none of the schema this function reads exists yet
// (profiles.subscription_tier, agent_runs.total_cost, agent_runs.total_tokens
// -- all 42703-confirmed missing on 2026-08-10). Every call was failing its
// first query and fail-opening anyway (16 noisy error-log entries/day, no
// user ever actually gated). Hard-disabled until billing is built as its own
// scoped feature WITH its migrations; flip this flag only in that project.
const BILLING_QUOTA_ENABLED = process.env.BILLING_QUOTA_ENABLED === 'true';

export async function checkUsageQuota(userId: string): Promise<UsageQuotaResult> {
  if (!BILLING_QUOTA_ENABLED) {
    return { allowed: true };
  }
  try {
    if (!userId || userId.startsWith('guest:')) {
      return { allowed: true };
    }

    // 1. Fetch user profile and subscription tier
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      logger.error(`[checkUsageQuota] Failed to fetch profile for user ${userId}: ${profileError.message}`);
      // Fallback: allow request rather than blocking user due to database query error
      return { allowed: true };
    }

    const tier = (profile?.subscription_tier || 'free').toLowerCase();

    // 2. Pro tier users have unlimited access
    if (tier === 'pro') {
      return { allowed: true };
    }

    // 3. Free tier quota check: sum usage over the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: runs, error: runsError } = await supabase
      .from('agent_runs')
      .select('total_cost, tokens_used, total_tokens')
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo);

    if (runsError) {
      logger.warn(`[checkUsageQuota] Could not query agent_runs for user ${userId}: ${runsError.message}`);
      // If table/columns don't exist yet or query fails, allow access
      return { allowed: true };
    }

    let totalCost = 0;
    let totalTokens = 0;

    if (runs && runs.length > 0) {
      for (const run of runs) {
        totalCost += Number(run.total_cost || 0);
        totalTokens += Number(run.total_tokens || run.tokens_used || 0);
      }
    }

    logger.info(`[checkUsageQuota] User ${userId} (Free tier) 30-day usage: $${totalCost.toFixed(2)}, ${totalTokens} tokens`);

    if (totalCost >= MAX_FREE_COST_USD || totalTokens >= MAX_FREE_TOKENS) {
      return {
        allowed: false,
        reason: 'Free tier usage limit reached. Please upgrade to Pro.',
      };
    }

    return { allowed: true };
  } catch (error: any) {
    logger.error(`[checkUsageQuota] Unexpected error checking quota for user ${userId}: ${error?.message}`);
    // Fail-open for system stability
    return { allowed: true };
  }
}
