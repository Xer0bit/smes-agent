import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Archive, ArchiveRestore, ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiServerUrl } from "@/config/external-api";
import { cn } from "@/lib/utils";

/**
 * What the agent knows about this project, as the owner sees it: one row per
 * chunk with its heading, where it came from, and what it costs to carry.
 * Archived chunks are kept but never sent to a run; deleted ones are gone.
 *
 * Replaces two free-text boxes that were injected verbatim into every run.
 * Those became the first two "Owner note" rows.
 */

type Source = 'note' | 'agent' | 'chat' | 'change' | 'upload' | 'codebase';

interface Chunk {
  id: string;
  source: Source;
  heading: string;
  content: string;
  tokens: number;
  archived: boolean;
  created_at: string;
}

const SOURCE_LABEL: Record<Source, string> = {
  note: 'Note',
  agent: 'Agent',
  chat: 'Chat',
  change: 'Change',
  upload: 'Upload',
  codebase: 'Codebase',
};

/**
 * Eco per run for a chunk, on the input rate of the default model
 * ($3 / 1M tokens) and the platform's 0.05 USD per eco. An estimate for
 * comparison between chunks, not an invoice.
 */
function ecoPerRun(tokens: number): number {
  return (tokens * 3) / 1_000_000 / 0.05;
}

function fmtEco(eco: number): string {
  if (eco < 0.005) return '<0.01';
  return eco.toFixed(2);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

interface KnowledgeSettingsProps {
  projectId?: string;
}

function PaywallCard() {
  return (
    <div className="space-y-6">
      <Heading />
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Paid plan feature</CardTitle>
          <CardDescription>Upgrade your organization plan to manage what the agent remembers about your project.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')} className="w-full">
            Manage Billing
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Heading() {
  return (
    <div>
      <h2 className="text-base font-semibold text-white/85 mb-1">Knowledge</h2>
      <p className="text-sm text-white/45">
        What the agent carries into a run: your notes, facts it chose to remember, and files you uploaded.
        Archive what it should stop using; delete what should be gone. More active knowledge costs more eco per run.
      </p>
    </div>
  );
}

export const KnowledgeSettings = ({ projectId }: KnowledgeSettingsProps) => {
  const { subscribed } = useSubscription();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'active' | 'archived'>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [noteHeading, setNoteHeading] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [saving, setSaving] = useState(false);

  const apiFetch = useCallback(async (path: string, opts: RequestInit = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(getApiServerUrl(`/api/v1${path}${sep}project_id=${encodeURIComponent(projectId ?? '')}`), {
      ...opts,
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  }, [projectId]);

  const { data: payload, isLoading } = useQuery({
    queryKey: ['project-knowledge', projectId],
    enabled: !!projectId && subscribed,
    queryFn: async () => (await apiFetch('/knowledge')) as { chunks: Chunk[]; codebase?: { indexedFiles: number; lastIndexedAt: string | null } },
  });
  const data = payload?.chunks;
  const codebase = payload?.codebase;

  const refresh = () => qc.invalidateQueries({ queryKey: ['project-knowledge', projectId] });

  const setArchived = async (c: Chunk, archived: boolean) => {
    setBusyId(c.id);
    try {
      await apiFetch(`/knowledge/${c.id}`, { method: 'PATCH', body: JSON.stringify({ archived }) });
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusyId(null); }
  };

  const remove = async (c: Chunk) => {
    if (!window.confirm(`Delete "${c.heading}"? The agent will no longer know this.`)) return;
    setBusyId(c.id);
    try {
      await apiFetch(`/knowledge/${c.id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusyId(null); }
  };

  const addNote = async () => {
    if (!noteHeading.trim() || !noteContent.trim()) { toast.error('Give the note a heading and some content'); return; }
    setSaving(true);
    try {
      await apiFetch('/knowledge', { method: 'POST', body: JSON.stringify({ heading: noteHeading.trim(), content: noteContent.trim() }) });
      setNoteHeading(''); setNoteContent(''); setAdding(false);
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  if (!subscribed) return <PaywallCard />;

  const chunks = data ?? [];
  const active = chunks.filter((c) => !c.archived);
  const archived = chunks.filter((c) => c.archived);
  const shown = filter === 'active' ? active : archived;
  const activeTokens = active.reduce((n, c) => n + c.tokens, 0);

  return (
    <div className="space-y-5">
      <Heading />

      {/* Totals */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Active chunks" value={String(active.length)} />
        <Stat label="Active tokens" value={activeTokens.toLocaleString()} />
        <Stat label="Eco per run, up to" value={`≈ ${fmtEco(ecoPerRun(Math.min(activeTokens, 2500)))}`} hint="A run carries at most ~2,500 tokens of knowledge, chosen by relevance." />
      </div>

      {/* How the agent sees the code: the retrieval index plus the map chunk below. */}
      <div className="rounded-xl border border-white/[0.07] bg-workspace-surface px-3.5 py-3 text-[12.5px] text-white/60 leading-relaxed">
        <span className="text-white/85 font-medium">How the agent sees your code.</span>{' '}
        {codebase?.indexedFiles
          ? <>{codebase.indexedFiles.toLocaleString()} source files are indexed for retrieval{codebase.lastIndexedAt ? `, last ${relativeTime(codebase.lastIndexedAt)}` : ''}. </>
          : <>No files indexed yet; the first run indexes the project. </>}
        Each run picks the files relevant to your request from that index, and carries the <span className="text-white/85">Codebase map</span> chunk below
        (routes, pages, components, functions, tables), rebuilt after every run that changes files. Archive it if you want runs to work from the files alone.
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] p-0.5">
          {(['active', 'archived'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[12px] transition-colors',
                filter === f ? 'bg-white/[0.08] text-white/90' : 'text-white/45 hover:text-white/75',
              )}
            >
              {f === 'active' ? `Active (${active.length})` : `Archived (${archived.length})`}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => setAdding((v) => !v)}>
          <Plus className="h-3.5 w-3.5" /> Add note
        </Button>
      </div>

      {adding && (
        <div className="rounded-xl border border-white/[0.1] bg-workspace-surface p-4 space-y-2.5">
          <Input
            value={noteHeading}
            onChange={(e) => setNoteHeading(e.target.value.slice(0, 160))}
            placeholder="Heading, e.g. Brand rules"
            className="h-8 text-[13px] bg-white/[0.04] border-white/[0.08]"
          />
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value.slice(0, 4000))}
            placeholder="What the agent should always keep in mind for this project."
            rows={4}
            className="text-[13px] bg-white/[0.04] border-white/[0.08] resize-y"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/35">{noteContent.length}/4000 · ≈ {fmtEco(ecoPerRun(Math.ceil(noteContent.length / 4)))} eco per run</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" className="h-8 text-xs" onClick={addNote} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save note'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : shown.length === 0 ? (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardContent className="py-8 text-center text-sm text-white/40">
            {filter === 'active'
              ? 'Nothing yet. Add a note, or run the agent: each conversation, change and upload is kept here.'
              : 'Nothing archived.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {shown.map((c) => {
            const open = openId === c.id;
            const busy = busyId === c.id;
            return (
              <div key={c.id} className={cn('rounded-xl border bg-workspace-surface transition-colors', open ? 'border-white/[0.14]' : 'border-white/[0.07]')}>
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <button onClick={() => setOpenId(open ? null : c.id)} className="flex-1 min-w-0 flex items-center gap-3 text-left" aria-expanded={open}>
                    <span className="w-16 shrink-0 text-[11px] text-white/40">{SOURCE_LABEL[c.source]}</span>
                    <span className="flex-1 min-w-0 truncate text-[13px] text-white/85">{c.heading}</span>
                    <span className="hidden sm:block shrink-0 text-[11px] text-white/35 tabular-nums">{c.tokens.toLocaleString()} tok · ≈ {fmtEco(ecoPerRun(c.tokens))} eco</span>
                    <span className="hidden md:block shrink-0 w-20 text-right text-[11px] text-white/30">{relativeTime(c.created_at)}</span>
                    <ChevronDown className={cn('h-4 w-4 shrink-0 text-white/35 transition-transform duration-150', open && 'rotate-180')} />
                  </button>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => setArchived(c, !c.archived)}
                      disabled={busy}
                      title={c.archived ? 'Restore: the agent will use this again' : 'Archive: keep it, but stop sending it to runs'}
                      className="h-7 w-7 flex items-center justify-center rounded-md text-white/40 hover:text-white/85 hover:bg-white/[0.06] disabled:opacity-40 transition-colors"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : c.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={() => remove(c)}
                      disabled={busy}
                      title="Delete permanently"
                      className="h-7 w-7 flex items-center justify-center rounded-md text-white/40 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {open && (
                  <div className="border-t border-white/[0.07] px-3.5 py-3">
                    <p className="text-[12.5px] leading-relaxed text-white/70 whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">{c.content}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-workspace-surface px-3.5 py-2.5" title={hint}>
      <p className="text-[11px] text-white/40">{label}</p>
      <p className="text-[15px] font-semibold text-white/90 tabular-nums">{value}</p>
    </div>
  );
}
