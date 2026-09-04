-- Drop unbuilt integration + misc schema (Categories B and D of the
-- 2026-09-01 DB schema-usage audit; see docs/design/db-schema-usage-audit.md).
--
-- These 12 tables are queried by NO application or edge-function code. They are
-- schema for features that were never wired: third-party integrations
-- (github/analytics/cloud configs, auto-pilot, demo capture) and half-built
-- platform bits (collaborators, guest project access, custom tenant domains,
-- preview branding).
--
-- Scope decision (2026-09-01): billing/agency schema (Category C) is KEPT
-- intact because it may hold financial records. `org_clients` is also KEPT and
-- deliberately excluded here: it is referenced by a foreign key from
-- client_invoices (a kept billing table), so dropping it would damage the
-- retained billing schema.
--
-- CASCADE removes each table's own dependent views/triggers/FK constraints. No
-- inbound FK from any WIRED table points at these (verified), so nothing live
-- breaks.
--
-- NOT YET APPLIED. Runs against the PRODUCTION control-plane database; deletes
-- any rows these tables hold. Review, then apply only via the normal
-- migration + deploy path with explicit go-ahead. No auto-rollback.

BEGIN;

-- Integrations (Category B). project_integrations references integration_apps,
-- so drop it first (CASCADE + IF EXISTS makes order moot, but explicit is clearer).
DROP TABLE IF EXISTS public.project_integrations         CASCADE;
DROP TABLE IF EXISTS public.integration_apps             CASCADE;
DROP TABLE IF EXISTS public.github_connections           CASCADE;
DROP TABLE IF EXISTS public.google_analytics_connections CASCADE;
DROP TABLE IF EXISTS public.ali_cloud_configs            CASCADE;
DROP TABLE IF EXISTS public.SMEsAgent_cloud_configs       CASCADE;
DROP TABLE IF EXISTS public.auto_pilot_configs           CASCADE;
DROP TABLE IF EXISTS public.demo_requests                CASCADE;

-- Misc half-built platform features (Category D). org_clients intentionally
-- NOT dropped (FK'd from the retained client_invoices billing table).
DROP TABLE IF EXISTS public.project_collaborators        CASCADE;
DROP TABLE IF EXISTS public.guest_project_access         CASCADE;
DROP TABLE IF EXISTS public.tenant_domains               CASCADE;
DROP TABLE IF EXISTS public.preview_branding             CASCADE;

COMMIT;
