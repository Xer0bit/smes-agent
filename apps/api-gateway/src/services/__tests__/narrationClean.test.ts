/**
 * Cleaning an LLM-written status line.
 *
 * Reported 2026-08-22: the live status line only ever showed generic text like
 * "Sending files to the preview". Those are the HARDCODED fallbacks. Every
 * status the model actually wrote was being mangled, because the cleaner ran
 * `.replace(/ /g, '-')` on a plain space (byte 0x20) and turned
 * "Reading the login file" into "Reading-the-login-file".
 *
 * The intent was clearly to normalise dash characters; a dash appears to have
 * been flattened to a space by an earlier encoding pass, silently converting a
 * dash-normaliser into a word-joiner. Nothing failed, so nothing surfaced it.
 */
import { describe, it, expect } from 'vitest';
import { __test_cleanLlmText as cleanLlmText } from '../narration.service.js';

describe('status line cleaning', () => {
  it('keeps spaces between words -- the reported bug', () => {
    expect(cleanLlmText('Reading the login file')).toBe('Reading the login file');
    expect(cleanLlmText('Checking build errors')).toBe('Checking build errors');
  });

  it('strips wrapping quotes and a trailing period', () => {
    expect(cleanLlmText('"Wiring up the router."')).toBe('Wiring up the router');
  });

  it('normalises dash characters, which is what the replace was for', () => {
    expect(cleanLlmText('Fixing the header — again')).toBe('Fixing the header - again');
    expect(cleanLlmText('Range – two')).toBe('Range - two');
  });

  it('collapses newlines and runs of whitespace to keep it one line', () => {
    expect(cleanLlmText('Updating\n  the   header')).toBe('Updating the header');
  });

  it('rejects empty or too-short output so the caller uses its fallback', () => {
    expect(cleanLlmText('')).toBeNull();
    expect(cleanLlmText('   ')).toBeNull();
    expect(cleanLlmText('ok')).toBeNull();
  });

  it('truncates an over-long line', () => {
    const out = cleanLlmText('x'.repeat(200));
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/\.\.\.$/);
  });
});
