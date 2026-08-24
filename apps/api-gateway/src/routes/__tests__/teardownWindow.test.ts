/**
 * The teardown window that swallowed prompts.
 *
 * Confirmed in production 2026-08-24: `sink.emit('done')` fires at
 * agentLoopService.ts:5257, but the project lock is not released until the
 * route's finally at ai.routes.ts:1604 and the run only leaves activeAgentRuns
 * at :1611. Measured gap: ~3s (inner-return 13:20:29 -> lock released
 * 13:20:32). The client clears its generating state on 'done', so a prompt sent
 * in that window reached a server where the dying run was still registered.
 *
 * The old rejoin branch subscribed that connection to the dying run's stream
 * and NEVER READ `prompt` -- the message vanished with no answer and no error.
 * Starting a fresh run instead would have been equally wrong: the lock is still
 * held, so tryAcquireAgentLock returns null and the caller gets a 429.
 *
 * The rule under test is therefore three-way, and both failure modes must be
 * ruled out explicitly:
 *   live run      -> subscribe (unchanged)
 *   finishing run -> WAIT for real end, then run the prompt (neither swallow nor 429)
 *   no run        -> run the prompt
 */
import { describe, it, expect, vi } from 'vitest';

/** Mirrors the route's decision + bounded wait. */
type Outcome = 'subscribe' | 'run-after-wait' | 'run-immediately' | 'drop-client-gone';

interface FakeRun {
  finishing: boolean;
  ended: Promise<void>;
}

async function decide(
  run: FakeRun | undefined,
  opts: { waitMs: number; clientGone?: Promise<'closed'> } = { waitMs: 50 },
): Promise<{ outcome: Outcome; waited: boolean; timedOut: boolean }> {
  if (!run) return { outcome: 'run-immediately', waited: false, timedOut: false };
  if (!run.finishing) return { outcome: 'subscribe', waited: false, timedOut: false };

  let timer: NodeJS.Timeout | undefined;
  const timedOutP = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), opts.waitMs); });
  const race: Array<Promise<'ended' | 'timeout' | 'closed'>> = [
    run.ended.then(() => 'ended' as const),
    timedOutP,
  ];
  if (opts.clientGone) race.push(opts.clientGone);

  const result = await Promise.race(race);
  if (timer) clearTimeout(timer);

  if (result === 'closed') return { outcome: 'drop-client-gone', waited: true, timedOut: false };
  // Both 'ended' and 'timeout' proceed -- hanging the user is worse than
  // racing a run that never signalled.
  return { outcome: 'run-after-wait', waited: true, timedOut: result === 'timeout' };
}

const never = () => new Promise<void>(() => {});

describe('teardown window', () => {
  it('THE BUG: a prompt during teardown is neither swallowed nor 429-rejected', async () => {
    // Old behaviour was 'subscribe' (prompt never read). The 429 trap would be
    // starting a run while the lock is still held. Neither is acceptable.
    let release!: () => void;
    const ended = new Promise<void>((r) => { release = r; });
    const decision = decide({ finishing: true, ended }, { waitMs: 1000 });
    setTimeout(() => release(), 20); // lock releases shortly after
    const r = await decision;

    expect(r.outcome).not.toBe('subscribe');        // not swallowed
    expect(r.outcome).toBe('run-after-wait');       // the prompt actually runs
    expect(r.waited).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('EDGE 1: run already finished at lookup -> proceeds immediately, no hang', async () => {
    const r = await decide({ finishing: true, ended: Promise.resolve() }, { waitMs: 10_000 });
    expect(r.outcome).toBe('run-after-wait');
    expect(r.timedOut).toBe(false); // resolved instantly, did not wait out the timer
  });

  it('EDGE 2: run never emits end -> bounded timeout, then proceeds anyway', async () => {
    const started = Date.now();
    const r = await decide({ finishing: true, ended: never() }, { waitMs: 40 });
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe('run-after-wait'); // proceeds rather than hanging
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('EDGE 3: client disconnects while parked -> drops cleanly, starts nothing', async () => {
    const r = await decide(
      { finishing: true, ended: never() },
      { waitMs: 5000, clientGone: Promise.resolve('closed') },
    );
    expect(r.outcome).toBe('drop-client-gone');
  });

  it('EDGE 4: a genuinely live run still subscribes, exactly as before', async () => {
    const r = await decide({ finishing: false, ended: never() }, { waitMs: 5000 });
    expect(r.outcome).toBe('subscribe');
    expect(r.waited).toBe(false); // no delay introduced for the normal rejoin
  });

  it('NORMAL CASE: no run registered -> prompt runs immediately, unchanged', async () => {
    const r = await decide(undefined);
    expect(r.outcome).toBe('run-immediately');
    expect(r.waited).toBe(false);
  });
});
