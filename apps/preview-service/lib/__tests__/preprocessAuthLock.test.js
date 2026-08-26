import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { preprocessFile } = require('../materialize.js');

/**
 * Every generated project's platform-auth client points at the SAME
 * Supabase project (database.service.ts), and every preview is served from
 * one origin -- so @supabase/supabase-js's default Navigator Lock (keyed off
 * that shared URL) is contended across every open preview tab, on every
 * project. A losing tab throws NavigatorLockAcquireTimeoutError, which can
 * blank the page before it ever mounts (same failure class as Fix 3.46's
 * undefined-URL incidents). preprocessFile injects a no-op lock so the
 * platform auth client never touches Web Locks at all.
 */
describe('preprocessFile adds a no-op auth lock to the platform auth client', () => {
  const RAW = `export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});`;

  test('injects lock into src/integrations/supabase/client.ts', () => {
    const r = preprocessFile('src/integrations/supabase/client.ts', RAW);
    expect(r.content).toContain('lock: (_name, _acquireTimeout, fn) => fn(),');
    expect(r.issues.length).toBe(1);
  });

  test('is idempotent -- does not double-inject on a second pass', () => {
    const once = preprocessFile('src/integrations/supabase/client.ts', RAW).content;
    const twice = preprocessFile('src/integrations/supabase/client.ts', once);
    expect(twice.content).toBe(once);
    expect(twice.issues.length).toBe(0);
  });

  test('leaves an existing custom lock option alone', () => {
    const raw = RAW.replace('autoRefreshToken: true,', 'autoRefreshToken: true,\n    lock: myCustomLock,');
    const r = preprocessFile('src/integrations/supabase/client.ts', raw);
    expect(r.content).toBe(raw);
    expect(r.issues.length).toBe(0);
  });

  test('does not touch other files that happen to createClient', () => {
    const r = preprocessFile('src/lib/tenant.ts', RAW);
    expect(r.content).toBe(RAW);
  });
});
