-- The platform used to hand every project its OWN Supabase URL and anon key
-- as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (database.service.ts
-- syncPlatformAuthSecrets, removed 2026-09-02). Generated apps then signed
-- their users up against EcomGear's auth database, with the platform key in
-- every bundle. Scoped to the platform's own values so an owner's genuinely
-- saved Supabase credentials under the same names are left alone.
DELETE FROM public.project_secrets
WHERE key_name = 'VITE_SUPABASE_URL'
  AND key_value IN ('https://api.ecomgear.dev', 'https://api.ecomgear.dev/');

DELETE FROM public.project_secrets
WHERE key_name = 'VITE_SUPABASE_ANON_KEY'
  AND key_value = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
