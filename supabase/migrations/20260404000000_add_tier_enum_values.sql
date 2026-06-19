-- =============================================================================
-- Phase 1a: Add new enum values for plan_tier
-- Must run in a separate transaction BEFORE the data migration (000001)
-- because PostgreSQL disallows using new enum values in the same transaction.
-- =============================================================================
ALTER TYPE plan_tier ADD VALUE IF NOT EXISTS 'pro';
ALTER TYPE plan_tier ADD VALUE IF NOT EXISTS 'agency';
