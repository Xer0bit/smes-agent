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

  // A spec carrying legacyFilter (what the guest-side builder seeds a bare
  // `db.update(t, data, {id}).select()` call with) must apply that filter --
  // previously dropped, turning a single-row update/delete into a full-table
  // one the moment an unrelated method (here: select()) triggered chaining.
  it('applies legacyFilter on an update spec (dropped filter regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 5 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'update', table: 'orders', data: { status: 'shipped' }, legacyFilter: { id: 5 }, filters: [], order: [] };
    await db.query(spec);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/orders?id=eq.5');
    expect(init.method).toBe('PATCH');
  });

  it('applies legacyFilter on a delete spec (dropped filter regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 5 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'delete', table: 'orders', legacyFilter: { id: 5 }, filters: [], order: [] };
    await db.query(spec);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/orders?id=eq.5');
  });

  it('applies legacyColumns/legacyFilter on a select spec', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 5 }] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 'orders', legacyColumns: ['id', 'status'], legacyFilter: { id: 5 }, filters: [], order: [] };
    await db.query(spec);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/orders?select=id,status&id=eq.5');
  });

  // range(from, to) must apply both limit AND offset -- offset was silently
  // never sent, so every requested page returned page 1's rows.
  it('range() applies both limit and offset', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 'posts', filters: [], order: [{ col: 'created_at', ascending: true }], limit: 10, offset: 20 };
    await db.query(spec);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/posts?order=created_at.asc&limit=10&offset=20');
  });

  // in()/contains() array values must be URL-encoded per element -- an
  // unescaped '&' or ',' inside a value corrupted the query string.
  it('in() URL-encodes each array value', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    global.fetch = fetchMock as any;

    const db = buildDbHelper(baseCtx as any);
    const spec: QuerySpec = { action: 'select', table: 't', filters: [{ col: 'status', op: 'in', val: ['a,b&c', 'plain'] }], order: [] };
    await db.query(spec);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.ecomgear.dev/rest/v1/t?status=in.(a%2Cb%26c,plain)');
  });
});
