import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './client';

// Separate Supabase client for the super-admin portal.
// Uses a distinct storageKey so admin sessions never conflict with
// regular user sessions when both portals are open in the same browser.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage,
    storageKey: 'ecg-admin-auth',
  },
});
