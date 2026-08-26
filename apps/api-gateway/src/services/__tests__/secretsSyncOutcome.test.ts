/**
 * Retry only what a retry can fix.
 *
 * The failure this guards against is not "no retries" -- it is retrying an
 * answer that will never change. On 2026-08-24 the file push retried a 401
 * three times at 120s each, ran the agent into AGENT_TIMEOUT_MS, and the
 * timeout salvage reverted the run's work. A config fault became lost work
 * because the retry rule could not tell "try again" from "no".
 *
 * So the tests that matter most are the ones asserting we DON'T retry.
 */
import { describe, it, expect } from 'vitest';
import { isRetryableSyncStatus, readSecretsWrittenCount } from '../secretsSyncOutcome.js';

describe('what must NOT be retried', () => {
  it('401 — the exact status that cost a run', () => {
    expect(isRetryableSyncStatus(401)).toBe(false);
  });

  it('every other definitive client error', () => {
    for (const s of [400, 403, 404, 409, 413, 422]) {
      expect({ status: s, retry: isRetryableSyncStatus(s) }).toEqual({ status: s, retry: false });
    }
  });

  it('200 is not a failure to retry in the first place', () => {
    expect(isRetryableSyncStatus(200)).toBe(false);
  });
});

describe('what must be retried', () => {
  it('status 0 — no HTTP response at all, the transient-blip case', () => {
    expect(isRetryableSyncStatus(0)).toBe(true);
  });

  it('server errors, across the range', () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect({ status: s, retry: isRetryableSyncStatus(s) }).toEqual({ status: s, retry: true });
    }
  });

  it('408 and 429 — 4xx that explicitly mean try again', () => {
    // These are the deliberate exceptions to "4xx is definitive". Without
    // them, a preview-service rate limit would drop the credentials silently.
    expect(isRetryableSyncStatus(408)).toBe(true);
    expect(isRetryableSyncStatus(429)).toBe(true);
  });

  it('does not treat 6xx or negatives as server errors', () => {
    expect(isRetryableSyncStatus(600)).toBe(false);
    expect(isRetryableSyncStatus(-1)).toBe(false);
  });
});

describe('reading the count preview-service already reports', () => {
  it('reads a real response body', () => {
    expect(readSecretsWrittenCount('{"success":true,"secretsWritten":6,"restarted":true}')).toBe(6);
  });

  it('distinguishes "wrote zero" from "did not report"', () => {
    // Zero written is a real, actionable answer: .env.local is a full replace,
    // so a zero-key write empties it. It must not collapse to null.
    expect(readSecretsWrittenCount('{"success":true,"secretsWritten":0}')).toBe(0);
    expect(readSecretsWrittenCount('{"success":true}')).toBeNull();
  });

  it('returns null rather than throwing on a non-JSON body', () => {
    // A 502 from nginx is an HTML page, not JSON.
    expect(readSecretsWrittenCount('<html>502 Bad Gateway</html>')).toBeNull();
    expect(readSecretsWrittenCount('')).toBeNull();
  });

  it('rejects a non-numeric or non-finite count', () => {
    expect(readSecretsWrittenCount('{"secretsWritten":"6"}')).toBeNull();
    expect(readSecretsWrittenCount('{"secretsWritten":null}')).toBeNull();
    expect(readSecretsWrittenCount('[1,2,3]')).toBeNull();
  });
});

describe('the short-write case this exists to catch', () => {
  it('a 200 that wrote fewer keys than sent is detectable', () => {
    const sent = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_DB_API_URL',
                  'VITE_DB_ANON_KEY', 'VITE_DB_SCHEMA', 'VITE_FUNCTIONS_API_URL'];
    const written = readSecretsWrittenCount('{"success":true,"secretsWritten":2,"restarted":true}');
    expect(written).toBe(2);
    expect(written !== sent.length).toBe(true);
  });

  it('a complete write reports no mismatch', () => {
    expect(readSecretsWrittenCount('{"success":true,"secretsWritten":6}')).toBe(6);
  });
});
