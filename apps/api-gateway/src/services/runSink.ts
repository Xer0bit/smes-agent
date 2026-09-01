/**
 * A run's output boundary.
 *
 * WHAT THIS CHANGES. An agent run used to write its SSE frames straight into
 * the HTTP response that started it, which made the run's progress a property
 * of one TCP connection: a client that navigated away left the run writing
 * into a dead socket, and the route compensated with a "wait 5 minutes for a
 * reconnect, then abort" timer. The run now writes here instead. Connections
 * subscribe. Nobody listening is a normal state, not an error, and not a
 * reason to stop working.
 *
 * The sink keeps a bounded replay buffer so a connection that attaches late --
 * a rejoin, a second tab, the other PM2 worker via the Redis mirror -- can be
 * caught up before it starts following live, exactly as `relayRunStream` does
 * cross-process.
 */
import { EventEmitter } from 'node:events';

/** Bound on retained frames per run, so one long generation cannot grow memory without limit. */
export const SSE_BUFFER_CAP = 2000;

export interface RunSink {
  /** Frames retained for replay to a late subscriber, oldest first. */
  readonly buffer: string[];
  /** 'chunk' carries one SSE frame; 'end' fires once when the run is over. */
  readonly bus: EventEmitter;
  /** Format and publish one SSE event. */
  emit: (event: string, data: unknown) => void;
  /** Publish a pre-formatted frame. `replayable: false` skips the buffer. */
  emitRaw: (frame: string, replayable?: boolean) => void;
}

export function formatSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param onMirror best-effort cross-worker mirror, called per frame. It must
 *   never throw or block: a run cannot be allowed to fail because a mirror did.
 */
export function createRunSink(onMirror?: (frame: string) => void): RunSink {
  const bus = new EventEmitter();
  // One run can legitimately have several readers (reconnects, extra tabs)
  // without any of them being a leak.
  bus.setMaxListeners(50);
  const buffer: string[] = [];

  const emitRaw = (frame: string, replayable = true) => {
    // Heartbeats pass replayable=false. They are transport keepalives that mean
    // something only to a socket open right now, so buffering them would spend
    // the cap on frames no rejoining client can use.
    if (replayable && buffer.length < SSE_BUFFER_CAP) buffer.push(frame);
    bus.emit('chunk', frame);
    // Swallowed on purpose: the mirror is an optimisation for readers on another
    // worker. Letting it throw here would put a Redis outage on the run's
    // critical path, which is the opposite of what the mirror is for.
    try { onMirror?.(frame); } catch { /* best-effort */ }
  };

  return {
    buffer,
    bus,
    emitRaw,
    emit: (event, data) => emitRaw(formatSseFrame(event, data)),
  };
}
