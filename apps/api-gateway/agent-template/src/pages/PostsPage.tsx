import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, XCircle, FileText, Plus, Trash2, Pencil, X, Sparkles, Calendar, RefreshCw, AlertTriangle, Wand2 } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, EmptyState, Spinner, relTime, platformMeta, platformCharLimit } from '../components/ui';

// Real backend status vocabulary (get_planned_posts returns these unmapped):
// draft (awaiting review) | scheduled | posting | posted | failed | cancelled.
const TABS = ['all', 'draft', 'scheduled', 'posted', 'failed'] as const;
type Tab = typeof TABS[number];

const configuredDefaultTab = ECG.moduleSettings.posts?.defaultTab as Tab | undefined;
const defaultTab: Tab = configuredDefaultTab && (TABS as readonly string[]).includes(configuredDefaultTab)
  ? configuredDefaultTab
  : 'draft';

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn', x: 'X', twitter: 'X', instagram: 'Instagram', facebook: 'Facebook',
  youtube: 'YouTube', tiktok: 'TikTok', threads: 'Threads', bluesky: 'Bluesky',
  whatsapp: 'WhatsApp',
};

// A connector's `platforms` array (set at creation, or backfilled server-side
// for older rows) is the authoritative source -- one Buffer connector can
// cover several platforms at once (e.g. type: 'buffer' with
// platforms: ['linkedin','facebook','youtube']), not just one. Only fall back
// to guessing from `type` (`buffer-<platform>`, or the native `whatsapp`)
// for legacy connectors created before the `platforms` field existed.
export function platformsForConnector(c: { type: string; platforms?: string[] }): string[] {
  if (Array.isArray(c.platforms) && c.platforms.length > 0) return c.platforms;
  if (c.type === 'whatsapp') return ['whatsapp'];
  if (c.type.startsWith('buffer-')) return [c.type.replace('buffer-', '')];
  return [];
}

export default function PostsPage() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<any[]>([]);
  const [connectedPlatforms, setConnectedPlatforms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [acting, setActing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingPost, setEditingPost] = useState<any>(null);
  const [deletingPost, setDeletingPost] = useState<any>(null);
  const [regeneratingPost, setRegeneratingPost] = useState<any>(null);
  const [regenLoading, setRegenLoading] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      ecgApi.posts.list(),
      ecgApi.connectors.list().catch(() => []),
    ])
      .then(([postsData, connectorsData]) => {
        setPosts(Array.isArray(postsData) ? postsData : (postsData.posts ?? postsData.plannedPosts ?? []));
        const connectors: any[] = Array.isArray(connectorsData) ? connectorsData : (connectorsData.connectors ?? []);
        const platforms: string[] = connectors
          .filter((c: any) => (c.status ?? '').toLowerCase() === 'connected')
          .flatMap((c: any): string[] => platformsForConnector(c));
        setConnectedPlatforms([...new Set(platforms)]);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const visible = posts.filter(p => (tab === 'all' || p.status === tab) && (platformFilter === 'all' || p.platform === platformFilter));
  const draftCount = posts.filter(p => p.status === 'draft').length;
  const visibleDraftIds = visible.filter(p => p.status === 'draft').map(p => p.id);
  const allVisibleDraftsSelected = visibleDraftIds.length > 0 && visibleDraftIds.every(id => selected.has(id));

  async function act(id: string, action: 'approve' | 'reject') {
    setActing(id);
    try {
      if (action === 'approve') await ecgApi.posts.approve(id);
      else await ecgApi.posts.reject(id);
      setPosts(prev => prev.map(p => p.id === id ? { ...p, status: action === 'approve' ? 'scheduled' : 'cancelled' } : p));
    } catch (e: any) {
      setError(e.message);
    } finally { setActing(null); }
  }

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelected(prev => {
      if (allVisibleDraftsSelected) return new Set([...prev].filter(id => !visibleDraftIds.includes(id)));
      return new Set([...prev, ...visibleDraftIds]);
    });
  }

  async function handleBulkApprove() {
    if (selected.size === 0) return;
    setBulkLoading(true);
    try {
      const ids = [...selected];
      await ecgApi.posts.bulkApprove(ids);
      setPosts(prev => prev.map(p => ids.includes(p.id) ? { ...p, status: 'scheduled' } : p));
      setSelected(new Set());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBulkLoading(false);
    }
  }

  const handleDelete = async () => {
    if (!deletingPost?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.posts.delete(deletingPost.id);
      setPosts(posts.filter(p => p.id !== deletingPost.id));
      setDeletingPost(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleCreate = async (postData: any) => {
    setModalLoading(true);
    try {
      const created = await ecgApi.posts.create(postData);
      setPosts([...posts, created]);
      setShowCreate(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleRegenerate = async (feedback?: string) => {
    if (!regeneratingPost?.id) return;
    setRegenLoading(true);
    try {
      const updated = await ecgApi.posts.regenerate(regeneratingPost.id, feedback);
      setPosts(posts.map(p => p.id === regeneratingPost.id
        ? { ...p, content: updated.content ?? p.content, confidence: updated.confidence ?? p.confidence, status: 'draft' }
        : p));
      setRegeneratingPost(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRegenLoading(false);
    }
  };

  const handleUpdate = async (data: { content: string; platform: string; scheduledAt?: string }) => {
    if (!editingPost?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.posts.update(editingPost.id, data);
      setPosts(posts.map(p => p.id === editingPost.id ? { ...p, ...data } : p));
      setEditingPost(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const TAB_LABELS: Record<Tab, string> = { all: 'All', draft: 'Needs review', scheduled: 'Scheduled', posted: 'Published', failed: 'Failed' };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader eyebrow="Content" title="Posts" action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/posts/calendar')}
            className="flex items-center gap-2 px-4 py-2 font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}
          >
            <Calendar className="w-4 h-4" /> Calendar
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 font-medium text-white hover:opacity-90"
            style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}
          >
            <Plus className="w-4 h-4" /> New Post
          </button>
        </div>
      } />

      {error && <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>{error}</div>}

      {connectedPlatforms.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button onClick={() => { setPlatformFilter('all'); setSelected(new Set()); }}
            className="px-3 py-1.5 rounded-full border font-medium shrink-0"
            style={platformFilter === 'all' ? { fontSize: 'var(--text-tiny)', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)' }}>
            All platforms
          </button>
          {connectedPlatforms.map(p => {
            const pm = platformMeta(p);
            const on = platformFilter === p;
            return (
              <button key={p} onClick={() => { setPlatformFilter(p); setSelected(new Set()); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border font-medium shrink-0"
                style={on ? { fontSize: 'var(--text-tiny)', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: on ? '#fff' : pm.bar }} /> {pm.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'var(--border)' }}>
          {TABS.map(t => {
            const n = (t === 'all' ? posts : posts.filter(p => p.status === t))
              .filter(p => platformFilter === 'all' || p.platform === platformFilter).length;
            return (
              <button key={t} onClick={() => { setTab(t); setSelected(new Set()); }}
                className="px-3 py-1.5 rounded-lg font-medium transition-colors"
                style={tab === t ? { fontSize: 'var(--text-tiny)', background: 'var(--card-bg)', color: 'var(--text)' } : { fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                {TAB_LABELS[t]}{n > 0 ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {tab === 'draft' && visibleDraftIds.length > 1 && (
            <label className="flex items-center gap-1.5 cursor-pointer" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
              <input type="checkbox" checked={allVisibleDraftsSelected} onChange={toggleSelectAllVisible} className="w-3.5 h-3.5" />
              Select all
            </label>
          )}
          {tab === 'draft' && selected.size > 0 && (
            <button onClick={handleBulkApprove} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium text-white hover:opacity-90 disabled:opacity-50"
              style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent)' }}>
              <CheckCircle className="w-3.5 h-3.5" /> {bulkLoading ? 'Approving…' : `Approve ${selected.size} selected`}
            </button>
          )}
        </div>
      </div>

      {loading && <Spinner />}
      {!loading && !visible.length && (
        <EmptyState Icon={FileText} title={`No ${tab === 'all' ? '' : TAB_LABELS[tab].toLowerCase() + ' '}posts`}
          hint={draftCount === 0 && tab === 'draft'
            ? 'Nothing waiting for review. New posts land here when an agent generates them.'
            : 'Posts your agents generate, plus any you write yourself, appear here.'} />
      )}
      {!loading && (
        <div className="space-y-3">
          {visible.map((p: any) => {
            const pm = platformMeta(p.platform ?? '');
            const limit = platformCharLimit(p.platform ?? '');
            const overLimit = (p.content?.length ?? 0) > limit;
            return (
              <div key={p.id} className="border overflow-hidden"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' }}>
                {/* Platform-tinted preview -- so a reviewer sees roughly how this
                    will read on the target platform (avatar + handle + content),
                    not just a bare paragraph. Not a pixel clone of the real
                    platform UI -- an honest, generic post-card shape tinted with
                    the platform's own accent color. */}
                <div className="p-4 pb-0">
                  <div className="flex items-start gap-2.5">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center font-semibold text-white shrink-0"
                      style={{ fontSize: 'var(--text-tiny)', background: pm.bar }}>
                      {ECG.appName.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold leading-tight" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{ECG.appName}</p>
                      <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{pm.label} · just now</p>
                    </div>
                  </div>
                </div>
                <div className="p-5 pt-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    {p.status === 'draft' && (
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)}
                        className="mt-1 w-4 h-4 shrink-0" />
                    )}
                    <p className="leading-relaxed" style={{ fontSize: 'var(--text-small)', color: overLimit ? 'var(--danger)' : 'var(--text)' }}>{p.content ?? p.body ?? '(no content)'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={p.status} />
                    {['draft', 'scheduled', 'failed'].includes(p.status) && (
                      <button
                        onClick={() => setEditingPost(p)}
                        className="p-1 rounded hover:opacity-70"
                        title="Edit post"
                        aria-label="Edit post"
                        style={{ color: 'var(--muted)' }}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => navigate(`/posts/${p.id}/visual`)}
                      className="p-1 rounded hover:opacity-70"
                      title="Add or edit visual"
                      aria-label="Add or edit visual"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Sparkles className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setDeletingPost(p)}
                      className="p-1 rounded hover:bg-red-500/10"
                      title="Delete"
                      aria-label="Delete post"
                    >
                      <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                    </button>
                  </div>
                </div>

                {p.status === 'failed' && p.errorMessage && (
                  <div className="flex items-start gap-2 px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="flex-1">{p.errorMessage}</span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t flex-wrap gap-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Written by {p.agentName ?? p.agent_name}</span>
                    {(p.scheduledAt ?? p.scheduled_at) && (
                      <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}
                        title={new Date(p.scheduledAt ?? p.scheduled_at).toLocaleString()}>
                        · {relTime(p.scheduledAt ?? p.scheduled_at)}
                      </span>
                    )}
                    {p.postUrl && (
                      <a href={p.postUrl} target="_blank" rel="noopener noreferrer"
                        className="underline hover:opacity-70" style={{ fontSize: 'var(--text-tiny)', color: 'var(--accent)' }}>
                        View post
                      </a>
                    )}
                    {p.status === 'draft' && typeof p.confidence === 'number' && (
                      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}
                        title={`Agent confidence: ${Math.round(p.confidence * 100)}%`}>
                        <span className="w-12 h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                          <span className="block h-full rounded-full" style={{ width: `${Math.round(p.confidence * 100)}%`, background: 'var(--accent)' }} />
                        </span>
                        {Math.round(p.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {p.status === 'draft' && (
                      <>
                        <button onClick={() => setRegeneratingPost(p)} disabled={!!acting}
                          className="flex items-center gap-1 px-3 py-1.5 font-medium rounded-lg border disabled:opacity-50"
                          style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                          <Wand2 className="w-3.5 h-3.5" /> Regenerate
                        </button>
                        <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                          className="flex items-center gap-1 px-3 py-1.5 font-medium border rounded-lg disabled:opacity-50" style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)', background: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                        <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                          className="flex items-center gap-1 px-3 py-1.5 font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                          style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent)' }}>
                          <CheckCircle className="w-3.5 h-3.5" /> Approve
                        </button>
                      </>
                    )}
                    {p.status === 'scheduled' && (
                      <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 font-medium border rounded-lg disabled:opacity-50" style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)', background: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
                        <XCircle className="w-3.5 h-3.5" /> Cancel
                      </button>
                    )}
                    {p.status === 'failed' && (
                      <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                        style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent)' }}>
                        <RefreshCw className="w-3.5 h-3.5" /> Retry
                      </button>
                    )}
                  </div>
                </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <PostModal
          connectedPlatforms={connectedPlatforms}
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
          loading={modalLoading}
        />
      )}

      {editingPost && (
        <PostModal
          connectedPlatforms={connectedPlatforms}
          initial={{
            content: editingPost.content ?? '',
            platform: editingPost.platform ?? '',
            scheduledAt: editingPost.scheduledAt ?? editingPost.scheduled_at ?? undefined,
          }}
          onClose={() => setEditingPost(null)}
          onSave={handleUpdate}
          loading={modalLoading}
        />
      )}

      {deletingPost && (
        <DeleteConfirmModal
          itemName="this post"
          onClose={() => setDeletingPost(null)}
          onConfirm={handleDelete}
          loading={modalLoading}
        />
      )}

      {regeneratingPost && (
        <RegenerateModal
          onClose={() => setRegeneratingPost(null)}
          onRegenerate={handleRegenerate}
          loading={regenLoading}
        />
      )}
    </div>
  );
}

function RegenerateModal({ onClose, onRegenerate, loading }: {
  onClose: () => void;
  onRegenerate: (feedback?: string) => void;
  loading: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-lg p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2" style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>
            <Wand2 className="w-4 h-4" style={{ color: 'var(--accent)' }} /> Regenerate Post
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>
        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>What should change? (optional)</label>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            rows={3}
            placeholder="e.g. make it shorter, less salesy, more casual…"
            className="w-full px-3 py-2 border resize-none"
            style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            autoFocus
          />
          <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Leave blank to just get a fresh take on the same topic.</p>
        </div>
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={loading}
            className="flex-1 px-4 py-2 border" style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
            Cancel
          </button>
          <button type="button" onClick={() => onRegenerate(feedback.trim() || undefined)} disabled={loading}
            className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}>
            {loading ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ISO string -> the local-time value a <input type="datetime-local"> needs
// (YYYY-MM-DDTHH:mm, no seconds/timezone). Empty string if unset.
function toDatetimeLocalValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PostModal({ connectedPlatforms, initial, onClose, onSave, loading }: {
  connectedPlatforms: string[];
  initial?: { content: string; platform: string; scheduledAt?: string };
  onClose: () => void;
  onSave: (data: any) => void;
  loading: boolean;
}) {
  const isCreate = !initial;
  const [content, setContent] = useState(initial?.content ?? '');
  const [platform, setPlatform] = useState(initial?.platform || connectedPlatforms[0] || '');
  // agentId only applies to creating a brand-new post -- an existing post is
  // already attributed to whichever agent wrote (or was assigned to) it.
  const [agentId, setAgentId] = useState(() => ECG.agentIds[0] ?? '');
  // Publish time, editable in both modes: empty on create = save as a draft
  // awaiting review (unchanged default); filled in = schedule it. Editing an
  // existing post's time here does the same PATCH the calendar's
  // drag-to-reschedule already uses -- this is just a more discoverable path
  // to the same capability, not a new backend behavior.
  const [scheduledAt, setScheduledAt] = useState(() => toDatetimeLocalValue(initial?.scheduledAt));
  const limit = useMemo(() => platformCharLimit(platform), [platform]);
  const overLimit = content.length > limit;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || !platform || overLimit) return;
    const scheduledAtIso = scheduledAt ? new Date(scheduledAt).toISOString() : undefined;
    if (isCreate) {
      onSave({
        content: content.trim(),
        platform,
        agentId,
        ...(scheduledAtIso ? { scheduledAt: scheduledAtIso, status: 'scheduled' } : {}),
      });
    } else {
      onSave({ content: content.trim(), platform, ...(scheduledAtIso ? { scheduledAt: scheduledAtIso } : {}) });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-lg p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between">
          <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>{initial ? 'Edit Post' : 'New Post'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Content</label>
              <span style={{ fontSize: 'var(--text-tiny)', color: overLimit ? 'var(--danger)' : 'var(--muted)' }}>{content.length} / {limit}</span>
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border focus:outline-none resize-none"
              style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: overLimit ? 'var(--danger)' : 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
              placeholder="Write your post content here..."
              autoFocus
            />
            {overLimit && <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)' }}>Too long for {PLATFORM_LABELS[platform] ?? platform} ({limit} character limit).</p>}
          </div>

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Platform</label>
            {connectedPlatforms.length === 0 ? (
              <p className="px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
                No connected platforms yet. Connect one in Connectors first.
              </p>
            ) : (
              <select
                value={platform}
                onChange={e => setPlatform(e.target.value)}
                className="w-full px-3 py-2 border focus:outline-none"
                style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
              >
                {connectedPlatforms.map(p => (
                  <option key={p} value={p}>{PLATFORM_LABELS[p] ?? p}</option>
                ))}
              </select>
            )}
          </div>

          {isCreate && ECG.agentIds.length > 1 && (
            <div>
              <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Agent</label>
              <select
                value={agentId}
                onChange={e => setAgentId(e.target.value)}
                className="w-full px-3 py-2 border focus:outline-none"
                style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
              >
                {ECG.agentIds.map(id => (
                  <option key={id} value={id}>{ECG.agentNames[id] ?? id}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>
              Publish at {isCreate ? '(optional)' : ''}
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
              className="w-full px-3 py-2 border focus:outline-none"
              style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            />
            <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
              {isCreate
                ? 'Leave blank to save as a draft awaiting review instead of scheduling it.'
                : 'Change this to reschedule the post (same as dragging it on the calendar).'}
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !content.trim() || !platform || overLimit}
              className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}
            >
              {loading ? 'Saving…' : initial ? 'Save Changes' : 'Create Post'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ itemName, onClose, onConfirm, loading }: {
  itemName: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Delete Post</h2>
        <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
          Are you sure you want to delete {itemName}? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
