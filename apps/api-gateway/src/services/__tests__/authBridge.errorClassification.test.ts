/**
 * Classifying WHY a Supabase mirror failed.
 *
 * Two real incidents motivate this:
 *
 * 1. The duplicate-email check was `message.includes('already been
 *    registered')` -- matching on prose GoTrue has reworded across versions.
 *    A miss sends a recoverable orphaned-mirror login down the throw path and
 *    the user sees a hard login failure. There are live accounts in exactly
 *    that state (auth.users row, no profiles row), so this path is reachable.
 *
 * 2. 2026-08-22: a local Supabase auth container died (stale docker network),
 *    Kong kept routing to nothing, and every admin call returned
 *    500 "An unexpected error occurred". Login reported the same generic
 *    "session setup failed" as a genuinely broken account, which cost a long
 *    log dig. An outage must be distinguishable from an account problem.
 */
import { describe, it, expect, vi } from 'vitest';

// authBridge.service.ts -> config/database.js throws at module load without
// SUPABASE_*; the classifiers under test are pure and touch none of it.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { isDuplicateEmailError, isAuthServiceUnavailable } from '../authBridge.service.js';

describe('isDuplicateEmailError', () => {
  it('matches the stable error codes regardless of wording', () => {
    expect(isDuplicateEmailError({ code: 'email_exists', status: 422 })).toBe(true);
    expect(isDuplicateEmailError({ code: 'user_already_exists', status: 400 })).toBe(true);
  });

  it('matches known GoTrue wordings as a fallback for older servers', () => {
    for (const message of [
      'A user with this email address has already been registered',
      'User already registered',
      'user already exists',
      'Email address is already in use',
    ]) {
      expect(isDuplicateEmailError({ message, status: 422 }), message).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isDuplicateEmailError({ message: 'ALREADY BEEN REGISTERED', status: 400 })).toBe(true);
  });

  // The incident guard: an outage must never be read as a duplicate, or the
  // code would go hunting for an existing user that has nothing to do with
  // the actual failure.
  it('never treats a 5xx as a duplicate, even if the text would match', () => {
    expect(isDuplicateEmailError({ status: 500, message: 'already been registered' })).toBe(false);
    expect(isDuplicateEmailError({ status: 503, message: 'An unexpected error occurred' })).toBe(false);
  });

  it('is false for unrelated errors and for nothing at all', () => {
    expect(isDuplicateEmailError({ message: 'Password should be at least 6 characters', status: 422 })).toBe(false);
    expect(isDuplicateEmailError(null)).toBe(false);
    expect(isDuplicateEmailError(undefined)).toBe(false);
    expect(isDuplicateEmailError({})).toBe(false);
  });
});

describe('isAuthServiceUnavailable', () => {
  // The exact shape returned by Kong when the auth container is dead.
  it('recognises the dead-auth-container signature from 2026-08-22', () => {
    expect(isAuthServiceUnavailable({ status: 500, message: 'An unexpected error occurred' })).toBe(true);
  });

  it('treats any 5xx as unavailable', () => {
    expect(isAuthServiceUnavailable({ status: 502, message: 'Bad Gateway' })).toBe(true);
    expect(isAuthServiceUnavailable({ status: 503 })).toBe(true);
  });

  it('recognises transport-level failures with no status at all', () => {
    for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:54321', 'Service Unavailable']) {
      expect(isAuthServiceUnavailable({ message }), message).toBe(true);
    }
  });

  it('is false for real 4xx account errors', () => {
    expect(isAuthServiceUnavailable({ status: 422, message: 'A user with this email address has already been registered' })).toBe(false);
    expect(isAuthServiceUnavailable({ status: 400, message: 'Invalid login credentials' })).toBe(false);
    expect(isAuthServiceUnavailable(null)).toBe(false);
  });

  // The two classifiers must not both claim the same error, or the caller's
  // branch order silently decides behavior.
  it('never overlaps with isDuplicateEmailError', () => {
    const cases = [
      { status: 500, message: 'An unexpected error occurred' },
      { status: 422, message: 'A user with this email address has already been registered' },
      { code: 'email_exists', status: 422 },
      { message: 'fetch failed' },
      { status: 400, message: 'Invalid login credentials' },
    ];
    for (const c of cases) {
      expect(
        isDuplicateEmailError(c) && isAuthServiceUnavailable(c),
        `${JSON.stringify(c)} was classified as both`,
      ).toBe(false);
    }
  });
});
