import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AgentDetailPage from './AgentDetailPage';
import { ecgApi } from '../lib/ecgClient';

vi.mock('../lib/ecgClient', () => ({
  ecgApi: {
    agents: { get: vi.fn(), run: vi.fn(), update: vi.fn() },
  },
}));

const getMock = ecgApi.agents.get as ReturnType<typeof vi.fn>;

beforeEach(() => { getMock.mockReset(); });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agents/agent-1']}>
      <Routes>
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AgentDetailPage — Recent runs reviewed indicator (T7)', () => {
  test('shows a "Needs review" dot for an unreviewed, unflagged run', async () => {
    getMock.mockResolvedValue({
      agent: { id: 'agent-1', name: 'Agent A', status: 'active', lastRunAt: null },
      recentRuns: [{ id: 'r1', status: 'success', startedAt: '2026-01-01T00:00:00Z', durationMs: 1000, cost: 0.01, tokensIn: 10, tokensOut: 5 }],
      schedulers: [],
    });
    renderPage();
    expect(await screen.findByTitle('Needs review')).toBeInTheDocument();
  });

  test('shows a "Reviewed" dot once reviewedAt is set', async () => {
    getMock.mockResolvedValue({
      agent: { id: 'agent-1', name: 'Agent A', status: 'active', lastRunAt: null },
      recentRuns: [{ id: 'r1', status: 'success', startedAt: '2026-01-01T00:00:00Z', durationMs: 1000, cost: 0.01, tokensIn: 10, tokensOut: 5, reviewedAt: '2026-01-02T00:00:00Z' }],
      schedulers: [],
    });
    renderPage();
    expect(await screen.findByTitle('Reviewed')).toBeInTheDocument();
  });

  test('shows a "Flagged" dot once flagged is true', async () => {
    getMock.mockResolvedValue({
      agent: { id: 'agent-1', name: 'Agent A', status: 'active', lastRunAt: null },
      recentRuns: [{ id: 'r1', status: 'success', startedAt: '2026-01-01T00:00:00Z', durationMs: 1000, cost: 0.01, tokensIn: 10, tokensOut: 5, flagged: true }],
      schedulers: [],
    });
    renderPage();
    expect(await screen.findByTitle('Flagged')).toBeInTheDocument();
  });
});
