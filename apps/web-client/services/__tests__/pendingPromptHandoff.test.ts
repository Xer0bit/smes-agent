import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stashPendingPrompt, consumePendingPrompt, type PendingPrompt } from '../pendingPromptHandoff';

// RequireAuth (App.tsx) redirects to /auth on anything but an immediate
// authenticated session check, and that redirect rebuilds the target from
// pathname+search+hash only -- silently dropping router `state`. This is the
// sessionStorage fallback that survives that remount (found 2026-08-16:
// dashboard hero-launch projects ended up with zero messages/agent_runs --
// the initial prompt vanished with no error shown). Real coverage of the new
// logic, not a full Editor.tsx render (3700+ lines, deeply coupled).

describe('pendingPromptHandoff', () => {
  const projectId = 'proj-123';

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a stashed prompt', () => {
    stashPendingPrompt(projectId, { initialPrompt: 'build a landing page' });
    expect(consumePendingPrompt(projectId)).toEqual({ initialPrompt: 'build a landing page' });
  });

  it('round-trips fileContext and attachments', () => {
    const payload: PendingPrompt = {
      initialPrompt: 'build a landing page',
      fileContext: 'extracted PDF text',
      attachments: [{ name: 'logo.png', type: 'image', category: 'image', tempPath: 't/1', publicUrl: 'https://x/1' }],
    };
    stashPendingPrompt(projectId, payload);
    expect(consumePendingPrompt(projectId)).toEqual(payload);
  });

  it('returns null when nothing was stashed for this project', () => {
    expect(consumePendingPrompt(projectId)).toBeNull();
  });

  it('is scoped per project id -- does not leak across projects', () => {
    stashPendingPrompt('proj-a', { initialPrompt: 'prompt for A' });
    expect(consumePendingPrompt('proj-b')).toBeNull();
    expect(consumePendingPrompt('proj-a')).toEqual({ initialPrompt: 'prompt for A' });
  });

  it('removes the entry on consume -- a second read returns null', () => {
    stashPendingPrompt(projectId, { initialPrompt: 'only once' });
    expect(consumePendingPrompt(projectId)).not.toBeNull();
    expect(consumePendingPrompt(projectId)).toBeNull();
  });

  it('treats a corrupt stashed entry as absent instead of throwing', () => {
    sessionStorage.setItem(`ecg_pending_prompt_${projectId}`, '{not valid json');
    expect(() => consumePendingPrompt(projectId)).not.toThrow();
    expect(consumePendingPrompt(projectId)).toBeNull();
  });

  it('treats an entry with neither a prompt nor attachments as absent', () => {
    sessionStorage.setItem(`ecg_pending_prompt_${projectId}`, JSON.stringify({ fileContext: 'stray context' }));
    expect(consumePendingPrompt(projectId)).toBeNull();
  });

  it('keeps an attachment-only handoff -- the dashboard has no prompt box', () => {
    // "New project" on the dashboard creates a bare project: a user who
    // attaches a file there has nothing to type, and dropping the payload for
    // want of a prompt would lose the file on the RequireAuth remount.
    const attachments = [{ name: 'brief.pdf', type: 'application/pdf', category: 'document' as const, tempPath: '/tmp/a' }];
    stashPendingPrompt(projectId, { attachments });
    expect(consumePendingPrompt(projectId)).toEqual({ attachments });
  });

  it('still drops an attachment-only handoff when the array is empty', () => {
    stashPendingPrompt(projectId, { attachments: [] });
    expect(consumePendingPrompt(projectId)).toBeNull();
  });
});
