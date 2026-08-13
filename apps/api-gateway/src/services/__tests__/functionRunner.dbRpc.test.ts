/**
 * Verifies db.rpc's error-handling contract (fixed 2026-08-13): on a
 * non-2xx PostgREST response it must resolve { data: null, error } instead
 * of throwing. Real incident: register_and_login's own duplicate-email
 * handling (`if (regError.message.includes('users_email_key'))`) was
 * unreachable because the old implementation threw before that check could
 * ever run, so every DB failure surfaced as a generic "unexpected error"
 * instead of the function's own specific message.
 *
 * db.select/insert/update/delete still throw on failure by design (see the
 * updated app-builder.prompt.ts db.* contract) -- only rpc's contract
 * changed, so this file covers rpc specifically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbHelper } from '../functionRunner.service.js';

const baseCtx = {
  apiUrl: 'https://cloud.ecomgear.dev',
  schema: 'tenant_test',
  serviceKey: 'test-service-key',
};

describe('functionRunner db.rpc', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves { data: null, error } on a PostgREST error response instead of throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({
        code: '23505',
        details: 'Key (email)=(sameer@ecom.dev) already exists.',
        hint: null,
        message: 'duplicate key value violates unique constraint "users_email_key"',
      }),
    }) as any;

    const db = buildDbHelper(baseCtx as any);
    const result = await db.rpc('register_and_login', { p_email: 'sameer@ecom.dev' });

    expect(result).toEqual({
      data: null,
      error: {
        code: '23505',
        details: 'Key (email)=(sameer@ecom.dev) already exists.',
        hint: null,
        message: 'duplicate key value violates unique constraint "users_email_key"',
        status: 409,
      },
    });
  });

  it('lets generated code branch on error.message the way pm-auth.js does', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"' }),
    }) as any;

    const db = buildDbHelper(baseCtx as any);
    const { data, error } = await db.rpc('register_and_login', {});

    expect(data).toBeNull();
    expect(error.message.includes('users_email_key')).toBe(true);
  });

  it('falls back to a { message } shape when the error body is not JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    }) as any;

    const db = buildDbHelper(baseCtx as any);
    const result = await db.rpc('some_fn', {});

    expect(result).toEqual({ data: null, error: { message: 'Bad Gateway', status: 502 } });
  });

  it('still returns the raw value AS-IS on success (unchanged behavior)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ user_id: 'u-1', session_token: 'tok' }],
    }) as any;

    const db = buildDbHelper(baseCtx as any);
    const result = await db.rpc('register_and_login', {});

    expect(result).toEqual([{ user_id: 'u-1', session_token: 'tok' }]);
  });

  it('select still throws on failure (contract unchanged for non-rpc methods)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as any;

    const db = buildDbHelper(baseCtx as any);
    await expect(db.select('users', {})).rejects.toThrow('db.select failed: 500 internal error');
  });
});
