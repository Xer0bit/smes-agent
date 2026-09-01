/**
 * The sink is what makes a run outlive its connection: if replay drops frames a
 * rejoining client renders a truncated answer, and if it retains the wrong ones
 * the cap is spent on keepalives. These assert that contract directly.
 */
import { describe, expect, it } from 'vitest';
import { createRunSink, formatSseFrame, SSE_BUFFER_CAP } from '../runSink.js';

/** Stands in for an HTTP connection: replay the backlog, then follow live. */
function attach(sink: ReturnType<typeof createRunSink>): string[] {
  const seen = [...sink.buffer];
  sink.bus.on('chunk', (frame: string) => seen.push(frame));
  return seen;
}

describe('createRunSink', () => {
  it('a connection that attaches late still sees the whole run', () => {
    const sink = createRunSink();
    sink.emit('start', { model: 'x' });
    sink.emit('text-delta', { text: 'hello' });

    const late = attach(sink); // joins mid-run

    sink.emit('done', { summary: 'ok' });

    expect(late).toEqual([
      formatSseFrame('start', { model: 'x' }),
      formatSseFrame('text-delta', { text: 'hello' }),
      formatSseFrame('done', { summary: 'ok' }),
    ]);
  });

  it('keeps producing with nobody attached, and mirrors every frame', () => {
    const mirrored: string[] = [];
    const sink = createRunSink((f) => mirrored.push(f));

    sink.emit('text-delta', { text: 'a' });
    sink.emit('text-delta', { text: 'b' });

    expect(sink.buffer).toHaveLength(2);
    expect(mirrored).toHaveLength(2);
  });

  it('heartbeats reach live readers but never occupy the replay buffer', () => {
    const sink = createRunSink();
    const live = attach(sink);

    sink.emitRaw(': heartbeat\n\n', false);
    sink.emit('text-delta', { text: 'real' });

    expect(live).toHaveLength(2);
    expect(sink.buffer).toEqual([formatSseFrame('text-delta', { text: 'real' })]);
  });

  it('caps the replay buffer but keeps streaming live past the cap', () => {
    const sink = createRunSink();
    const live = attach(sink);

    for (let i = 0; i < SSE_BUFFER_CAP + 10; i++) sink.emit('text-delta', { i });

    expect(sink.buffer).toHaveLength(SSE_BUFFER_CAP);
    expect(live).toHaveLength(SSE_BUFFER_CAP + 10);
  });

  it('a mirror that throws cannot take the run down', () => {
    const sink = createRunSink(() => { throw new Error('redis is down'); });
    const live = attach(sink);

    expect(() => sink.emit('text-delta', { text: 'a' })).not.toThrow();
    expect(live).toHaveLength(1);
    expect(sink.buffer).toHaveLength(1);
  });
});
