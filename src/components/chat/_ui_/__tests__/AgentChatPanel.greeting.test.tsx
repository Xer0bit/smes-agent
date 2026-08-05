import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Real bug report (2026-08-04): user sees "EcomGear Agent" rendered twice in
// the welcome banner. This test renders the actual component (guest mode,
// so the message-history effect short-circuits to just the synthetic
// greeting with zero network calls) and asserts the text appears exactly
// once -- catches both the img alt-text-doubling failure mode and any
// future duplicate-render regression of the greeting message itself.

vi.mock('@/integrations/supabase/client', () => ({
  lovableCloud: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('@/eCG/UserPrompt/messageService', () => ({
  messageService: { loadRecentMessages: vi.fn(), loadMessagesBefore: vi.fn() },
}));
vi.mock('@/eCG/UserPrompt/agentStreamService', () => ({
  streamAgentGeneration: vi.fn(),
}));
vi.mock('@/contexts/UsageContext', () => ({
  useUsage: () => ({
    refreshUsage: vi.fn(),
    isWithinLimit: () => true,
    applyUsageDelta: vi.fn(),
  }),
}));

import { AgentChatPanel } from '../AgentChatPanel';

describe('AgentChatPanel greeting banner', () => {
  it('renders "EcomGear Agent" exactly once', () => {
    render(
      <AgentChatPanel
        projectId="test-project"
        userId="guest:test-user"
      />,
    );

    expect(screen.getAllByText('EcomGear Agent')).toHaveLength(1);
  });
});
