// The "verify what the agent did" surface for one run -- shared by RunsPage's
// desktop row expansion and its mobile stacked-card layout (T3/T5) so
// Approve/Flag state logic lives in exactly one place. Fetches its own
// detail (GET /runs/:id) since the list endpoint never carries output
// content, only metadata.
import { useEffect, useState } from 'react';
import { ecgApi } from '../lib/ecgClient';
import { Spinner } from './ui';

export interface RunReviewData {
  id: string;
  status: string;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string | null;
  reviewedAt?: string | null;
  flagged?: boolean;
  flagNote?: string | null;
  post?: { platform: string; content: string } | null;
}

export function RunReviewContent({ runId, status, error, onReviewed }: {
  runId: string;
  status: string;
  error?: string | null;
  onReviewed: (patch: { reviewed?: boolean; flagged?: boolean }) => void;
}) {
  const [data, setData] = useState<RunReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState('');
  const [flagging, setFlagging] = useState(false);
  const [flagError, setFlagError] = useState('');
  const [flagNoteDraft, setFlagNoteDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    ecgApi.runs.get(runId)
      .then((d: any) => {
        if (cancelled) return;
        const run = d.run ?? d;
        setData({
          id: run.id,
          status: run.status,
          cost: run.cost,
          tokensIn: run.tokens_in ?? run.tokensIn,
          tokensOut: run.tokens_out ?? run.tokensOut,
          error: run.error_message ?? run.error ?? null,
          reviewedAt: run.reviewed_at ?? run.reviewedAt ?? null,
          flagged: run.flagged ?? false,
          flagNote: run.flag_note ?? run.flagNote ?? null,
          post: d.post ?? run.post ?? null,
        });
        setFlagNoteDraft(run.flag_note ?? run.flagNote ?? '');
      })
      .catch((e: any) => !cancelled && setLoadError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [runId]);

  if (loading) return <Spinner />;

  if (loadError) {
    return (
      <div className="px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
        {loadError}
      </div>
    );
  }

  if (!data) return null;

  const isRunning = status === 'running';
  const showActions = !isRunning && !data.reviewedAt && !data.flagged;

  async function handleApprove() {
    setApproving(true);
    setApproveError('');
    try {
      await ecgApi.runs.approve(runId);
      setData(d => d && { ...d, reviewedAt: new Date().toISOString() });
      onReviewed({ reviewed: true });
    } catch (e: any) {
      setApproveError(e.message);
    } finally {
      setApproving(false);
    }
  }

  async function handleFlag() {
    setFlagging(true);
    setFlagError('');
    try {
      await ecgApi.runs.flag(runId);
      setData(d => d && { ...d, flagged: true });
      onReviewed({ flagged: true });
    } catch (e: any) {
      setFlagError(e.message);
    } finally {
      setFlagging(false);
    }
  }

  async function handleFlagNoteBlur() {
    if (flagNoteDraft === (data?.flagNote ?? '')) return;
    try {
      await ecgApi.runs.flag(runId, flagNoteDraft);
      setData(d => d && { ...d, flagNote: flagNoteDraft });
    } catch { /* best-effort -- note is a nice-to-have, don't block the row on it */ }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      {isRunning && (
        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--accent)' }}>Run in progress…</p>
      )}

      {data.post ? (
        <div className="px-3 py-2 border" style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--body-bg)' }}>
          <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)' }}>{data.post.platform}</p>
          <p className="mt-1 whitespace-pre-wrap" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{data.post.content}</p>
        </div>
      ) : (
        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>This run produced no output.</p>
      )}

      <div className="flex items-center gap-3" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
        {data.cost !== undefined && <span>${Number(data.cost).toFixed(3)}</span>}
        {(data.tokensIn !== undefined || data.tokensOut !== undefined) && (
          <span>{data.tokensIn ?? 0} in / {data.tokensOut ?? 0} out</span>
        )}
      </div>

      {data.reviewedAt && (
        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--success)' }}>✓ Reviewed</p>
      )}

      {data.flagged && (
        <div className="space-y-1.5">
          <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--warning)' }}>⚑ Flagged</p>
          <textarea
            value={flagNoteDraft}
            onChange={e => setFlagNoteDraft(e.target.value)}
            onBlur={handleFlagNoteBlur}
            placeholder="Add a note (optional)"
            rows={2}
            className="w-full border px-2 py-1.5 focus:outline-none"
            style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-tiny)', borderRadius: 'var(--radius-sm)' }}
          />
        </div>
      )}

      {showActions && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleApprove}
            disabled={approving || flagging}
            className="px-3 py-2 font-medium text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius-sm)', minHeight: '44px' }}
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={handleFlag}
            disabled={approving || flagging}
            className="px-3 py-2 font-medium border disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius-sm)', minHeight: '44px' }}
          >
            {flagging ? 'Flagging…' : 'Flag'}
          </button>
        </div>
      )}

      {approveError && (
        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)' }}>{approveError}</p>
      )}
      {flagError && (
        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)' }}>{flagError}</p>
      )}
    </div>
  );
}
