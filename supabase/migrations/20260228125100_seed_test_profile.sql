-- Insert seeded profile only if the corresponding auth user exists.
INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
SELECT
  'b8a561b2-edda-4007-8b8f-0db901bff5b4'::uuid,
  'test@example.com',
  'Test User',
  now(),
  now()
WHERE EXISTS (
  SELECT 1
  FROM auth.users
  WHERE id = 'b8a561b2-edda-4007-8b8f-0db901bff5b4'::uuid
)
ON CONFLICT (id) DO NOTHING;
