/**
 * Cross-worker run stream relay.
 *
 * Three properties carry the whole design and none is obvious from the code:
 *
 * 1. BACKLOG. A subscriber joining mid-run must receive the chunks it missed.
 *    This is the entire reason the broker uses a stream read from id '0' rather
 *    than pub/sub -- a late joiner on pub/sub renders a truncated answer, which
 *    is worse than not attaching at all.
 * 2. A BLOCK TIMEOUT IS NOT AN END. XREAD returns null whenever the block
 *    elapses with nothing new, which happens constantly while the agent thinks
 *    between tool calls. Treating null as end-of-run would cut every remote
 *    viewer off mid-generation.
 * 3. DEGRADE, DON'T HANG. If Redis is unusable the relay must report false so
 *    the caller falls back, rather than leaving a client waiting on a stream
 *    that will never arrive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Scripted XREAD responses, consumed one call at a time. */
let xreadScript: Array<unknown> = [];
let xaddCalls: string[][] = [];
let status = 'ready';
let disconnected = false;
let xreadArgs: unknown[][] = [];

vi.mock('../agentProjectLock.js', () => ({
  redisClient: {
    get status() { return status; },
    xadd: (...args: string[]) => { xaddCalls.push(args); return Promise.resolve('1-0'); },
    expire: () => Promise.resolve(1),
    exists: () => Promise.resolve(1),
    duplicate: () => ({
      xread: (...args: unknown[]) => {
        xreadArgs.push(args);
        return Promise.resolve(xreadScript.length ? xreadScript.shift() : null);
      },
      disconnect: () => { disconnected = true; },
    }),
  },
}));

import { relayRunStream, publishRunChunk, publishRunEnd } from '../runStreamBroker.js';

const entry = (id: string, field: string, value: string): [string, Array<[string, string[]]>] =>
  ['k', [[id, [field, value]]]];

beforeEach(() => { xreadScript = []; xaddCalls = []; xreadArgs = []; status = 'ready'; disconnected = false; });

describe('run stream relay', () => {
  it('replays backlog to a subscriber that joined mid-run, then ends', async () => {
    xreadScript = [
      [entry('1-0', 'c', 'chunk-one')],
      [entry('2-0', 'c', 'chunk-two')],
      [entry('3-0', 'end', '1')],
    ];
    const seen: string[] = [];
    let ended = false;
    const ok = await relayRunStream('p1', 'r1',
      { onChunk: (c) => seen.push(c), onEnd: () => { ended = true; } },
      new AbortController().signal);
    expect(ok).toBe(true);
    expect(seen).toEqual(['chunk-one', 'chunk-two']);
    expect(ended).toBe(true);
  });

  it('starts reading at id 0, not $, or the backlog is silently lost', async () => {
    // The mock returns scripted entries regardless of the id it is given, so
    // the backlog test above passes either way. This asserts the argument
    // directly: '$' means "only entries added from now on", which would drop
    // everything a late-joining subscriber missed.
    xreadScript = [[entry('1-0', 'end', '1')]];
    await relayRunStream('p1', 'r1', { onChunk: () => {}, onEnd: () => {} }, new AbortController().signal);
    expect(xreadArgs[0]?.[xreadArgs[0].length - 1]).toBe('0');
  });

  it('does not treat a block timeout as end-of-run', async () => {
    // null = the agent is thinking. The relay must keep waiting, not cut off.
    xreadScript = [null, null, [entry('9-0', 'c', 'after-the-pause')], [entry('10-0', 'end', '1')]];
    const seen: string[] = [];
    let ended = false;
    await relayRunStream('p1', 'r1',
      { onChunk: (c) => seen.push(c), onEnd: () => { ended = true; } },
      new AbortController().signal);
    expect(seen).toEqual(['after-the-pause']);
    expect(ended).toBe(true);
  });

  it('stops when the caller aborts, without calling onEnd', async () => {
    const ac = new AbortController();
    xreadScript = [[entry('1-0', 'c', 'x')]];
    let ended = false;
    const ok = await relayRunStream('p1', 'r1',
      { onChunk: () => ac.abort(), onEnd: () => { ended = true; } },
      ac.signal);
    expect(ok).toBe(true);
    // A client that navigated away must not be reported as a completed run.
    expect(ended).toBe(false);
  });

  it('always releases the duplicated connection', async () => {
    // A leaked blocking connection is a slot lost until process restart.
    xreadScript = [[entry('1-0', 'end', '1')]];
    await relayRunStream('p1', 'r1', { onChunk: () => {}, onEnd: () => {} }, new AbortController().signal);
    expect(disconnected).toBe(true);
  });

  it('reports false when Redis is unusable so the caller can fall back', async () => {
    status = 'connecting';
    const ok = await relayRunStream('p1', 'r1', { onChunk: () => {}, onEnd: () => {} }, new AbortController().signal);
    expect(ok).toBe(false);
  });
});

describe('run stream publishing', () => {
  it('bounds retained chunks so one run cannot grow without limit', async () => {
    await publishRunChunk('p1', 'r1', 'hello');
    expect(xaddCalls[0]).toContain('MAXLEN');
    expect(xaddCalls[0]).toContain('hello');
  });

  it('publishes a terminal marker so tailers stop instead of waiting out the TTL', async () => {
    await publishRunEnd('p1', 'r1');
    expect(xaddCalls[0]).toContain('end');
  });

  it('is a silent no-op when Redis is down -- a run must never fail on a mirror write', async () => {
    status = 'end';
    await publishRunChunk('p1', 'r1', 'hello');
    await publishRunEnd('p1', 'r1');
    expect(xaddCalls).toEqual([]);
  });
});
