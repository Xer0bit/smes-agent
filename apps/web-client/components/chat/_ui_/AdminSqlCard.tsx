import { useState } from 'react';
import { Loader2, Play, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { runAdminSqlBatch, rejectAdminSql } from '@/services/adminSqlService';

/**
 * The SQL an agent reply staged, shown in the chat under that reply as one
 * ordered batch with one action: run everything, in staging order, as a single
 * transaction. Rows carry their own status, and a failure is pinned to the
 * statement that caused it with Postgres's message, so nothing runs out of
 * order and nothing runs twice.
 *
 * Replaced a side panel that listed statements newest-first with a Confirm
 * button each. Clicked top to bottom, that ran the INSERT before the CREATE
 * TABLE it needed.
 */

export interface StagedSqlRow {
  id: string;
  sql_text: string;
  status: string;
  created_at: string;
  error_message?: string | null;
}

interface AdminSqlCardProps {
  projectId: string;
  rows: StagedSqlRow[];
  /** Restrict "Run all" to this batch (the run that staged these rows). */
  batchId?: string | null;
  /** Re-fetch rows after an action; the parent owns the data. */
  onChanged: () => Promise<void> | void;
  /** Hand the failing statement and error to the agent as a new prompt. */
  onAskAgentToFix?: (prompt: string) => void;
  disabled?: boolean;
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0].slice(0, 110);
}

export function AdminSqlCard({ projectId, rows, batchId, onChanged, onAskAgentToFix, disabled }: AdminSqlCardProps) {
  const [running, setRunning] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; error: string } | null>(null);
  // Status changes this card caused (a run, a reject). The rows prop is the
  // snapshot the reply arrived with; the server is not re-read for it.
  const [local, setLocal] = useState<Record<string, string>>({});
  const statusOf = (r: StagedSqlRow) => local[r.id] ?? r.status;

  const pending = rows.filter((r) => statusOf(r) === 'pending');
  const executed = rows.filter((r) => statusOf(r) === 'executed');
  if (rows.length === 0) return null;

  const runAll = async () => {
    setRunning(true); setFailed(null);
    try {
      const result = await runAdminSqlBatch(projectId, batchId ?? undefined);
      if (result.success) {
        setLocal((l) => ({ ...l, ...Object.fromEntries(result.executed.map((id) => [id, 'executed'])) }));
        toast.success(result.executed.length === 1 ? 'Database change applied.' : `${result.executed.length} database changes applied, in order.`);
      } else {
        setFailed({ id: result.failedId ?? '', error: result.error ?? 'Failed' });
        if (result.failedId) setOpenId(result.failedId);
        toast.error('One statement failed; nothing was applied.');
      }
      await onChanged();
    } catch (e) { toast.error((e as Error).message); }
    finally { setRunning(false); }
  };

  const reject = async (row: StagedSqlRow) => {
    setRejecting(row.id);
    try { await rejectAdminSql(row.id); setLocal((l) => ({ ...l, [row.id]: 'rejected' })); await onChanged(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setRejecting(null); }
  };

  const askToFix = (row: StagedSqlRow, error: string) => {
    onAskAgentToFix?.(
      `This staged database statement failed when I ran the batch:\n\n${row.sql_text}\n\nError: ${error}\n\n` +
      `Stage a corrected version (and reject or replace anything that depended on it). Keep the other staged statements as they are.`,
    );
  };

  return (
    <div className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.04]">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-amber-500/15">
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-amber-200">
            {pending.length > 0
              ? `${pending.length} database change${pending.length === 1 ? '' : 's'} waiting for you`
              : `${executed.length} database change${executed.length === 1 ? '' : 's'} applied`}
          </p>
          <p className="text-[11px] text-white/45">
            {pending.length > 0 ? 'Runs in this order, as one transaction. Nothing is applied until all succeed.' : 'Nothing left to run.'}
          </p>
        </div>
        {pending.length > 0 && (
          <button
            onClick={runAll}
            disabled={disabled || running}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-black hover:bg-amber-400 disabled:opacity-50 transition-colors"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run all in order
          </button>
        )}
      </div>

      <ol className="divide-y divide-white/[0.06]">
        {rows.map((row, i) => {
          const status = statusOf(row);
          const error = failed?.id === row.id ? failed.error : row.error_message;
          const open = openId === row.id;
          return (
            <li key={row.id} className="px-3.5 py-2">
              <div className="flex items-start gap-2.5">
                <span className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] tabular-nums',
                  status === 'executed' ? 'border-emerald-400/60 text-emerald-300'
                    : status === 'rejected' ? 'border-white/20 text-white/30 line-through'
                    : error ? 'border-red-400/70 text-red-300'
                    : 'border-white/30 text-white/60',
                )}>{i + 1}</span>
                <button onClick={() => setOpenId(open ? null : row.id)} className="min-w-0 flex-1 text-left">
                  <p className={cn('truncate font-mono text-[12px]', status === 'rejected' ? 'text-white/30 line-through' : 'text-white/80')}>{firstLine(row.sql_text)}</p>
                  <p className="text-[11px] text-white/35">
                    {status === 'executed' ? 'applied' : status === 'rejected' ? 'rejected' : error ? 'failed on last run' : 'waiting'}
                  </p>
                </button>
                {status === 'pending' && (
                  <button
                    onClick={() => reject(row)}
                    disabled={disabled || running || rejecting === row.id}
                    title="Reject this statement"
                    className="h-6 w-6 shrink-0 rounded-md flex items-center justify-center text-white/35 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                  >
                    {rejecting === row.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              {open && (
                <pre className="mt-2 ml-6 max-h-48 overflow-auto rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed text-white/75 whitespace-pre-wrap break-all">{row.sql_text}</pre>
              )}
              {error && status === 'pending' && (
                <div className="mt-2 ml-6 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2.5 py-2">
                  <p className="font-mono text-[11.5px] text-red-300/90 break-words">{error}</p>
                  {onAskAgentToFix && (
                    <button
                      onClick={() => askToFix(row, error)}
                      disabled={disabled}
                      className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-white/70 hover:text-white disabled:opacity-40"
                    >
                      <Wrench className="h-3 w-3" /> Ask the agent to fix this
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
