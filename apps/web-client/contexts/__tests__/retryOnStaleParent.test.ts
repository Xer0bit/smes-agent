/**
 * Regression test for the 2026-08-19 fix: a single stale_parent rebase-retry
 * lost the race whenever another writer (an active agent run) kept advancing
 * the revision head faster than one retry could catch up -- confirmed live on
 * project dfe41091, where a browser tab's autosave and a concurrent agent run
 * traded stale_parent rejections back and forth until the save just gave up
 * silently. retryOnStaleParent bounds the retries with backoff instead of
 * failing outright the moment two writers overlap.
 */
import { describe, it, expect, vi } from 'vitest';
import { retryOnStaleParent } from '../WorkspaceContext';

class StaleParentError extends Error {}
const isStaleParentError = (err: unknown) => err instanceof StaleParentError;

describe('retryOnStaleParent', () => {
  it('succeeds immediately when the first attempt lands', async () => {
    const attemptSave = vi.fn().mockResolvedValue('rev-1');
    const rebase = vi.fn();
    const result = await retryOnStaleParent(attemptSave, isStaleParentError, rebase, { sleep: async () => {} });
    expect(result).toBe('rev-1');
    expect(rebase).not.toHaveBeenCalled();
  });

  it('rebases and retries through a burst of stale_parent rejections until it lands', async () => {
    const attemptSave = vi.fn()
      .mockRejectedValueOnce(new StaleParentError())
      .mockRejectedValueOnce(new StaleParentError())
      .mockRejectedValueOnce(new StaleParentError())
      .mockResolvedValueOnce('rev-final');
    const rebase = vi.fn().mockResolvedValue(undefined);

    const result = await retryOnStaleParent(attemptSave, isStaleParentError, rebase, { maxRetries: 5, sleep: async () => {} });

    expect(result).toBe('rev-final');
    expect(attemptSave).toHaveBeenCalledTimes(4);
    expect(rebase).toHaveBeenCalledTimes(3);
  });

  it('gives up and throws once maxRetries is exhausted', async () => {
    const attemptSave = vi.fn().mockRejectedValue(new StaleParentError());
    const rebase = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryOnStaleParent(attemptSave, isStaleParentError, rebase, { maxRetries: 2, sleep: async () => {} }),
    ).rejects.toThrow(StaleParentError);
    expect(attemptSave).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(rebase).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-stale_parent error', async () => {
    const otherError = new Error('network down');
    const attemptSave = vi.fn().mockRejectedValue(otherError);
    const rebase = vi.fn();

    await expect(
      retryOnStaleParent(attemptSave, isStaleParentError, rebase, { sleep: async () => {} }),
    ).rejects.toThrow('network down');
    expect(attemptSave).toHaveBeenCalledTimes(1);
    expect(rebase).not.toHaveBeenCalled();
  });
});
