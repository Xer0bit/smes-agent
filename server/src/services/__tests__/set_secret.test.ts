/**
 * Verifies the collision guard in set_secret.ts (server/src/agent-tools/set_secret.ts):
 *  - the 6 PLATFORM_MANAGED_KEYS can never be overridden by the agent
 *  - a VITE_-prefixed name that looks like a server-only secret is rejected
 *  - a genuinely allowed key is actually written
 *
 * Drives execute() directly against a mocked Supabase client + global fetch
 * (no live preview-service instance in this environment).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertCalls: any[] = [];
const selectCalls: any[] = [];

function makeBuilder(table: string) {
  const builder: any = {
    upsert: (rows: any, opts: any) => {
      upsertCalls.push({ table, rows, opts });
      return Promise.resolve({ error: null });
    },
    select: (cols: string) => {
      selectCalls.push({ table, cols });
      return builder;
    },
    eq: () => Promise.resolve({ data: [], error: null }),
  };
  return builder;
}

vi.mock('../../config/database.js', () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { setSecretTool } = await import('../../agent-tools/set_secret.js');

const onXmlComplete = vi.fn();
function makeCtx() {
  return { appPath: '/tmp/x', projectId: 'project-1', onXmlComplete } as any;
}

beforeEach(() => {
  upsertCalls.length = 0;
  selectCalls.length = 0;
  onXmlComplete.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

const PLATFORM_MANAGED_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_DB_API_URL',
  'VITE_DB_ANON_KEY',
  'VITE_DB_SCHEMA',
  'VITE_FUNCTIONS_API_URL',
];

describe('set_secret   platform-managed key collision guard', () => {
  for (const key of PLATFORM_MANAGED_KEYS) {
    it(`rejects an attempt to set ${key}`, async () => {
      const result = await setSecretTool.execute({ key_name: key, value: 'sneaky-value' }, makeCtx());
      expect(result).toBe(
        `ERROR: "${key}" is a platform-managed variable (set automatically for auth/hosted-database access) and cannot be overridden. It's already correctly configured -- use it as-is via import.meta.env.${key}.`
      );
      expect(upsertCalls).toHaveLength(0);
      expect(onXmlComplete).not.toHaveBeenCalled();
    });
  }

  it('rejects even when the key name is given lowercase/mixed-case (guard runs after normalization)', async () => {
    const result = await setSecretTool.execute({ key_name: 'vite_supabase_url', value: 'x' }, makeCtx());
    expect(result).toContain('is a platform-managed variable');
    expect(upsertCalls).toHaveLength(0);
  });
});

describe('set_secret   VITE_-prefixed name that looks like a server-only secret', () => {
  it('rejects VITE_STRIPE_SECRET_KEY', async () => {
    const result = await setSecretTool.execute({ key_name: 'VITE_STRIPE_SECRET_KEY', value: 'sk_test_x' }, makeCtx());
    expect(result).toBe(
      'ERROR: "VITE_STRIPE_SECRET_KEY" looks like a server-only secret but has a VITE_ prefix, which ships its value to every visitor\'s browser. Save it WITHOUT the VITE_ prefix and use it inside an edge function (write_edge_function) as `secrets.STRIPE_SECRET_KEY` instead.'
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it.each(['VITE_API_TOKEN', 'VITE_PRIVATE_KEY', 'VITE_SERVICE_ROLE_KEY'])(
    'rejects %s',
    async (key) => {
      const result = await setSecretTool.execute({ key_name: key, value: 'x' }, makeCtx());
      expect(result).toContain('looks like a server-only secret but has a VITE_ prefix');
      expect(upsertCalls).toHaveLength(0);
    }
  );

  it('does NOT reject a VITE_-prefixed name that does not look secret-like', async () => {
    const result = await setSecretTool.execute({ key_name: 'VITE_APP_NAME', value: 'MyApp' }, makeCtx());
    expect(result).toContain('Saved secret "VITE_APP_NAME"');
    expect(upsertCalls).toHaveLength(1);
  });
});

describe('set_secret   genuinely allowed key', () => {
  it('accepts and writes a non-platform, non-VITE-secret-looking key', async () => {
    const result = await setSecretTool.execute({ key_name: 'STRIPE_API_KEY', value: 'sk_live_abc123' }, makeCtx());

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].table).toBe('project_secrets');
    expect(upsertCalls[0].rows).toEqual([
      { project_id: 'project-1', key_name: 'STRIPE_API_KEY', key_value: 'sk_live_abc123', key_preview: '****c123' },
    ]);
    expect(upsertCalls[0].opts).toEqual({ onConflict: 'project_id,key_name' });

    expect(result).toContain('Saved secret "STRIPE_API_KEY"');
    expect(result).toContain('This key has no VITE_ prefix');
    expect(onXmlComplete).toHaveBeenCalledWith(
      expect.stringContaining('<ecomgear-write path="secrets/STRIPE_API_KEY"')
    );

    // Preview-service push happened (mocked global fetch), with the full
    // current secret set for the project.
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/preview/project-1/secrets',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects an invalid env var name before ever touching storage', async () => {
    const result = await setSecretTool.execute({ key_name: '123-bad name!', value: 'x' }, makeCtx());
    // sanitization uppercases + strips invalid chars, then the leading-char check trips
    expect(result).toContain('is not a valid env var name');
    expect(upsertCalls).toHaveLength(0);
  });
});
