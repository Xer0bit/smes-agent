-- Add ecg_auth_user_id to profiles so we can link a Supabase user record
-- to the corresponding eCG Auth user when the two accounts coexist during
-- migration.  Nullable + UNIQUE so existing rows are unaffected and
-- duplicates are prevented.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ecg_auth_user_id uuid UNIQUE;

-- Index for fast lookups when we need to check if a profile has been
-- migrated to eCG Auth.
CREATE INDEX IF NOT EXISTS idx_profiles_ecg_auth_user_id
  ON public.profiles (ecg_auth_user_id)
  WHERE ecg_auth_user_id IS NOT NULL;
