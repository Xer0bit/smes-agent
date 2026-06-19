import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL environment variable is required');
}

if (!supabaseServiceKey) {
    throw new Error('SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY environment variable is required');
}

// Supabase client with service role key for server-side operations
export const supabase: SupabaseClient = createClient(
    process.env.SUPABASE_URL,
    supabaseServiceKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// Supabase client for user authentication verification
export const supabaseAuth: SupabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || supabaseServiceKey
);

export default supabase;
