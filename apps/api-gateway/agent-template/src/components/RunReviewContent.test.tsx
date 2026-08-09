import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RunReviewContent } from './RunReviewContent';
import { ecgApi } from '../lib/ecgClient';

vi.mock('../lib/ecgClient', () => ({
  ecgApi: {
    runs: {
      get: vi.fn(),
      approve: vi.fn(),
      flag: vi.fn(),
    },
  },
}));

const getMock = ecgApi.runs.get as ReturnType<typeof vi.fn>;
const approveMock = ecgApi.runs.approve as ReturnType<typeof vi.fn>;
const flagMock = ecgApi.runs.flag as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getMock.mockReset();
  approveMock.mockReset();
  flagMock.mockReset();
});

describe('RunReviewContent', () => {
  test('shows output when the run produced a post', async () => {
    getMock.mockResolvedValue({
      run: { id: 'r1', status: 'success', cost: 0.02, tokens_in: 100, tokens_out: 50 },
      post: { platform: 'linkedin', content: 'Hello world' },
    });
    render(<RunReviewContent runId="r1" status="success" onReviewed={vi.fn()} />);
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('linkedin')).toBeInTheDocument();
  });

  test('shows the empty state when the run produced no post', async () => {
    getMock.mockResolvedValue({ run: { id: 'r1', status: 'success' }, post: null });
    render(<RunReviewContent runId="r1" status="success" onReviewed={vi.fn()} />);
    expect(await screen.findByText('This run produced no output.')).toBeInTheDocument();
  });

  test('disables actions while the run is still running', async () => {
    getMock.mockResolvedValue({ run: { id: 'r1', status: 'running' }, post: null });
    render(<RunReviewContent runId="r1" status="running" onReviewed={vi.fn()} />);
    await screen.findByText('Run in progress…');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Flag')).not.toBeInTheDocument();
  });

  test('approve calls the API, notifies the parent, and shows Reviewed', async () => {
    getMock.mockResolvedValue({ run: { id: 'r1', status: 'success' }, post: null });
    approveMock.mockResolvedValue({});
    const onReviewed = vi.fn();
    render(<RunReviewContent runId="r1" status="success" onReviewed={onReviewed} />);
    fireEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('r1'));
    expect(onReviewed).toHaveBeenCalledWith({ reviewed: true });
    expect(await screen.findByText('✓ Reviewed')).toBeInTheDocument();
  });

  test('approve failure shows an inline error and re-enables the button', async () => {
    getMock.mockResolvedValue({ run: { id: 'r1', status: 'success' }, post: null });
    approveMock.mockRejectedValue(new Error('network drop'));
    render(<RunReviewContent runId="r1" status="success" onReviewed={vi.fn()} />);
    const button = await screen.findByText('Approve');
    fireEvent.click(button);
    expect(await screen.findByText('network drop')).toBeInTheDocument();
    expect(screen.getByText('Approve')).not.toBeDisabled();
  });

  test('flag calls the API with no note by default and shows the flagged badge', async () => {
    getMock.mockResolvedValue({ run: { id: 'r1', status: 'success' }, post: null });
    flagMock.mockResolvedValue({});
    const onReviewed = vi.fn();
    render(<RunReviewContent runId="r1" status="success" onReviewed={onReviewed} />);
    fireEvent.click(await screen.findByText('Flag'));
    await waitFor(() => expect(flagMock).toHaveBeenCalledWith('r1'));
    expect(onReviewed).toHaveBeenCalledWith({ flagged: true });
    expect(await screen.findByText('⚑ Flagged')).toBeInTheDocument();
  });
});
