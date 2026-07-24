import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, XCircle, FileText, Plus, Trash2, Pencil, X, Sparkles, Calendar, RefreshCw, AlertTriangle } from 'lucide-react';
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
  youtube: 'YouTube', tiktok: 'TikTok', threads: 'Threads', pinterest: 'Pinterest',
  telegram: 'Telegram', whatsapp: 'WhatsApp',
};

// A connector's `type` is always `zapier-mcp-<platform>` (or the native
// `whatsapp`) -- see ConnectorsPage.tsx. The generic `zapier` type covers no
// single known platform, so it's excluded rather than guessed at.
export function platformFromConnectorType(type: string): string | null {
  if (type === 'whatsapp') return 'whatsapp';
  if (type.startsWith('zapier-mcp-')) return type.replace('zapier-mcp-', '');
  return null;
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
  const [modalLoading, setModalLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      ecgApi.posts.list(),
      ecgApi.connectors.list().catch(() => []),
    ])
      .then(([postsData, connectorsData]) => {
        setPosts(Array.isArray(postsData) ? postsData : (postsData.posts ?? postsData.plannedPosts ?? []));
        const connectors = Array.isArray(connectorsData) ? connectorsData : (connectorsData.connectors ?? []);
        const platforms = connectors
          .filter((c: any) => ['connected', 'active'].includes((c.status ?? '').toLowerCase()))
          .map((c: any) => platformFromConnectorType(c.type))
          .filter((p: string | null): p is string => p !== null);
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

  const handleUpdate = async (data: { content: string; platform: string }) => {
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
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <PageHeader eyebrow="Content" title="Posts" action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/posts/calendar')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            <Calendar className="w-4 h-4" /> Calendar
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
            style={{ background: 'var(--accent)' }}
          >
            <Plus className="w-4 h-4" /> New Post
          </button>
        </div>
      } />

      {error && <div className="text-sm rounded-lg px-4 py-3" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>{error}</div>}

      {connectedPlatforms.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button onClick={() => { setPlatformFilter('all'); setSelected(new Set()); }}
            className="text-xs px-3 py-1.5 rounded-full border font-medium shrink-0"
            style={platformFilter === 'all' ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
            All platforms
          </button>
          {connectedPlatforms.map(p => {
            const pm = platformMeta(p);
            const on = platformFilter === p;
            return (
              <button key={p} onClick={() => { setPlatformFilter(p); setSelected(new Set()); }}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium shrink-0"
                style={on ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
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
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={tab === t ? { background: 'var(--card-bg)', color: 'var(--text)' } : { color: 'var(--muted)' }}>
                {TAB_LABELS[t]}{n > 0 ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {tab === 'draft' && visibleDraftIds.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
              <input type="checkbox" checked={allVisibleDraftsSelected} onChange={toggleSelectAllVisible} className="w-3.5 h-3.5" />
              Select all
            </label>
          )}
          {tab === 'draft' && selected.size > 0 && (
            <button onClick={handleBulkApprove} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}>
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
              <div key={p.id} className="rounded-xl border p-5 space-y-3"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    {p.status === 'draft' && (
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)}
                        className="mt-1 w-4 h-4 shrink-0" />
                    )}
                    <FileText className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
                    <p className="text-sm leading-relaxed" style={{ color: overLimit ? '#dc2626' : 'var(--text)' }}>{p.content ?? p.body ?? '(no content)'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={p.status} />
                    {['draft', 'scheduled', 'failed'].includes(p.status) && (
                      <button
                        onClick={() => setEditingPost(p)}
                        className="p-1 rounded hover:opacity-70"
                        title="Edit post"
                        style={{ color: 'var(--muted)' }}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => navigate(`/posts/${p.id}/visual`)}
                      className="p-1 rounded hover:opacity-70"
                      title="Add or edit visual"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Sparkles className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setDeletingPost(p)}
                      className="p-1 rounded hover:bg-red-50"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4 text-red-600" />
                    </button>
                  </div>
                </div>

                {p.status === 'failed' && p.errorMessage && (
                  <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="flex-1">{p.errorMessage}</span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t flex-wrap gap-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.platform && (
                      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-bg)', color: 'var(--text)' }}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} /> {pm.label}
                      </span>
                    )}
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{p.agentName ?? p.agent_name}</span>
                    {(p.scheduledAt ?? p.scheduled_at) && (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}
                        title={new Date(p.scheduledAt ?? p.scheduled_at).toLocaleString()}>
                        · {relTime(p.scheduledAt ?? p.scheduled_at)}
                      </span>
                    )}
                    {p.postUrl && (
                      <a href={p.postUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs underline hover:opacity-70" style={{ color: 'var(--accent)' }}>
                        View post
                      </a>
                    )}
                    {p.status === 'draft' && typeof p.confidence === 'number' && (
                      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}
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
                        <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg disabled:opacity-50">
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                        <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50"
                          style={{ background: 'var(--accent)' }}>
                          <CheckCircle className="w-3.5 h-3.5" /> Approve
                        </button>
                      </>
                    )}
                    {p.status === 'scheduled' && (
                      <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Cancel
                      </button>
                    )}
                    {p.status === 'failed' && (
                      <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50"
                        style={{ background: 'var(--accent)' }}>
                        <RefreshCw className="w-3.5 h-3.5" /> Retry
                      </button>
                    )}
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
          initial={{ content: editingPost.content ?? '', platform: editingPost.platform ?? '' }}
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
    </div>
  );
}

export function PostModal({ connectedPlatforms, initial, onClose, onSave, loading }: {
  connectedPlatforms: string[];
  initial?: { content: string; platform: string };
  onClose: () => void;
  onSave: (data: any) => void;
  loading: boolean;
}) {
  const [content, setContent] = useState(initial?.content ?? '');
  const [platform, setPlatform] = useState(initial?.platform || connectedPlatforms[0] || '');
  const limit = useMemo(() => platformCharLimit(platform), [platform]);
  const overLimit = content.length > limit;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || !platform || overLimit) return;
    onSave({ content: content.trim(), platform });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{initial ? 'Edit Post' : 'New Post'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium" style={{ color: 'var(--text)' }}>Content</label>
              <span className="text-xs" style={{ color: overLimit ? '#dc2626' : 'var(--muted)' }}>{content.length} / {limit}</span>
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 resize-none"
              style={{ background: 'var(--input-bg)', borderColor: overLimit ? '#dc2626' : 'var(--border)', color: 'var(--text)' }}
              placeholder="Write your post content here..."
              autoFocus
            />
            {overLimit && <p className="text-xs mt-1" style={{ color: '#dc2626' }}>Too long for {PLATFORM_LABELS[platform] ?? platform} ({limit} character limit).</p>}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Platform</label>
            {connectedPlatforms.length === 0 ? (
              <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }}>
                No connected platforms yet. Connect one in Connectors first.
              </p>
            ) : (
              <select
                value={platform}
                onChange={e => setPlatform(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                {connectedPlatforms.map(p => (
                  <option key={p} value={p}>{PLATFORM_LABELS[p] ?? p}</option>
                ))}
              </select>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !content.trim() || !platform || overLimit}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
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
      <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Post</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Are you sure you want to delete {itemName}? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 disabled:opacity-50"
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
