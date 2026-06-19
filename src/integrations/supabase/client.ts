import { createClient } from '@supabase/supabase-js';
//import envs

const DEV_SUPABASE_URL = 'http://localhost:54321';
const DEV_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const VITE_SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL;
const VITE_SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.SUPABASE_ANON_KEY;

// External Supabase for database operations
const supabaseUrl = VITE_SUPABASE_URL || (import.meta.env.DEV ? DEV_SUPABASE_URL : '');
const supabaseAnonKey = VITE_SUPABASE_PUBLISHABLE_KEY || (import.meta.env.DEV ? DEV_SUPABASE_PUBLISHABLE_KEY : '');

if (!supabaseUrl) {
  throw new Error(
    'Missing Supabase URL. Set VITE_SUPABASE_URL in your frontend .env file.'
  );
}

if (!supabaseAnonKey) {
  throw new Error(
    'Missing Supabase publishable key. Set VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY).'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage,
  },
});

// Lovable Cloud Supabase for edge functions (AI)
// Use same URL and key as main client to share authentication
// Since they share the same URL and Credentials, we can just reuse the client instance
// to avoid "Duplicate GoTrueClient" warnings.
export const lovableCloud = supabase;

export const SUPABASE_URL = supabaseUrl;
export const SUPABASE_ANON_KEY = supabaseAnonKey;
export const LOVABLE_CLOUD_URL = supabaseUrl;

