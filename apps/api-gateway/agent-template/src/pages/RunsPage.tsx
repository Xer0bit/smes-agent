import { useEffect, useState } from 'react';
import { History, ChevronDown, ChevronUp } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, Card, EmptyState, SkeletonRows } from '../components/ui';
import { RunReviewContent } from '../components/RunReviewContent';

const showDuration = (ECG.moduleSettings.runs?.showDuration ?? true) !== false;

function dur(start: string, end?: string) {
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

const STATUS_DOT: Record<string, string> = {
  completed: 'var(--success)', success: 'var(--success)',
  failed: 'var(--danger)', error: 'var(--danger)', timeout: 'var(--danger)',
  running: 'var(--accent)',
};

type Filter = 'needs-review' | 'all';

// Mirrors T1's idx_runs_needs_review partial index definition exactly
// (WHERE reviewed_at IS NULL AND flagged = false) so the client-side filter
// and the DB index agree on what "needs review" means.
function needsReview(r: any): boolean {
  return !(r.reviewedAt ?? r.reviewed_at) && !r.flagged;
}

export default function RunsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('needs-review');

  useEffect(() => {
    ecgApi.runs.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.runs ?? [])))
      .finally(() => setLoading(false));
  }, []);

  function updateRow(id: string, patch: Record<string, unknown>) {
    setRows(prev => prev.map(row => row.id === id ? { ...row, ...patch } : row));
  }

  const visibleRows = filter === 'needs-review' ? rows.filter(needsReview) : rows;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader eyebrow="System" title="Run History" action={
        rows.length > 0 ? (
          <div className="inline-flex border overflow-hidden" style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {(['needs-review', 'all'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="px-3 py-1.5 font-medium"
                style={{
                  fontSize: 'var(--text-tiny)',
                  background: filter === f ? 'var(--accent)' : 'transparent',
                  color: filter === f ? '#fff' : 'var(--muted)',
                }}>
                {f === 'needs-review' ? 'Needs review' : 'All'}
              </button>
            ))}
          </div>
        ) : undefined
      } />
      {loading && <SkeletonRows count={5} />}
      {!loading && !rows.length && (
        <EmptyState Icon={History} title="No runs recorded yet"
          hint="Runs appear here every time an agent executes, whether scheduled or triggered manually." />
      )}
      {!loading && rows.length > 0 && !visibleRows.length && (
        <EmptyState Icon={History} title="Nothing needs review"
          hint="Every run has been approved or flagged. Switch to “All” to see the full history." />
      )}
      {!loading && visibleRows.length > 0 && (
        <>
          {/* Desktop: table with inline row expansion. Below the same 768px
              floor the sidebar collapses at, this is replaced by stacked
              cards (below) -- a scrolled table is not where you want to
              reach for Approve/Flag on a touch target. */}
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full" style={{ minWidth: '560px', fontSize: 'var(--text-small)' }}>
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                  {['Agent', 'Status', ...(showDuration ? ['Duration'] : []), 'Started', ''].map((h, i) => (
                    <th key={i} className="text-left px-4 py-3 font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r: any) => {
                  const error = r.error ?? r.errorMessage ?? r.error_message ?? null;
                  const isOpen = expanded === r.id;
                  const dot = STATUS_DOT[(r.status ?? '').toLowerCase()] ?? 'var(--muted)';
                  return [
                    <tr key={r.id} className="border-b last:border-0 ecg-row-hover cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
                      style={{ borderColor: 'var(--border)' }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : r.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(isOpen ? null : r.id); }
                      }}>
                      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>
                        <span className="inline-flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
                          {r.agentName ?? r.agent_name ?? ' '}
                        </span>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                      {showDuration && (
                        <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--muted)' }}>{dur(r.startedAt ?? r.started_at, r.completedAt ?? r.completed_at)}</td>
                      )}
                      <td className="px-4 py-3" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{new Date(r.startedAt ?? r.started_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        {isOpen
                          ? <ChevronUp className="w-3.5 h-3.5 inline" style={{ color: 'var(--muted)' }} />
                          : <ChevronDown className="w-3.5 h-3.5 inline" style={{ color: 'var(--muted)' }} />}
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${r.id}-detail`} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                        <td colSpan={showDuration ? 5 : 4} className="px-4 pb-3 pt-0">
                          <RunReviewContent
                            runId={r.id}
                            status={r.status}
                            error={error}
                            onReviewed={patch => updateRow(r.id, patch)}
                          />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            </div>
          </Card>

          {/* Mobile: stacked cards, same click-to-expand + RunReviewContent
              as the desktop table -- 44px-min touch targets, no horizontal
              scroll to reach Approve/Flag. */}
          <div className="md:hidden space-y-2">
            {visibleRows.map((r: any) => {
              const error = r.error ?? r.errorMessage ?? r.error_message ?? null;
              const isOpen = expanded === r.id;
              const dot = STATUS_DOT[(r.status ?? '').toLowerCase()] ?? 'var(--muted)';
              return (
                <Card key={r.id} className="p-4">
                  <button
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    className="w-full flex items-center justify-between gap-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    style={{ minHeight: '44px' }}
                    aria-expanded={isOpen}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
                        <span className="font-medium truncate" style={{ color: 'var(--text)', fontSize: 'var(--text-small)' }}>{r.agentName ?? r.agent_name ?? ' '}</span>
                      </span>
                      <span className="block mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                        {new Date(r.startedAt ?? r.started_at).toLocaleString()}
                        {showDuration && ` · ${dur(r.startedAt ?? r.started_at, r.completedAt ?? r.completed_at)}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={r.status} />
                      {isOpen
                        ? <ChevronUp className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
                        : <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                      <RunReviewContent
                        runId={r.id}
                        status={r.status}
                        error={error}
                        onReviewed={patch => updateRow(r.id, patch)}
                      />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
