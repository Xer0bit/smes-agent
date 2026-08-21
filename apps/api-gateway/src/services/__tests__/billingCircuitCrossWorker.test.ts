/**
 * The billing circuit breaker must survive crossing a process boundary.
 *
 * Gap register G15: `billingFailedProviders` is a per-process Map and PM2 runs
 * 2 workers, so worker A tripping the circuit did nothing for worker B, which
 * kept calling a provider known to be out of quota for the full 15-minute TTL.
 * Real cost: sustained failed spend through an 11-hour Anthropic outage.
 *
 * Reads stay synchronous by design (see the comment in
 * agentProviderResolution.ts), so propagation is a periodic pull rather than
 * an await on the read path. These tests cover that pull, and the degrade
 * path when Redis is not there at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisStore = new Map<string, string>();
const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = [];
let redisShouldFail = false;

vi.mock('../agentProjectLock.js', () => ({
  redisClient: {
    set: vi.fn(async (key: string, value: string, mode: string, ttl: number) => {
      if (redisShouldFail) throw new Error('redis unreachable');
      setCalls.push({ key, value, mode, ttl });
      redisStore.set(key, value);
      return 'OK';
    }),
    mget: vi.fn(async (...keys: string[]) => {
      if (redisShouldFail) throw new Error('redis unreachable');
      return keys.map((k) => redisStore.get(k) ?? null);
    }),
  },
}));

const PREFIX = 'ecg:billing-circuit:';

async function freshModule() {
  vi.resetModules();
  return import('../agentProviderResolution.js');
}

beforeEach(() => {
  redisStore.clear();
  setCalls.length = 0;
  redisShouldFail = false;
});

describe('billing circuit breaker, cross-worker', () => {
  it('publishes a trip to redis with a self-expiring TTL', async () => {
    const mod = await freshModule();
    mod.tripBillingCircuit('anthropic');
    // tripBillingCircuit is deliberately fire-and-forget; let its microtask run.
    await vi.waitFor(() => expect(setCalls.length).toBe(1));

    expect(setCalls[0].key).toBe(`${PREFIX}anthropic`);
    expect(setCalls[0].mode).toBe('PX');
    expect(setCalls[0].ttl).toBe(15 * 60 * 1000);
    // Local view is open immediately, without waiting on redis.
    expect(mod.isBillingCircuitOpen('anthropic')).toBe(true);
  });

  it("a second worker learns about the first worker's trip on sync", async () => {
    // Worker A trips.
    const workerA = await freshModule();
    workerA.tripBillingCircuit('gemini');
    await vi.waitFor(() => expect(redisStore.size).toBe(1));

    // Worker B is a separate process: fresh module, empty local Map.
    const workerB = await freshModule();
    expect(workerB.isBillingCircuitOpen('gemini')).toBe(false);

    await workerB.syncBillingCircuitFromPeers(['gemini']);
    expect(workerB.isBillingCircuitOpen('gemini')).toBe(true);
  });

  it('a peer entry that has already expired does not reopen the circuit', async () => {
    redisStore.set(`${PREFIX}zai`, String(Date.now() - 1000));
    const mod = await freshModule();

    await mod.syncBillingCircuitFromPeers(['zai']);
    expect(mod.isBillingCircuitOpen('zai')).toBe(false);
  });

  // Asserted through behavior at a controlled clock rather than by reading the
  // Map directly: the resetAt values are module-private, and the thing that
  // actually matters is whether the circuit still reads open once the shorter
  // of the two windows has passed.
  it('sync never shortens a longer local trip', async () => {
    vi.useFakeTimers();
    try {
      const mod = await freshModule();
      mod.tripBillingCircuit('openai'); // local window: now + 15min
      await vi.waitFor(() => expect(redisStore.size).toBe(1));

      // A peer wrote a trip expiring in 1s -- much sooner than the local one.
      redisStore.set(`${PREFIX}openai`, String(Date.now() + 1_000));
      await mod.syncBillingCircuitFromPeers(['openai']);

      // Past the peer's expiry, well short of the local one. If sync had
      // overwritten with the peer's earlier value, this would now read closed
      // and the provider would get hammered again 14 minutes early.
      vi.setSystemTime(Date.now() + 5_000);
      expect(mod.isBillingCircuitOpen('openai')).toBe(true);

      // Past the local window too -- now it must genuinely close.
      vi.setSystemTime(Date.now() + 15 * 60 * 1000);
      expect(mod.isBillingCircuitOpen('openai')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a longer peer trip does extend a shorter local one', async () => {
    const mod = await freshModule();
    const farFuture = Date.now() + 60 * 60 * 1000;
    redisStore.set(`${PREFIX}anthropic`, String(farFuture));

    await mod.syncBillingCircuitFromPeers(['anthropic']);
    expect(mod.isBillingCircuitOpen('anthropic')).toBe(true);
  });

  it('degrades to the old per-process behavior when redis is unreachable', async () => {
    redisShouldFail = true;
    const mod = await freshModule();

    // Neither call throws, and the local circuit still works.
    expect(() => mod.tripBillingCircuit('deepseek')).not.toThrow();
    await expect(mod.syncBillingCircuitFromPeers(['deepseek'])).resolves.toBeUndefined();
    expect(mod.isBillingCircuitOpen('deepseek')).toBe(true);
  });
});
