-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE public.app_role AS ENUM ('super_admin', 'admin', 'user');
CREATE TYPE public.org_member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.project_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE public.org_status AS ENUM ('active', 'suspended');
CREATE TYPE public.account_status AS ENUM ('active', 'suspended', 'pending_verification', 'deletion_pending');
CREATE TYPE public.region_type AS ENUM ('global', 'cn');
CREATE TYPE public.plan_tier AS ENUM ('free', 'starter', 'professional', 'enterprise');
CREATE TYPE public.invitation_status AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE public.project_visibility AS ENUM ('org_all', 'org_restricted', 'org_wide', 'restricted');
CREATE TYPE public.project_member_role AS ENUM ('editor', 'viewer', 'client');
CREATE TYPE public.org_role AS ENUM ('admin', 'billing_admin', 'member');
CREATE TYPE public.subscription_plan AS ENUM ('free', 'pro', 'agency');
CREATE TYPE public.organization_mode AS ENUM ('standard', 'agency');
CREATE TYPE public.subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused');
CREATE TYPE public.usage_type AS ENUM ('revision_lines', 'ai_agent_calls', 'hosting_bandwidth', 'storage');
CREATE TYPE public.invoice_status AS ENUM ('draft', 'pending', 'paid', 'overdue', 'canceled');
CREATE TYPE public.referral_status AS ENUM ('pending', 'registered', 'published', 'credited');
CREATE TYPE public.billing_type AS ENUM ('recurring', 'one_time');
CREATE TYPE public.add_on_status AS ENUM ('active', 'cancelled', 'pending');
CREATE TYPE public.payout_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE public.subscription_tier AS ENUM ('free', 'pro', 'agency');
CREATE TYPE public.domain_status AS ENUM ('pending_dns', 'verifying', 'active', 'failed', 'inactive');

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text NOT NULL UNIQUE,
  full_name text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  phone text UNIQUE,
  avatar_url text,
  account_status public.account_status DEFAULT 'active'::public.account_status,
  is_mfa_enabled boolean DEFAULT false,
  preferred_language text DEFAULT 'en'::text,
  region public.region_type DEFAULT 'global'::public.region_type,
  last_login_at timestamp with time zone,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);

CREATE TABLE public.organizations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  status text DEFAULT 'pending_approval'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  slug text NOT NULL,
  avatar_url text,
  region public.region_type DEFAULT 'global'::public.region_type,
  plan_tier public.plan_tier DEFAULT 'free'::public.plan_tier,
  seats_total integer DEFAULT 10,
  seats_used integer DEFAULT 0,
  security_policy jsonb DEFAULT '{"session_ttl": 604800, "ip_allowlist": [], "mfa_required": false}'::jsonb,
  sso_config jsonb,
  created_by uuid,
  mode public.organization_mode DEFAULT 'standard'::public.organization_mode,
  subscription_plan public.subscription_plan DEFAULT 'free'::public.subscription_plan,
  stripe_customer_id text UNIQUE,
  stripe_connect_account_id text UNIQUE,
  stripe_connect_onboarded boolean DEFAULT false,
  billing_email text,
  billing_address jsonb,
  CONSTRAINT organizations_pkey PRIMARY KEY (id),
  CONSTRAINT organizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);

CREATE TABLE public.projects (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  status public.project_status DEFAULT 'active'::public.project_status,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  organization_id uuid,
  slug text,
  description text,
  visibility public.project_visibility DEFAULT 'org_all'::public.project_visibility,
  created_by uuid,
  message_count integer NOT NULL DEFAULT 0,
  latest_generated_code text,
  user_id uuid,
  total_storage_bytes bigint DEFAULT 0,
  revision_count integer DEFAULT 0,
  latest_revision_size integer DEFAULT 0,
  storage_warning_shown boolean DEFAULT false,
  org_id uuid,
  CONSTRAINT projects_pkey PRIMARY KEY (id),
  CONSTRAINT projects_org_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);

CREATE TABLE public.revisions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  prompt text NOT NULL,
  generated_code text,
  created_at timestamp with time zone DEFAULT now(),
  revision_number integer,
  git_commit_hash character varying,
  git_branch character varying DEFAULT 'main'::character varying,
  is_published boolean DEFAULT false,
  is_active boolean DEFAULT true,
  created_by uuid,
  generated_files jsonb,
  user_id uuid,
  preview_url text,
  preview_status text DEFAULT 'pending'::text,
  CONSTRAINT revisions_pkey PRIMARY KEY (id),
  CONSTRAINT revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

CREATE TABLE public.ai_agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  job_description text,
  agent_photo_url text,
  original_prompt text,
  workflow_data jsonb,
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'paused'::text])),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  about text,
  current_task text,
  is_active boolean DEFAULT true,
  connected_integrations jsonb DEFAULT '[]'::jsonb,
  project_id uuid,
  CONSTRAINT ai_agents_pkey PRIMARY KEY (id),
  CONSTRAINT ai_agents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

CREATE TABLE public.org_clients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agency_org_id uuid NOT NULL,
  client_user_id uuid NOT NULL,
  client_email text NOT NULL,
  client_name text,
  stripe_customer_id text,
  default_payment_method_id text,
  billing_enabled boolean DEFAULT false,
  custom_line_price_cents integer,
  custom_ai_agent_price_cents integer,
  custom_markup_percent numeric,
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'churned'::text])),
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT org_clients_pkey PRIMARY KEY (id),
  CONSTRAINT org_clients_agency_org_id_fkey FOREIGN KEY (agency_org_id) REFERENCES public.organizations(id),
  CONSTRAINT org_clients_client_user_id_fkey FOREIGN KEY (client_user_id) REFERENCES auth.users(id)
);

CREATE TABLE public.add_ons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  price_amount integer NOT NULL,
  price_currency text NOT NULL DEFAULT 'USD'::text,
  billing_type public.billing_type NOT NULL,
  billing_interval text,
  tier_restriction text[],
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT add_ons_pkey PRIMARY KEY (id)
);
CREATE TABLE public.agency_payouts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD'::text,
  status public.payout_status NOT NULL DEFAULT 'pending'::public.payout_status,
  payout_method text,
  payout_details jsonb DEFAULT '{}'::jsonb,
  requested_at timestamp with time zone DEFAULT now(),
  processed_at timestamp with time zone,
  completed_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT agency_payouts_pkey PRIMARY KEY (id),
  CONSTRAINT agency_payouts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.agency_pricing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agency_org_id uuid NOT NULL UNIQUE,
  default_markup_percent numeric DEFAULT 20.00,
  line_price_cents integer DEFAULT 1,
  ai_agent_price_cents integer DEFAULT 100,
  hosting_price_cents integer DEFAULT 500,
  storage_price_cents integer DEFAULT 100,
  custom_pricing jsonb DEFAULT '{}'::jsonb,
  platform_commission_percent numeric DEFAULT 10.00,
  currency text DEFAULT 'usd'::text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT agency_pricing_pkey PRIMARY KEY (id),
  CONSTRAINT agency_pricing_agency_org_id_fkey FOREIGN KEY (agency_org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.agent_chats (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  user_id uuid NOT NULL,
  message text NOT NULL,
  response text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT agent_chats_pkey PRIMARY KEY (id),
  CONSTRAINT agent_chats_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id)
);
CREATE TABLE public.agent_task_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type = ANY (ARRAY['create'::text, 'delete'::text, 'start'::text, 'stop'::text, 'schedule_update'::text, 'process_immediate'::text, 'fetch_stats'::text])),
  status text NOT NULL CHECK (status = ANY (ARRAY['success'::text, 'error'::text, 'pending'::text])),
  request_payload jsonb,
  response_payload jsonb,
  error_message text,
  error_code text,
  api_endpoint text,
  http_status_code integer,
  duration_ms integer,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT agent_task_logs_pkey PRIMARY KEY (id),
  CONSTRAINT agent_task_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id),
  CONSTRAINT agent_task_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.ai_agent_cron (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  executed_at timestamp with time zone DEFAULT now(),
  action_description text,
  result jsonb,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['success'::text, 'failed'::text, 'pending'::text, 'running'::text])),
  error_log text,
  duration_ms integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_agent_cron_pkey PRIMARY KEY (id),
  CONSTRAINT ai_agent_cron_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id)
);
CREATE TABLE public.api_usage_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  model character varying NOT NULL DEFAULT 'claude-sonnet-4-5'::character varying,
  prompt_length integer,
  context_length integer,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_creation_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer GENERATED ALWAYS AS (((input_tokens + output_tokens) + cache_creation_tokens) + cache_read_tokens) STORED,
  cache_hit boolean DEFAULT false,
  cache_efficiency_percent numeric,
  input_cost numeric DEFAULT 0,
  output_cost numeric DEFAULT 0,
  cache_write_cost numeric DEFAULT 0,
  cache_read_cost numeric DEFAULT 0,
  total_cost numeric GENERATED ALWAYS AS (((input_cost + output_cost) + cache_write_cost) + cache_read_cost) STORED,
  latency_ms integer,
  response_status character varying DEFAULT 'success'::character varying,
  error_message text,
  revision_number integer,
  files_generated integer DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT api_usage_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.billing_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid,
  user_id uuid,
  event_type text NOT NULL,
  stripe_event_id text,
  description text,
  amount_cents integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT billing_events_pkey PRIMARY KEY (id),
  CONSTRAINT billing_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT billing_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.client_invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agency_org_id uuid NOT NULL,
  client_id uuid NOT NULL,
  invoice_number text NOT NULL,
  status public.invoice_status DEFAULT 'draft'::public.invoice_status,
  subtotal_cents integer NOT NULL DEFAULT 0,
  tax_cents integer DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  amount_paid_cents integer DEFAULT 0,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  due_date timestamp with time zone,
  paid_at timestamp with time zone,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  stripe_hosted_invoice_url text,
  stripe_invoice_pdf text,
  line_items jsonb DEFAULT '[]'::jsonb,
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_invoices_pkey PRIMARY KEY (id),
  CONSTRAINT client_invoices_agency_org_id_fkey FOREIGN KEY (agency_org_id) REFERENCES public.organizations(id),
  CONSTRAINT client_invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.org_clients(id)
);
CREATE TABLE public.credit_balances (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  lines_remaining integer NOT NULL DEFAULT 0,
  lines_used_this_period integer NOT NULL DEFAULT 0,
  bonus_lines integer NOT NULL DEFAULT 0,
  period_start timestamp with time zone NOT NULL DEFAULT date_trunc('month'::text, now()),
  period_end timestamp with time zone NOT NULL DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval),
  last_reset_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT credit_balances_pkey PRIMARY KEY (id),
  CONSTRAINT credit_balances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.extra_lines_purchases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  lines_purchased integer NOT NULL,
  price_paid integer NOT NULL,
  purchased_by uuid,
  billing_month date NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT extra_lines_purchases_pkey PRIMARY KEY (id),
  CONSTRAINT extra_lines_purchases_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT extra_lines_purchases_purchased_by_fkey FOREIGN KEY (purchased_by) REFERENCES auth.users(id)
);
CREATE TABLE public.generation_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  prompt text NOT NULL,
  request_payload jsonb,
  response_payload jsonb,
  status text NOT NULL DEFAULT 'pending'::text,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT generation_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  stripe_invoice_id text,
  invoice_number text UNIQUE,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD'::text,
  status public.invoice_status NOT NULL DEFAULT 'draft'::public.invoice_status,
  invoice_url text,
  pdf_url text,
  billing_period_start timestamp with time zone,
  billing_period_end timestamp with time zone,
  line_items jsonb DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  paid_at timestamp with time zone,
  CONSTRAINT invoices_pkey PRIMARY KEY (id),
  CONSTRAINT invoices_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text])),
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.org_invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  email text NOT NULL,
  role public.org_role NOT NULL DEFAULT 'member'::public.org_role,
  invited_by uuid NOT NULL,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'::text) UNIQUE,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '7 days'::interval),
  status public.invitation_status DEFAULT 'pending'::public.invitation_status,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT org_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT org_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id)
);
CREATE TABLE public.org_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.org_role NOT NULL DEFAULT 'member'::public.org_role,
  joined_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  is_client boolean DEFAULT false,
  client_billing_enabled boolean DEFAULT false,
  CONSTRAINT org_members_pkey PRIMARY KEY (id),
  CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.organization_billing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  stripe_customer_id text,
  default_payment_method_id text,
  payment_method_last4 text,
  payment_method_brand text,
  billing_email text,
  tax_id text,
  billing_address jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT organization_billing_pkey PRIMARY KEY (id),
  CONSTRAINT organization_billing_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.payment_methods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  stripe_payment_method_id text NOT NULL,
  type text NOT NULL,
  card_brand text,
  card_last4 text,
  card_exp_month integer,
  card_exp_year integer,
  is_default boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT payment_methods_pkey PRIMARY KEY (id),
  CONSTRAINT payment_methods_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT payment_methods_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.plan_tiers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name public.plan_tier NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  monthly_price_cents integer NOT NULL DEFAULT 0,
  annual_price_cents integer NOT NULL DEFAULT 0,
  lines_included integer NOT NULL DEFAULT 0,
  ai_agents_limit integer,
  projects_limit integer,
  members_limit integer,
  storage_gb integer DEFAULT 0,
  features jsonb DEFAULT '[]'::jsonb,
  stripe_monthly_price_id text,
  stripe_annual_price_id text,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT plan_tiers_pkey PRIMARY KEY (id)
);
CREATE TABLE public.project_add_ons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  add_on_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  status public.add_on_status NOT NULL DEFAULT 'active'::public.add_on_status,
  activated_at timestamp with time zone DEFAULT now(),
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_add_ons_pkey PRIMARY KEY (id),
  CONSTRAINT project_add_ons_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT project_add_ons_add_on_id_fkey FOREIGN KEY (add_on_id) REFERENCES public.add_ons(id)
);
CREATE TABLE public.project_billing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  billing_month date NOT NULL,
  base_plan_cost integer NOT NULL DEFAULT 0,
  lines_used integer NOT NULL DEFAULT 0,
  lines_included integer NOT NULL DEFAULT 0,
  extra_lines_cost integer NOT NULL DEFAULT 0,
  add_ons_cost integer NOT NULL DEFAULT 0,
  total_cost integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_billing_pkey PRIMARY KEY (id),
  CONSTRAINT project_billing_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.project_collaborators (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.project_member_role DEFAULT 'viewer'::public.project_member_role,
  added_at timestamp with time zone DEFAULT now(),
  added_by uuid,
  CONSTRAINT project_collaborators_pkey PRIMARY KEY (id),
  CONSTRAINT project_collaborators_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT project_collaborators_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT project_collaborators_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id)
);
CREATE TABLE public.project_custom_domains (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  domain character varying NOT NULL UNIQUE,
  status public.domain_status DEFAULT 'pending_dns'::public.domain_status,
  dns_a_record text,
  dns_txt_record text,
  ssl_status character varying DEFAULT 'pending'::character varying,
  verified_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_custom_domains_pkey PRIMARY KEY (id),
  CONSTRAINT project_custom_domains_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.project_members (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.project_member_role DEFAULT 'viewer'::public.project_member_role,
  joined_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_members_pkey PRIMARY KEY (id),
  CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id)
);
CREATE TABLE public.project_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL,
  is_encrypted boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_settings_pkey PRIMARY KEY (id),
  CONSTRAINT project_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.project_subdomains (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE,
  subdomain character varying NOT NULL UNIQUE,
  full_domain text GENERATED ALWAYS AS ((subdomain)::text || '.ecomgear.app'::text) STORED,
  is_primary boolean DEFAULT true,
  status public.domain_status DEFAULT 'pending_dns'::public.domain_status,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_subdomains_pkey PRIMARY KEY (id),
  CONSTRAINT project_subdomains_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.published_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  version_tag text NOT NULL,
  git_tag text,
  git_commit_hash text,
  deployment_url text,
  deployed_by uuid,
  status text DEFAULT 'active'::text,
  published_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT published_versions_pkey PRIMARY KEY (id),
  CONSTRAINT published_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT published_versions_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.revisions(id)
);
CREATE TABLE public.referrals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL,
  referrer_org_id uuid,
  referred_user_id uuid,
  referred_email text NOT NULL,
  referral_code text NOT NULL DEFAULT encode(gen_random_bytes(8), 'hex'::text) UNIQUE,
  bonus_lines integer DEFAULT 20,
  credited_at timestamp with time zone,
  expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT referrals_pkey PRIMARY KEY (id),
  CONSTRAINT referrals_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES auth.users(id),
  CONSTRAINT referrals_referrer_org_id_fkey FOREIGN KEY (referrer_org_id) REFERENCES public.organizations(id),
  CONSTRAINT referrals_referred_user_id_fkey FOREIGN KEY (referred_user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.revision_preview (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL,
  preview_url text,
  preview_status character varying DEFAULT 'building'::character varying,
  build_error text,
  file_count integer,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  created_by uuid,
  cloudflare_url text,
  CONSTRAINT revision_preview_pkey PRIMARY KEY (id),
  CONSTRAINT revision_preview_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.revisions(id),
  CONSTRAINT revision_preview_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  plan public.subscription_plan NOT NULL DEFAULT 'free'::public.subscription_plan,
  status public.subscription_status NOT NULL DEFAULT 'active'::public.subscription_status,
  is_annual boolean DEFAULT false,
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean DEFAULT false,
  canceled_at timestamp with time zone,
  trial_start timestamp with time zone,
  trial_end timestamp with time zone,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.usage_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid,
  user_id uuid,
  usage_type public.usage_type NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_cost_cents integer DEFAULT 0,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  recorded_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT usage_records_pkey PRIMARY KEY (id),
  CONSTRAINT usage_records_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT usage_records_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT usage_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.usage_tracking (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  org_id uuid NOT NULL,
  lines_used integer DEFAULT 0,
  period_start date NOT NULL DEFAULT date_trunc('month'::text, now()),
  period_end date NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  lines_available integer NOT NULL DEFAULT 30,
  bonus_lines integer NOT NULL DEFAULT 0,
  CONSTRAINT usage_tracking_pkey PRIMARY KEY (id)
);
CREATE TABLE public.user_roles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_roles_pkey PRIMARY KEY (id),
  CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id)
);