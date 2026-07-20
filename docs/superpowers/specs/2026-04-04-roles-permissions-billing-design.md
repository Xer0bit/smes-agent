# Roles, Permissions & Billing   Full Implementation Design
**Date:** 2026-04-04  
**Status:** Approved

---

## Overview

Full implementation of the role/permission/billing system as defined in the product role matrix. Replaces the existing 4-tier plan system with a clean 3-tier model and adds all missing features end-to-end.

---

## Tier System

### New Tiers (replacing free/starter/professional/enterprise)

| Tier | Price | Seats | Projects | Publish Lines/mo |
|------|-------|-------|----------|-----------------|
| free | $0 | 1 | 1 | 30 |
| pro | $8/mo | 5 | unlimited | 100 |
| agency | $25/mo | 20 | unlimited | 100 |

### Migration
- `free` → `free`
- `starter` → `free`
- `professional` → `pro`
- `enterprise` → `agency`

---

## Org Roles

| Role | Add/Edit Org | Add Members | Manage Project Access | View/Edit Projects | Billing | View Preview |
|------|-------------|-------------|----------------------|-------------------|---------|--------------|
| admin | Yes | Yes | Yes | All | Yes | Yes |
| billing_admin | No | No | No | No | Yes | Yes |
| member | No | No | No | Assigned only | No | Yes |
| shared_view_public | No | No | No | No | No | Yes (link-based) |
| first_time_test_run | No | No | No | Yes (cached 90d) | No | Yes |

---

## Account States

| State | Description |
|-------|-------------|
| Guest (no login) | Anonymous visitor; browser fingerprint tracked; 1 project creation allowed |
| Registered (no org) | Logged-in user without an org; can publish 30 lines/mo |
| Org Member (Free) | Member of a free-tier org |
| Pro | Member of pro-tier org ($8/mo) |
| Agency | Member of agency-tier org ($25/mo) |

---

## Phase 1   Tier Migration
**File:** `supabase/migrations/20260404000001_migrate_tiers_free_pro_agency.sql`

- Create `plan_tier_v2` enum: `free | pro | agency`
- Migrate existing org data
- Update `sync_org_plan_limits()` trigger
- Update subscription service tier config

---

## Phase 2   Publish Lines + Referral System
**File:** `supabase/migrations/20260404000002_publish_lines_referral.sql`

### Publish Lines
- Replace `ai_gens_used/limit` with `publish_lines_used`, `publish_lines_limit`, `publish_lines_reset_at` on `organizations`
- Monthly reset via cron or trigger

### Referral System
- `referral_code` (unique) + `referred_by` on `profiles`
- `bonus_lines` (permanent, never resets) on `profiles`
- `referral_rewards` table: `id, referrer_id, referee_id, lines_earned (20), awarded_at, trigger_event`
- RPC `award_referral_lines(referee_id)` called on first publish by referred user

---

## Phase 3   Guest Sessions + Share Preview Branding
**File:** `supabase/migrations/20260404000003_guest_sessions_branding.sql`

### Guest Sessions
- `guest_sessions`: `id, fingerprint, created_at, projects_created, last_active_at`
- RPC `check_guest_limit(fingerprint)` → `can_create: bool` (max 1 project)

### Share Preview Branding
- `preview_branding`: `project_id, branding_type ('footer' | 'watermark' | 'none'), watermark_text`
- Rules:
  - Guest/Registered: footer branding
  - Org Member (Free): "Geared by eCG" watermark top-right
  - Pro/Agency: no branding
- Auto-set on project creation based on org tier

---

## Phase 4   Agency Features
**File:** `supabase/migrations/20260404000004_agency_features.sql`

### Client Markup
- `client_markups`: `id, org_id, client_user_id, markup_amount, markup_type ('fixed'|'percentage'), currency, created_by, created_at`
- Agency admins can set per-client markup in org settings

### Demo Booking
- `demo_requests`: `id, org_id, user_id, email, company_name, message, status, requested_at, admin_notes, converted_by`
- Statuses: `pending | contacted | converted | rejected`
- RPC `submit_demo_request()` creates record + emails super_admin
- Admin panel shows demo request queue; super_admin manually upgrades org to agency

---

## Phase 5   Add-on Products
**File:** `supabase/migrations/20260404000005_addon_products.sql`

### Auto Pilot Mode ($98/mo)
- `auto_pilot_configs`: `id, project_id, enabled, schedule, last_run_at, next_run_at, prompt, status`
- Cron-triggered agent loop using existing `agentLoopService`
- Pro: flat $98. Agency: $98 + markup stored in `client_markups`

### eComGear Cloud
- `ecomgear_cloud_configs`: `id, project_id, enabled, storage_bucket, cdn_url, storage_used_bytes, storage_limit_bytes`
- Supabase Storage bucket per project; CDN via transform API

### Integration App
- `integration_apps`: seeded catalog (Shopify, WooCommerce, Stripe, PayPal, etc.)
- `project_integrations`: `id, project_id, integration_app_id, config (jsonb), enabled, installed_by`

### Hosting   Ali Cloud
- `ali_cloud_configs`: `id, project_id, region, instance_id, endpoint_url, migration_status, migrated_at`
- Migration flow: request → admin provisions → endpoint URL stored → project routes to Ali Cloud

### Add-on Subscriptions
- `addon_subscriptions`: `id, org_id, addon_type, price_usd, status, stripe_subscription_id, activated_at`

---

## Phase 6   RLS + Permission Updates
**File:** `supabase/migrations/20260404000006_rls_permissions_update.sql`

- Update all RLS policies to use `pro | agency` instead of old tier names
- Add RLS for all 9 new tables
- Add `check_addon_access(org_id, addon_type)` SECURITY DEFINER function
- Update `has_project_access()` for public share links (no auth required for `shared_view_public`)

---

## Frontend Changes

### New/Updated Components
- `PricingTiers.tsx`   updated with 3 tiers
- `SharePreviewBranding.tsx`   conditional watermark/footer rendering
- `ReferralDashboard.tsx`   referral code, earned lines display
- `ClientMarkupSettings.tsx`   Agency: set per-client markup
- `DemoRequestForm.tsx`   upgrade to Agency flow
- `AutoPilotConfig.tsx`   enable/schedule/configure auto pilot
- `EComGearCloudSettings.tsx`   enable cloud storage per project
- `IntegrationAppMarketplace.tsx`   browse + install integrations
- `AliCloudMigration.tsx`   request + track Ali Cloud migration

### Admin Panel Updates
- Demo requests queue in `admin/Requests.tsx`
- Updated `admin/RolesPermissions.tsx` for new 3-tier matrix
- Updated `admin/Subscriptions.tsx` for pro/agency tiers

---

## Implementation Order

1. Phase 1 migration (tier rename)   unblocks everything
2. Phase 2 migration + publish lines enforcement
3. Phase 3 migration + branding logic
4. Phase 4 migration + agency UI
5. Phase 5 migration + add-on UIs
6. Phase 6 migration + RLS tightening
7. Frontend subscription service + hooks update
8. Admin panel updates
