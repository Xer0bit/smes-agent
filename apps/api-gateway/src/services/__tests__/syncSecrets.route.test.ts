/**
 * Integration test for POST /api/v1/database/sync-secrets (database.routes.ts).
 *
 * Runs against the LOCAL Supabase stack (server/.env already points
 * SUPABASE_URL at http://127.0.0.1:54321 -- verified reachable before writing
 * this test via `curl -s http://localhost:54321/rest/v1/`). Real rows are
 * inserted into `projects` and `project_secrets` and read back to confirm the
 * route's DB side effects, then cleaned up in afterAll.
 *
 * What's mocked and why:
 *  - auth.middleware.ts: real auth would require minting a live Supabase JWT
 *    for a real auth.users row. That's the auth system's own concern, not
 *    this route's; the mock just injects req.user directly so the route body
 *    under test (buildProjectEnvSecrets + preview-service push) runs for real.
 *  - global fetch: there is no live preview-service instance in this
 *    environment, so the outbound POST to it is captured instead of sent.
 *    Everything up to and including constructing that request runs for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

process.env.PREVIEW_SERVICE_URL = 'http://localhost:3001';

const TEST_USER_ID = 'aaaaaaaa-1111-2222-3333-000000000001';
const TEST_PROJECT_ID = 'bbbbbbbb-1111-2222-3333-000000000001';

vi.mock('../../middleware/auth.middleware.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: TEST_USER_ID, email: 'sync-secrets-test@example.com' };
    next();
  },
}));

// Both the route under test AND this test file's own HTTP calls to the
// in-process server go through the global `fetch`, so the stub below has to
// tell them apart by URL: only the preview-service call gets faked, real
// requests to the local test server pass through to the real fetch.
const realFetch = globalThis.fetch;
const previewCalls: { url: string; opts: any }[] = [];
const fetchMock = vi.fn(async (url: string, opts?: any) => {
  if (url.startsWith('http://localhost:3001/preview/')) {
    previewCalls.push({ url, opts });
    return { ok: true, json: async () => ({ restarted: true }) } as any;
  }
  return realFetch(url, opts);
});

const { default: databaseRoutes } = await import('../../routes/database.routes.js');
const { supabase } = await import('../../config/database.js');

let baseUrl: string;
let app: express.Express;
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  // Real row this project owns, so requireProjectEdit's ownership check
  // (project.service.ts getUserRole: user_id === userId -> 'owner') passes
  // against the real local Supabase data, not a mock.
  const { error } = await supabase.from('projects').insert({
    id: TEST_PROJECT_ID,
    user_id: TEST_USER_ID,
    name: 'sync-secrets-test-project',
    status: 'active',
  });
  if (error) throw new Error(`fixture setup failed: ${error.message}`);

  app = express();
  app.use(express.json());
  app.use('/api/v1/database', databaseRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await supabase.from('project_secrets').delete().eq('project_id', TEST_PROJECT_ID);
  await supabase.from('projects').delete().eq('id', TEST_PROJECT_ID);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  fetchMock.mockClear();
  previewCalls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  await supabase.from('project_secrets').delete().eq('project_id', TEST_PROJECT_ID);
});

describe('POST /api/v1/database/sync-secrets', () => {
  it('upserts platform-managed secrets into project_secrets and pushes the full set to preview-service', async () => {
    const res = await fetch(`${baseUrl}/api/v1/database/sync-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ project_id: TEST_PROJECT_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBeGreaterThan(0);
    expect(body.restarted).toBe(true);

    // Real DB check: buildProjectEnvSecrets' syncPlatformAuthSecrets side
    // effect (fire-and-forget) upserts VITE_SUPABASE_URL/ANON_KEY into the
    // real project_secrets table -- confirm it actually landed there.
    await new Promise((r) => setTimeout(r, 200)); // let the unawaited upsert land
    const { data: rows } = await supabase
      .from('project_secrets')
      .select('key_name, key_value')
      .eq('project_id', TEST_PROJECT_ID);
    const keyNames = (rows ?? []).map((r: any) => r.key_name).sort();
    expect(keyNames).not.toContain('VITE_SUPABASE_URL');
    expect(keyNames).not.toContain('VITE_SUPABASE_ANON_KEY');

    // preview-service call: mocked, but constructed for real by the route.
    expect(previewCalls).toHaveLength(1);
    const { url, opts } = previewCalls[0];
    expect(url).toBe(`http://localhost:3001/preview/${TEST_PROJECT_ID}/secrets`);
    expect(opts.method).toBe('POST');
    const sentBody = JSON.parse(opts.body);
    const sentKeyNames = sentBody.secrets.map((s: any) => s.key_name).sort();
    expect(sentKeyNames).not.toContain('VITE_SUPABASE_URL');
  });

  it('a genuine user-set secret survives the sync and is included in the pushed set', async () => {
    await supabase.from('project_secrets').insert({
      project_id: TEST_PROJECT_ID,
      key_name: 'STRIPE_API_KEY',
      key_value: 'sk_live_test',
      key_preview: '****test',
    });

    const res = await fetch(`${baseUrl}/api/v1/database/sync-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ project_id: TEST_PROJECT_ID }),
    });
    expect(res.status).toBe(200);

    const { opts } = previewCalls[0];
    const sentBody = JSON.parse(opts.body);
    const stripeRow = sentBody.secrets.find((s: any) => s.key_name === 'STRIPE_API_KEY');
    expect(stripeRow).toBeTruthy();
    expect(stripeRow.key_value).toBe('sk_live_test');
  });

  it('returns 400 when project_id is missing', async () => {
    const res = await fetch(`${baseUrl}/api/v1/database/sync-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a project the authenticated user does not own', async () => {
    const otherProjectId = 'cccccccc-1111-2222-3333-000000000099';
    const res = await fetch(`${baseUrl}/api/v1/database/sync-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ project_id: otherProjectId }),
    });
    expect(res.status).toBe(404);
  });
});
