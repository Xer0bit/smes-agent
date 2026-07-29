import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import RunsPage from './RunsPage';
import { ecgApi } from '../lib/ecgClient';

// jsdom doesn't evaluate CSS media queries, so both the desktop table
// (hidden md:block) and the mobile card list (md:hidden) render at once in
// tests -- every query below is scoped to one tree via `within` rather than
// relying on only one being "visible".
vi.mock('../lib/ecgClient', () => ({
  ecgApi: {
    runs: {
      list: vi.fn(),
      get: vi.fn(),
      approve: vi.fn(),
      flag: vi.fn(),
    },
  },
}));

const listMock = ecgApi.runs.list as ReturnType<typeof vi.fn>;
const getMock = ecgApi.runs.get as ReturnType<typeof vi.fn>;

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
});

function desktopTable() {
  return screen.getByRole('table');
}

describe('RunsPage — row expansion (T3)', () => {
  // Regression check: row expansion used to be gated on `error &&` --
  // widened in T3 so any status (not just failed runs) can be inspected.
  test('a successful run row expands on click, not just errored ones', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-1', agentName: 'Agent A', status: 'success', startedAt: '2026-01-01T00:00:00Z' }],
    });
    getMock.mockResolvedValue({ run: { id: 'run-1', status: 'success' }, post: { platform: 'linkedin', content: 'Posted this' } });

    render(<RunsPage />);
    const table = await within(await screen.findByRole('table')).findByText('Agent A');
    fireEvent.click(table.closest('tr')!);

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('run-1'));
    expect(await within(desktopTable()).findByText('Posted this')).toBeInTheDocument();
  });

  test('clicking an open row again collapses it', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-1', agentName: 'Agent A', status: 'success', startedAt: '2026-01-01T00:00:00Z' }],
    });
    getMock.mockResolvedValue({ run: { id: 'run-1', status: 'success' }, post: null });

    render(<RunsPage />);
    const cell = await within(await screen.findByRole('table')).findByText('Agent A');
    const row = cell.closest('tr')!;
    fireEvent.click(row);
    await within(desktopTable()).findByText('This run produced no output.');
    fireEvent.click(row);
    await waitFor(() => expect(within(desktopTable()).queryByText('This run produced no output.')).not.toBeInTheDocument());
  });
});

describe('RunsPage — Needs-review filter default (T4)', () => {
  test('defaults to Needs review and hides reviewed/flagged runs', async () => {
    listMock.mockResolvedValue({
      runs: [
        { id: 'run-unreviewed', agentName: 'Unreviewed Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z' },
        { id: 'run-reviewed', agentName: 'Reviewed Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z', reviewedAt: '2026-01-02T00:00:00Z' },
        { id: 'run-flagged', agentName: 'Flagged Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z', flagged: true },
      ],
    });

    render(<RunsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Unreviewed Agent')).toBeInTheDocument();
    expect(within(table).queryByText('Reviewed Agent')).not.toBeInTheDocument();
    expect(within(table).queryByText('Flagged Agent')).not.toBeInTheDocument();
  });

  test('toggling to All shows every run regardless of review state', async () => {
    listMock.mockResolvedValue({
      runs: [
        { id: 'run-unreviewed', agentName: 'Unreviewed Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z' },
        { id: 'run-reviewed', agentName: 'Reviewed Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z', reviewedAt: '2026-01-02T00:00:00Z' },
      ],
    });

    render(<RunsPage />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByText('All'));

    const table = screen.getByRole('table');
    expect(within(table).getByText('Unreviewed Agent')).toBeInTheDocument();
    expect(within(table).getByText('Reviewed Agent')).toBeInTheDocument();
  });

  test('shows a dedicated empty state when everything has been reviewed', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-reviewed', agentName: 'Reviewed Agent', status: 'success', startedAt: '2026-01-01T00:00:00Z', reviewedAt: '2026-01-02T00:00:00Z' }],
    });

    render(<RunsPage />);
    expect(await screen.findByText('Nothing needs review')).toBeInTheDocument();
  });
});

describe('RunsPage — mobile card layout (T5)', () => {
  test('renders the same run as both a table row and a stacked card, sharing RunReviewContent', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-1', agentName: 'Agent A', status: 'success', startedAt: '2026-01-01T00:00:00Z' }],
    });
    getMock.mockResolvedValue({ run: { id: 'run-1', status: 'success' }, post: { platform: 'linkedin', content: 'Posted this' } });

    const { container } = render(<RunsPage />);
    await screen.findByRole('table');

    // Two independent render trees for the same data (Tailwind's
    // hidden/md:hidden pair does the actual show/hide at runtime).
    const mobileList = container.querySelector('.md\\:hidden')!;
    expect(mobileList).toBeTruthy();
    const cardButton = within(mobileList as HTMLElement).getByText('Agent A').closest('button')!;
    expect(cardButton).toHaveStyle({ minHeight: '44px' });

    fireEvent.click(cardButton);
    expect(await within(mobileList as HTMLElement).findByText('Posted this')).toBeInTheDocument();
  });
});

describe('RunsPage — keyboard/a11y for row expansion (T6)', () => {
  test('desktop row is tab-focusable and exposes aria-expanded', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-1', agentName: 'Agent A', status: 'success', startedAt: '2026-01-01T00:00:00Z' }],
    });
    getMock.mockResolvedValue({ run: { id: 'run-1', status: 'success' }, post: null });

    render(<RunsPage />);
    const cell = await within(await screen.findByRole('table')).findByText('Agent A');
    const row = cell.closest('tr')!;
    expect(row).toHaveAttribute('tabIndex', '0');
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('Enter expands the row and Space toggles it closed again', async () => {
    listMock.mockResolvedValue({
      runs: [{ id: 'run-1', agentName: 'Agent A', status: 'success', startedAt: '2026-01-01T00:00:00Z' }],
    });
    getMock.mockResolvedValue({ run: { id: 'run-1', status: 'success' }, post: null });

    render(<RunsPage />);
    const cell = await within(await screen.findByRole('table')).findByText('Agent A');
    const row = cell.closest('tr')!;

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    await within(desktopTable()).findByText('This run produced no output.');

    fireEvent.keyDown(row, { key: ' ' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(within(desktopTable()).queryByText('This run produced no output.')).not.toBeInTheDocument());
  });
});
