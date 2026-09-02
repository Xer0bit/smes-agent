import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { perFrame } from '../agentChatHelpers';

/**
 * Streaming used to call setMessages once per SSE chunk. perFrame is the
 * batching that makes the panel paint once per frame instead; these pin the
 * two properties the stream handlers rely on.
 */
describe('perFrame', () => {
  let queued: FrameRequestCallback[];
  beforeEach(() => {
    queued = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queued.push(cb); return queued.length; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { queued[id - 1] = () => {}; });
  });
  afterEach(() => vi.unstubAllGlobals());

  const runFrame = () => { const cbs = queued.splice(0); cbs.forEach((cb) => cb(0)); };

  it('collapses a burst of schedules into one flush per frame', () => {
    const flush = vi.fn();
    const p = perFrame(flush);
    for (let i = 0; i < 50; i++) p.schedule();
    expect(flush).not.toHaveBeenCalled();
    runFrame();
    expect(flush).toHaveBeenCalledTimes(1);
    // a later burst schedules again
    p.schedule();
    runFrame();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('cancel drops a queued flush so a terminal state is never overwritten', () => {
    const flush = vi.fn();
    const p = perFrame(flush);
    p.schedule();
    p.cancel();
    runFrame();
    expect(flush).not.toHaveBeenCalled();
    // and scheduling after a cancel still works
    p.schedule();
    runFrame();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
