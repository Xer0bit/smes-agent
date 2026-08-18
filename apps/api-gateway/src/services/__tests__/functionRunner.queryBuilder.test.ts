/**
 * Verifies buildDbHelper's `query()` bridge (added 2026-08-18) -- the
 * host-side backing for the guest-side chainable builder in GUEST_BOOTSTRAP.
 * Real incident: 21 active tenant functions used Supabase-style chaining
 * (db.select('t').eq('id', x).order('name').single()) against a runtime
 * that only ever exposed flat select(table, columns?, filter?, extra?), so
 * every one of them threw TypeError on first call. This file covers the new
 * query-descriptor path directly; functionRunner.dbRpc.test.ts still covers
 * the unchanged legacy flat contract.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDbHelper, type QuerySpec } from '../functionRunner.service.js';

const baseCtx = {
  apiUrl: 'https://cloud.ecomgear.dev',
  schema: 'tenant_test',
  serviceKey: 'test-service-key',
};

describe('functionRunner db.query (chainable builder backend)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('builds a filtered, ordered select URL from the spec', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 1 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = {
      action: 'select',
      table: 'parents',
      filters: [{ col: 'status', op: 'eq', val: 'active' }],
      order: [{ col: 'name', ascending: true }],
    };
    const result = await db.query(spec);

    expect(result).toEqual([{ id: 1 }]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/parents?status=eq.active&order=name.asc');
  });

  it('single() requests the PostgREST single-object Accept header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 2 }) });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 'students', filters: [{ col: 'id', op: 'eq', val: 'x' }], order: [], single: true };
    const result = await db.query(spec);

    expect(result).toEqual({ id: 2 });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.pgrst.object+json');
  });

  it('maybeSingle() returns null for an empty result instead of throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as any;
    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 'students', filters: [], order: [], maybeSingle: true };
    expect(await db.query(spec)).toBeNull();
  });

  it('insert with return=representation and a chained select() narrows columns', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 9 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'insert', table: 'projects', data: { name: 'x' }, columns: 'id', filters: [], order: [] };
    const result = await db.query(spec);

    expect(result).toEqual([{ id: 9 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/projects?select=id');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
  });

  it('not() negates an arbitrary operator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 'renewals', filters: [{ col: 'renewal_date', op: 'is', val: null, negate: true }], order: [] };
    await db.query(spec);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/renewals?renewal_date=not.is.null');
  });

  it('delete() now sets return=representation, fixing the 204-empty-body throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 1 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const result = await db.delete('enrollments', { id: 'x' });

    expect(result).toEqual([{ id: 1 }]);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
  });
});
