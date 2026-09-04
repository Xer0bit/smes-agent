// Runnable check for the chainable db.* query builder added 2026-08-18
// (fixes 21 live functions that used Supabase-style chaining against a
// runtime that only ever supported flat calls). Run: node
// apps/tenant-functions-runner/query-builder.selfcheck.mjs
import assert from 'node:assert/strict';
import { buildDbHelper } from './runEdgeFunction.js';

const ctx = { apiUrl: 'https://cloud.SMEsAgent.app', schema: 'tenant_test', serviceKey: 'test-key' };

function mockFetch(handler) {
  global.fetch = async (url, init) => handler(String(url), init);
}

// 1. Legacy flat call, unchained -- must behave exactly as before (zero
//    regression for every currently-working function).
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/parents?status=eq.active');
    return { ok: true, json: async () => [{ id: 1 }] };
  });
  const db = buildDbHelper(ctx);
  const rows = await db.select('parents', { status: 'active' });
  assert.deepEqual(rows, [{ id: 1 }]);
}

// 2. Chained select: db.select('parents').eq('status','active').order('name')
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/parents?status=eq.active&order=name.asc');
    return { ok: true, json: async () => [{ id: 2 }] };
  });
  const db = buildDbHelper(ctx);
  const rows = await db.select('parents').eq('status', 'active').order('name');
  assert.deepEqual(rows, [{ id: 2 }]);
}

// 3. .single() sets the PostgREST single-object Accept header.
{
  mockFetch(async (url, init) => {
    assert.equal(init.headers.Accept, 'application/vnd.pgrst.object+json');
    return { ok: true, json: async () => ({ id: 3 }) };
  });
  const db = buildDbHelper(ctx);
  const row = await db.select('students').eq('id', 'x').single();
  assert.deepEqual(row, { id: 3 });
}

// 4. .maybeSingle() unwraps an array to its first element or null client-side.
{
  mockFetch(async () => ({ ok: true, json: async () => [] }));
  const db = buildDbHelper(ctx);
  const row = await db.select('students').eq('id', 'missing').maybeSingle();
  assert.equal(row, null);
}

// 5. The `.select(cols).from(table)` inverted idiom seen in real generated
//    code (record-attendance, pm-renewal-project): first select() arg is
//    actually columns, from() supplies the real table.
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/attendance?select=id%2Cstatus');
    return { ok: true, json: async () => [] };
  });
  const db = buildDbHelper(ctx);
  await db.select('id,status').from('attendance');
}

// 6. insert(...).select() -- chained select narrows returned columns,
//    still return=representation.
{
  mockFetch(async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Prefer, 'return=representation');
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/projects?select=id');
    return { ok: true, json: async () => [{ id: 9 }] };
  });
  const db = buildDbHelper(ctx);
  const rows = await db.insert('projects', { name: 'x' }).select('id');
  assert.deepEqual(rows, [{ id: 9 }]);
}

// 7. delete() without chaining now also gets return=representation (the
//    204-empty-body bug fixed alongside the chain builder).
{
  mockFetch(async (url, init) => {
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers.Prefer, 'return=representation');
    return { ok: true, json: async () => [] };
  });
  const db = buildDbHelper(ctx);
  await db.delete('enrollments', { id: 'x' });
}

// 8. .not(col, op, val) negates an arbitrary operator.
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/renewals?renewal_date=not.is.null');
    return { ok: true, json: async () => [] };
  });
  const db = buildDbHelper(ctx);
  await db.select('renewals').not('renewal_date', 'is', null);
}

// 9. Legacy filter arg survives chaining an unrelated method (2026-08-18
//    regression: db.update(t, data, {id}).select() lost its WHERE clause,
//    updating every row instead of one).
{
  mockFetch(async (url, init) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/orders?id=eq.5');
    assert.equal(init.method, 'PATCH');
    return { ok: true, json: async () => [{ id: 5 }] };
  });
  const db = buildDbHelper(ctx);
  const rows = await db.update('orders', { status: 'shipped' }, { id: 5 }).select();
  assert.deepEqual(rows, [{ id: 5 }]);
}

// 10. Same for delete() -- chaining .select() must not drop the filter.
{
  mockFetch(async (url, init) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/orders?id=eq.5');
    assert.equal(init.method, 'DELETE');
    return { ok: true, json: async () => [{ id: 5 }] };
  });
  const db = buildDbHelper(ctx);
  await db.delete('orders', { id: 5 }).select();
}

// 11. .range(from, to) must apply BOTH limit and offset (2026-08-18
//     regression: offset was silently never sent, so every page returned
//     page 1's rows).
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/posts?order=created_at.asc&limit=10&offset=20');
    return { ok: true, json: async () => [] };
  });
  const db = buildDbHelper(ctx);
  await db.select('posts').order('created_at').range(20, 29);
}

// 12. .in() array values are URL-encoded per-element (2026-08-18 regression:
//     an unescaped '&' or ',' inside a value corrupted the query string).
{
  mockFetch(async (url) => {
    assert.equal(url, 'https://cloud.SMEsAgent.app/rest/v1/t?status=in.(a%2Cb%26c,plain)');
    return { ok: true, json: async () => [] };
  });
  const db = buildDbHelper(ctx);
  await db.select('t').in('status', ['a,b&c', 'plain']);
}

console.log('query-builder.selfcheck.mjs: all checks passed');
