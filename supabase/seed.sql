-- =============================================================
-- Seed: Default Admin User for Local Development
-- =============================================================
-- Email:    admin@SMEsAgent.local
-- Password: admin123456
-- =============================================================

-- 1. Create the auth user in Supabase Auth
-- The password 'admin123456' is hashed using bcrypt
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  is_super_admin,
  email_change,
  email_change_token_new,
  email_change_token_current,
  phone,
  phone_change,
  phone_change_token,
  phone_confirmed_at,
  email_change_confirm_status
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'admin@SMEsAgent.local',
  crypt('admin123456', gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Admin User"}',
  now(),
  now(),
  '',
  '',
  false,
  '',
  '',
  '',
  '',
  '',
  '',
  NULL,
  0
) ON CONFLICT (id) DO NOTHING;

-- Also insert into auth.identities (required by newer Supabase versions)
INSERT INTO auth.identities (
  id,
  user_id,
  provider_id,
  provider,
  identity_data,
  last_sign_in_at,
  created_at,
  updated_at
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'admin@SMEsAgent.local',
  'email',
  jsonb_build_object(
    'sub', 'a0000000-0000-0000-0000-000000000001',
    'email', 'admin@SMEsAgent.local',
    'email_verified', true,
    'phone_verified', false
  ),
  now(),
  now(),
  now()
) ON CONFLICT (provider_id, provider) DO NOTHING;

-- 2. Create the profile
INSERT INTO public.profiles (
  id,
  email,
  full_name,
  created_at,
  updated_at,
  account_status,
  preferred_language,
  region
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'admin@SMEsAgent.local',
  'Admin User',
  now(),
  now(),
  'active',
  'en',
  'global'
) ON CONFLICT (id) DO NOTHING;

-- 3. Assign super_admin role
INSERT INTO public.user_roles (
  user_id,
  role
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'super_admin'
) ON CONFLICT DO NOTHING;

-- 4. Create a default organization
INSERT INTO public.organizations (
  id,
  name,
  slug,
  status,
  created_by,
  plan_tier,
  subscription_plan,
  region
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'SMEsAgent Admin',
  'SMEsAgent-admin',
  'active',
  'a0000000-0000-0000-0000-000000000001',
  'enterprise',
  'agency',
  'global'
) ON CONFLICT (id) DO NOTHING;

-- 5. Add admin as org member (owner)
INSERT INTO public.org_members (
  org_id,
  user_id,
  role
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'admin'
) ON CONFLICT DO NOTHING;

-- 6. Create a default project for testing
INSERT INTO public.projects (
  id,
  name,
  slug,
  description,
  status,
  created_by,
  user_id,
  organization_id,
  org_id,
  visibility,
  message_count,
  revision_count
) VALUES (
  'c0000000-0000-0000-0000-000000000001',
  'My SMEsAgent Store',
  'my-SMEsAgent-store',
  'A sample e-commerce project for local development and testing.',
  'active',
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001',
  'org_all',
  0,
  0
) ON CONFLICT (id) DO NOTHING;
