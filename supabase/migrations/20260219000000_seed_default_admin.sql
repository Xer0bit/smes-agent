-- =============================================================================
-- Migration: Create user_roles table + seed default super_admin user
-- Date: 2026-02-19
-- Default admin credentials:
--   Email:    admin@ecomgear.com
--   Password: Admin@ecomgear2026!
-- Change the password immediately after first login.
-- =============================================================================

-- Enable pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. Create user_roles table (if not already present)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_roles (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'admin', 'super_admin')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id)
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helper: reads user_roles without triggering RLS (prevents infinite recursion)
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Allow admins/super_admins to read all roles; users can read their own
CREATE POLICY "user_roles_select"
    ON user_roles FOR SELECT
    USING (
        auth.uid() = user_id
        OR public.get_my_role() IN ('admin', 'super_admin')
    );

-- Only super_admins can insert / update / delete roles
CREATE POLICY "user_roles_write"
    ON user_roles FOR ALL
    USING (public.get_my_role() = 'super_admin');

-- =============================================================================
-- 2. Insert default super_admin into auth.users
-- =============================================================================
DO $$
DECLARE
    v_user_id UUID := 'a0000000-0000-0000-0000-000000000001';
BEGIN
    -- Skip if admin already exists
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN

        INSERT INTO auth.users (
            id,
            instance_id,
            aud,
            role,
            email,
            encrypted_password,
            email_confirmed_at,
            confirmation_sent_at,
            recovery_sent_at,
            email_change_sent_at,
            last_sign_in_at,
            raw_app_meta_data,
            raw_user_meta_data,
            is_super_admin,
            created_at,
            updated_at,
            -- GoTrue requires empty strings, not NULL, for these token columns
            confirmation_token,
            recovery_token,
            email_change_token_new,
            email_change_token_current,
            reauthentication_token,
            phone_change_token,
            phone_change,
            email_change
        ) VALUES (
            v_user_id,
            '00000000-0000-0000-0000-000000000000',
            'authenticated',
            'authenticated',
            'admin@ecomgear.com',
            crypt('Admin@ecomgear2026!', gen_salt('bf')),
            NOW(),
            NOW(),
            NULL,
            NULL,
            NOW(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"full_name":"eCOMGear Admin"}'::jsonb,
            FALSE,
            NOW(),
            NOW(),
            '', '', '', '', '', '', '', ''
        );

    END IF;
END $$;

-- =============================================================================
-- 3. Create profile for the default admin
-- =============================================================================
INSERT INTO profiles (id, email, full_name, created_at, updated_at)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'admin@ecomgear.com',
    'eCOMGear Admin',
    NOW(),
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 4. Grant super_admin role
-- =============================================================================
INSERT INTO user_roles (user_id, role)
VALUES ('a0000000-0000-0000-0000-000000000001', 'super_admin')
ON CONFLICT (id) DO UPDATE SET role = 'super_admin';
