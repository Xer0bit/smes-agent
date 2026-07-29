import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';
import { ecgApi } from '../lib/ecgClient';

// Layout renders TopBar too, which independently fetches agents/posts/runs/
// connectors/notifications on mount -- the mock needs to cover that whole
// surface, not just what this test file exercises.
vi.mock('../lib/ecgClient', () => ({
  ecgApi: {
    agents: { list: vi.fn().mockResolvedValue({ agents: [] }) },
    posts: { list: vi.fn().mockResolvedValue({ posts: [] }) },
    runs: { list: vi.fn().mockResolvedValue({ runs: [] }) },
    connectors: { list: vi.fn().mockResolvedValue({ connectors: [] }) },
    notifications: {
      list: vi.fn().mockResolvedValue({ notifications: [] }),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
    },
  },
  getActiveAgentId: () => null,
  setActiveAgentId: vi.fn(),
}));

const postsListMock = ecgApi.posts.list as ReturnType<typeof vi.fn>;
const runsListMock = ecgApi.runs.list as ReturnType<typeof vi.fn>;

beforeEach(() => {
  postsListMock.mockReset().mockResolvedValue({ posts: [] });
  runsListMock.mockReset().mockResolvedValue({ runs: [] });
});

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Layout><div /></Layout>
    </MemoryRouter>,
  );
}

describe('Layout — Run History nav (T9)', () => {
  test('Run History has a permanent sidebar slot (no longer hidden)', async () => {
    renderLayout();
    expect(await screen.findByText('Run History')).toBeInTheDocument();
  });

  test('shows a badge with the unreviewed-run count', async () => {
    runsListMock.mockResolvedValue({
      runs: [
        { id: 'r1', status: 'success' },
        { id: 'r2', status: 'success', reviewedAt: '2026-01-02T00:00:00Z' },
        { id: 'r3', status: 'success', flagged: true },
      ],
    });
    renderLayout();
    const link = (await screen.findByText('Run History')).closest('a')!;
    expect(await within(link).findByText('1')).toBeInTheDocument();
  });

  test('no badge when nothing needs review', async () => {
    runsListMock.mockResolvedValue({
      runs: [{ id: 'r1', status: 'success', reviewedAt: '2026-01-02T00:00:00Z' }],
    });
    renderLayout();
    const link = (await screen.findByText('Run History')).closest('a')!;
    // Give the pending-count fetch a tick to resolve before asserting absence.
    await new Promise(r => setTimeout(r, 0));
    expect(within(link).queryByText('1')).not.toBeInTheDocument();
  });
});
