/**
 * Assistant messages were persisted only by the browser: a grep for
 * from('messages') over the server found no insert or upsert. A run whose tab
 * closed completed, wrote files, and left its answer in no store -- made more
 * likely, not less, by runs now outliving their connection.
 */
import { describe, expect, it } from 'vitest';
import { assistantMessageId } from '../assistantMessagePersist.js';

const RUN_A = '7d127b41-3d49-4bd9-9e61-0c8c6c10bcac';
const RUN_B = '5f12fdef-95bd-465d-aa80-1eafd77edf77';

describe('assistantMessageId', () => {
  it('is stable for a run, so every save targets the same row', () => {
    // This is what makes the write idempotent: stream end, retry and reconnect
    // all upsert one row instead of inserting three (the triplicate bug).
    expect(assistantMessageId(RUN_A)).toBe(assistantMessageId(RUN_A));
  });

  it('differs per run', () => {
    expect(assistantMessageId(RUN_A)).not.toBe(assistantMessageId(RUN_B));
  });

  it('is a well-formed RFC-4122 uuid, since messages.id is a uuid column', () => {
    expect(assistantMessageId(RUN_A)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is not the run id itself, so it cannot collide with another row keyed by it', () => {
    expect(assistantMessageId(RUN_A)).not.toBe(RUN_A);
  });
});
