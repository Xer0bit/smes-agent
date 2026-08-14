import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Bug: a run where the browser smoke check confirms the rendered page is
// broken and repair can't fix it still keeps the agent's file writes (Gap
// G2   reverting is worse than a false positive). `ghostRun` only checks
// whether files were written, so it stayed false and the frontend showed an
// unqualified "App updated." success toast in the exact run where the
// platform's own check just confirmed the page is broken. This asserts the
// toast is held back for that case, and unchanged for a genuinely healthy run.

vi.mock('@/integrations/supabase/client', () => ({
  lovableCloud: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('@/eCG/UserPrompt/messageService', () => ({
  messageService: { loadRecentMessages: vi.fn(), loadMessagesBefore: vi.fn() },
}));
vi.mock('@/contexts/UsageContext', () => ({
  useUsage: () => ({
    refreshUsage: vi.fn().mockResolvedValue(undefined),
    isWithinLimit: () => true,
    applyUsageDelta: vi.fn(),
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('@/eCG/UserPrompt/agentStreamService', () => ({
  streamAgentGeneration: vi.fn(),
}));

import { streamAgentGeneration } from '@/eCG/UserPrompt/agentStreamService';
import { AgentChatPanel } from '../AgentChatPanel';

const baseResult = {
  mode: 'build' as const,
  filesToWrite: [{ path: 'src/App.tsx', content: 'x', type: 'other' as const, operation: 'create' as const }],
  filesToDelete: [] as string[],
  renames: [],
  dependencies: [],
  summary: 'Updated the app',
  tokensUsed: 10,
  ghostRun: false,
};

async function runGeneration(doneExtra: Record<string, unknown>, repairFailedErrors?: string[]) {
  vi.mocked(streamAgentGeneration).mockImplementation((async ({ callbacks }: any) => {
    callbacks.onOpen?.();
    if (repairFailedErrors) callbacks.onRepairFailed?.(repairFailedErrors);
    callbacks.onDone?.({ ...baseResult, ...doneExtra });
  }) as unknown as typeof streamAgentGeneration);

  render(<AgentChatPanel projectId="test-project" userId="guest:test-user" />);

  const textarea = screen.getByPlaceholderText('Describe your idea or ask me to build something…');
  fireEvent.change(textarea, { target: { value: 'add a button' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });

  await waitFor(() => expect(streamAgentGeneration).toHaveBeenCalled());
}

describe('AgentChatPanel success toast honesty (smoke-failure survived repair)', () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('does not claim "App updated." when files were kept unverified after a smoke check failed and repair could not confirm a fix', async () => {
    await runGeneration({ smokeFailureSurvivedRepair: true }, ['ReferenceError: x is not defined']);

    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalledWith('App updated.'));
  });

  it('still shows "App updated." for a genuinely healthy run', async () => {
    await runGeneration({ smokeFailureSurvivedRepair: false });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('App updated.'));
  });
});
