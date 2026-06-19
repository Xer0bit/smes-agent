-- Add missing foreign key constraints on usage_tracking
-- so PostgREST can resolve embedded resource queries

-- FK to organizations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'usage_tracking_org_id_fkey'
      AND table_name = 'usage_tracking'
  ) THEN
    ALTER TABLE public.usage_tracking
      ADD CONSTRAINT usage_tracking_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- FK to profiles (user_id → profiles.id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'usage_tracking_user_id_fkey'
      AND table_name = 'usage_tracking'
  ) THEN
    ALTER TABLE public.usage_tracking
      ADD CONSTRAINT usage_tracking_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
