/**
 * /health must identify WHICH deployment a process is, not just that it is up.
 *
 * Gap register G27 (.scratch/agent-gap-register/gaps.md): `/api/v1/ai/*` only
 * mounts where SERVICE_ROLE=gen (VPS3). An entire session's worth of agent
 * fixes was once deployed to VPS1 (SERVICE_ROLE=api) with a green health check
 * every single time, because the old /health reported only status/uptime/
 * version -- nothing that could distinguish "right code, wrong box".
 *
 * The third test is the one that matters most: it asserts the reported
 * mountedRoutes list is not a hand-maintained description that can drift, by
 * proving every path it claims is genuinely routable (i.e. does NOT fall
 * through to the catch-all 404 handler). A 401/403 from an auth-guarded route
 * still proves it is mounted; only the 404 handler's own body means "not
 * mounted".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// app.ts -> config/database.js throws at module load without SUPABASE_*; none
// of it is exercised by the routing/health behavior under test.
vi.mock('../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

interface HealthBody {
  status: string;
  serviceRole: string;
  serves: { gen: boolean; api: boolean };
  mountedRoutes: string[];
}

let server: Server | undefined;

async function startAppWith(serviceRole: string): Promise<{ base: string; health: HealthBody }> {
  process.env.SERVICE_ROLE = serviceRole;
  // app.ts records mountedRoutes at import time, so each role needs a fresh
  // module graph rather than a re-read of an already-evaluated module.
  vi.resetModules();
  const { default: app } = await import('../app.js');

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  return { base, health: await res.json() };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  delete process.env.SERVICE_ROLE;
});

describe('/health service-role reporting', () => {
  it('a gen-role process reports gen and mounts the agent routes, not the api routes', async () => {
    const { health } = await startAppWith('gen');

    expect(health.serviceRole).toBe('gen');
    expect(health.serves).toEqual({ gen: true, api: false });
    expect(health.mountedRoutes).toContain('/api/v1/ai');
    expect(health.mountedRoutes).not.toContain('/api/v1/projects');
  });

  it('an api-role process reports api and mounts the api routes, not the agent routes', async () => {
    const { health } = await startAppWith('api');

    expect(health.serviceRole).toBe('api');
    expect(health.serves).toEqual({ gen: false, api: true });
    expect(health.mountedRoutes).toContain('/api/v1/projects');
    expect(health.mountedRoutes).toContain('/api/v1/database');
    // The exact miss that G27 describes: agent traffic is NOT served here.
    expect(health.mountedRoutes).not.toContain('/api/v1/ai');
  });

  it('mountedRoutes matches the routers express actually has, in both directions (anti-drift)', async () => {
    // An HTTP probe cannot decide this: `GET /api/v1/ai` legitimately 404s
    // because that router has no bare-prefix handler, which is not the same
    // as being unmounted. Express's own layer stack is the only source that
    // answers "is this really mounted" without ambiguity. name === 'router'
    // selects mounted Routers specifically, excluding path-mounted plain
    // middleware (e.g. the express.raw body parser on the billing webhook).
    process.env.SERVICE_ROLE = 'all';
    vi.resetModules();
    const { default: app } = await import('../app.js');

    const routerLayers = app._router.stack.filter(
      (layer: { name: string }) => layer.name === 'router',
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    const health: HealthBody = await (await fetch(`http://127.0.0.1:${port}/health`)).json();

    expect(health.mountedRoutes.length).toBeGreaterThan(10);

    // Forward: nothing is reported that isn't really mounted.
    for (const route of health.mountedRoutes) {
      expect(
        routerLayers.some((layer: { regexp: RegExp }) => layer.regexp.test(route)),
        `/health reports "${route}" but express has no router mounted there`,
      ).toBe(true);
    }

    // Reverse: nothing is mounted that isn't reported. This is the assertion
    // that catches a future `app.use('/api/v1/new', ...)` added directly
    // instead of through mount(), which would be live but invisible to
    // /health -- exactly the blind spot this endpoint exists to remove.
    expect(
      routerLayers.length,
      'a router is mounted that /health does not report -- use mount(), not app.use()',
    ).toBe(health.mountedRoutes.length);
  });
});
