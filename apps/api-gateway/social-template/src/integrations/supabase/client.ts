// Central eCG cloud auth client — AUTH ONLY (sign up, log in, session).
// All app data goes through platform edge functions (src/lib/tenant.ts),
// never through this client. Env vars are injected by the platform; never
// hardcode URLs or keys here.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
    // Every generated project shares this same platform Supabase project, and
    // every preview lives on one origin -- so the default Navigator Lock
    // (keyed off this URL) is contended across every open preview tab, on
    // every project, not just tabs of this one. A losing tab can throw
    // NavigatorLockAcquireTimeoutError and blank the page before it ever
    // mounts. Previews don't need cross-tab-synced token refresh, so skip
    // the lock entirely.
    lock: (_name, _acquireTimeout, fn) => fn(),
  }
});
