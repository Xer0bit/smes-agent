import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, XCircle, FileText, Plus, Trash2, Pencil, X, Sparkles, Calendar } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

const configuredDefaultTab = ECG.moduleSettings.posts?.defaultTab as Tab | undefined;
const defaultTab: Tab = configuredDefaultTab && (TABS as readonly string[]).includes(configuredDefaultTab)
  ? configuredDefaultTab
  : 'pending';

const PLATFORM_COLORS: Record<string, string> = {
  linkedin: 'bg-blue-100 text-blue-700', twitter: 'bg-sky-100 text-sky-700',
  x: 'bg-sky-100 text-sky-700', instagram: 'bg-pink-100 text-pink-700',
  facebook: 'bg-indigo-100 text-indigo-700', youtube: 'bg-red-100 text-red-700',
  tiktok: 'bg-cyan-100 text-cyan-700', threads: 'bg-slate-200 text-slate-700',
  pinterest: 'bg-red-100 text-red-700', telegram: 'bg-sky-100 text-sky-700',
  whatsapp: 'bg-green-100 text-green-700',
};

export default function PostsPage() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [acting, setActing] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingPost, setDeletingPost] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.posts.list()
      .then(d => setPosts(Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const visible = posts.filter(p => tab === 'all' || p.status === tab);
  const pendingCount = posts.filter(p => p.status === 'pending').length;

  async function act(id: string, action: 'approve' | 'reject') {
    setActing(id);
    try {
      if (action === 'approve') await ecgApi.posts.approve(id);
      else await ecgApi.posts.reject(id);
      setPosts(prev => prev.map(p => p.id === id ? { ...p, status: action === 'approve' ? 'approved' : 'rejected' } : p));
    } catch (e: any) {
      setError(e.message);
    } finally { setActing(null); }
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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Planned Posts</h1>
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
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: 'var(--accent)' }}
          >
            <Plus className="w-4 h-4" /> New Post
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'var(--border)' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
            style={tab === t ? { background: 'var(--card-bg)', color: 'var(--text)' } : { color: 'var(--muted)' }}>
            {t}{t === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>
      {loading && <Spinner />}
      {!loading && !visible.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No {tab} posts</div>}
      {!loading && (
        <div className="space-y-3">
          {visible.map((p: any) => {
            const platCls = PLATFORM_COLORS[(p.platform ?? '').toLowerCase()] ?? 'bg-slate-100 text-slate-600';
            return (
              <div key={p.id} className="rounded-xl border p-5 space-y-3"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <FileText className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{p.content ?? p.body ?? '(no content)'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={p.status} />
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
                <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.platform && <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${platCls}`}>{p.platform}</span>}
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{p.agentName ?? p.agent_name}</span>
                  </div>
                  {p.status === 'pending' && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                      <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50"
                        style={{ background: 'var(--accent)' }}>
                        <CheckCircle className="w-3.5 h-3.5" /> Approve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <PostModal
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
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

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }

function PostModal({ onClose, onSave, loading }: {
  onClose: () => void;
  onSave: (data: any) => void;
  loading: boolean;
}) {
  const [content, setContent] = useState('');
  const [platform, setPlatform] = useState('linkedin');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    onSave({ content: content.trim(), platform });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>New Post</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Content</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 resize-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              placeholder="Write your post content here..."
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Platform</label>
            <select
              value={platform}
              onChange={e => setPlatform(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              <option value="linkedin">LinkedIn</option>
              <option value="twitter">Twitter</option>
              <option value="x">X</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
              <option value="threads">Threads</option>
              <option value="pinterest">Pinterest</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
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
              disabled={loading || !content.trim()}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Creating...' : 'Create Post'}
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
