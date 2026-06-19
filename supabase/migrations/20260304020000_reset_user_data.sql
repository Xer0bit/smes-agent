-- Disabled on shared/prod-like environments to prevent destructive data resets.
DO $$
BEGIN
  RAISE NOTICE 'Skipping reset_user_data migration on this environment.';
END $$;
