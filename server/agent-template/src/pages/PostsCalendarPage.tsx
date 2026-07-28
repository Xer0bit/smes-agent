import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle, XCircle, FileText, Pencil, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';
import { Card, Spinner, platformMeta } from '../components/ui';
import { PostModal, platformsForConnector } from './PostsPage';

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PostsCalendarPage() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<any[]>([]);
  const [connectedPlatforms, setConnectedPlatforms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [editingPost, setEditingPost] = useState<any>(null);
  const [error, setError] = useState('');
  const [draggedPostId, setDraggedPostId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);

  // Only posts still awaiting publish make sense to drag onto a new day --
  // posted/cancelled history shouldn't be draggable at all.
  const RESCHEDULABLE = ['draft', 'scheduled', 'failed'];

  async function handleReschedule(postId: string, targetDay: Date) {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    // Preserve whatever time-of-day the post already had; only the date moves.
    const prevRaw = post.scheduledAt ?? post.scheduled_at ?? post.createdAt ?? post.created_at;
    const prev = prevRaw ? new Date(prevRaw) : new Date();
    const next = new Date(targetDay);
    next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
    setRescheduling(postId);
    try {
      await ecgApi.posts.update(postId, { scheduledAt: next.toISOString() });
      setPosts(prev2 => prev2.map(p => p.id === postId ? { ...p, scheduledAt: next.toISOString() } : p));
    } catch (e: any) {
      setError(e.message ?? 'Could not reschedule this post');
    } finally {
      setRescheduling(null);
    }
  }

  useEffect(() => {
    Promise.all([
      ecgApi.posts.list(),
      ecgApi.connectors.list().catch(() => []),
    ]).then(([postsData, connectorsData]) => {
      setPosts(Array.isArray(postsData) ? postsData : (postsData.posts ?? postsData.plannedPosts ?? []));
      const connectors: any[] = Array.isArray(connectorsData) ? connectorsData : (connectorsData.connectors ?? []);
      const platforms: string[] = connectors
        .filter((c: any) => (c.status ?? '').toLowerCase() === 'connected')
        .flatMap((c: any): string[] => platformsForConnector(c));
      setConnectedPlatforms([...new Set(platforms)]);
    }).finally(() => setLoading(false));
  }, []);

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

  async function handleDelete(id: string) {
    try {
      await ecgApi.posts.delete(id);
      setPosts(prev => prev.filter(p => p.id !== id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleUpdate(data: { content: string; platform: string }) {
    if (!editingPost?.id) return;
    try {
      await ecgApi.posts.update(editingPost.id, data);
      setPosts(prev => prev.map(p => p.id === editingPost.id ? { ...p, ...data } : p));
      setEditingPost(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  // Real status vocabulary: draft/scheduled/posting/posted/failed/cancelled.
  // "scheduled for" here means scheduledAt if set, otherwise the post is
  // grouped under its createdAt day instead of being dropped from the view.
  const postsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const p of posts) {
      if (platformFilter !== 'all' && p.platform !== platformFilter) continue;
      const raw = p.scheduledAt ?? p.scheduled_at ?? p.createdAt ?? p.created_at;
      if (!raw) continue;
      const key = dateKey(new Date(raw));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [posts, platformFilter]);

  const weeks = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startOffset = first.getDay();
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - startOffset);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      days.push(d);
    }
    const rows: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [cursor]);

  const todayKey = dateKey(new Date());
  const selectedPosts = selectedDay ? (postsByDay.get(selectedDay) ?? []) : [];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/posts')} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity" style={{ color: 'var(--muted)' }}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Content</p>
          <h1 className="text-lg mt-0.5" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>Posts Calendar</h1>
        </div>
      </div>

      {error && <div className="text-sm rounded-lg px-4 py-3" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>{error}</div>}

      {connectedPlatforms.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button onClick={() => { setPlatformFilter('all'); setSelectedDay(null); }}
            className="text-xs px-3 py-1.5 rounded-full border font-medium shrink-0"
            style={platformFilter === 'all' ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
            All platforms
          </button>
          {connectedPlatforms.map(p => {
            const pm = platformMeta(p);
            const on = platformFilter === p;
            return (
              <button key={p} onClick={() => { setPlatformFilter(p); setSelectedDay(null); }}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium shrink-0"
                style={on ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: on ? '#fff' : pm.bar }} /> {pm.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
          className="p-1.5 rounded-lg border hover:opacity-70 transition-opacity" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </p>
        <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
          className="p-1.5 rounded-lg border hover:opacity-70 transition-opacity" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {loading ? <Spinner /> : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="px-2 py-2 text-center border-b" style={{ borderColor: 'var(--border)' }}>{d}</div>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7">
              {week.map(day => {
                const key = dateKey(day);
                const inMonth = day.getMonth() === cursor.getMonth();
                const dayPosts = postsByDay.get(key) ?? [];
                const isToday = key === todayKey;
                const isSelected = key === selectedDay;
                const isDragOver = dragOverKey === key;
                return (
                  <button key={key} onClick={() => setSelectedDay(dayPosts.length ? key : null)}
                    onDragOver={(e) => { if (draggedPostId) { e.preventDefault(); setDragOverKey(key); } }}
                    onDragLeave={() => { if (isDragOver) setDragOverKey(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverKey(null);
                      if (draggedPostId) handleReschedule(draggedPostId, day);
                      setDraggedPostId(null);
                    }}
                    className="min-h-20 p-1.5 text-left border-b border-r flex flex-col gap-1"
                    style={{
                      borderColor: isDragOver ? 'var(--accent)' : 'var(--border)',
                      background: isDragOver ? 'var(--accent-bg)' : isSelected ? 'var(--accent-bg)' : 'transparent',
                      opacity: inMonth ? 1 : 0.35,
                      cursor: dayPosts.length ? 'pointer' : 'default',
                    }}>
                    <span className="text-xs font-medium" style={isToday ? { color: 'var(--accent)' } : { color: 'var(--text)' }}>{day.getDate()}</span>
                    {dayPosts.slice(0, 3).map((p, i) => {
                      const pm = platformMeta(p.platform ?? '');
                      const draggableHere = RESCHEDULABLE.includes(p.status);
                      return (
                        <span key={i}
                          draggable={draggableHere}
                          onDragStart={(e) => { e.stopPropagation(); setDraggedPostId(p.id); e.dataTransfer.setData('text/plain', p.id); }}
                          onDragEnd={() => { setDraggedPostId(null); setDragOverKey(null); }}
                          title={draggableHere ? 'Drag to a different day to reschedule' : undefined}
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded truncate"
                          style={{
                            background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--text)',
                            cursor: draggableHere ? 'grab' : 'default',
                            opacity: rescheduling === p.id ? 0.5 : 1,
                          }}>
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} />
                          {pm.label}
                        </span>
                      );
                    })}
                    {dayPosts.length > 3 && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>+{dayPosts.length - 3} more</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </Card>
      )}

      {selectedDay && selectedPosts.length > 0 && (
        <Card className="p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
            {new Date(selectedDay).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          {selectedPosts.map((p: any) => {
            const pm = platformMeta(p.platform ?? '');
            return (
              <div key={p.id} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-start gap-2">
                  {['posted', 'scheduled', 'posting'].includes(p.status) ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                    : p.status === 'failed' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
                    : p.status === 'cancelled' ? <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
                    : <FileText className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--muted)' }} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-relaxed line-clamp-2" style={{ color: 'var(--text)' }}>{p.content ?? '(no content)'}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {p.platform && (
                        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} /> {pm.label}
                        </span>
                      )}
                      <StatusBadge status={p.status} />
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {p.status === 'draft' && (
                      <>
                        <button onClick={() => act(p.id, 'reject')} disabled={!!acting} title="Reject"
                          className="p-1.5 rounded hover:bg-red-500/10 disabled:opacity-50">
                          <XCircle className="w-3.5 h-3.5" style={{ color: '#dc2626' }} />
                        </button>
                        <button onClick={() => act(p.id, 'approve')} disabled={!!acting} title="Approve"
                          className="p-1.5 rounded hover:bg-[var(--accent-bg)] disabled:opacity-50">
                          <CheckCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                        </button>
                      </>
                    )}
                    {p.status === 'failed' && (
                      <button onClick={() => act(p.id, 'approve')} disabled={!!acting} title="Retry"
                        className="p-1.5 rounded hover:bg-[var(--accent-bg)] disabled:opacity-50">
                        <RefreshCw className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                      </button>
                    )}
                    {['draft', 'scheduled', 'failed'].includes(p.status) && (
                      <button onClick={() => setEditingPost(p)} title="Edit"
                        className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                        <Pencil className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
                      </button>
                    )}
                    <button onClick={() => handleDelete(p.id)} title="Delete"
                      className="p-1.5 rounded hover:bg-red-500/10">
                      <Trash2 className="w-3.5 h-3.5" style={{ color: '#dc2626' }} />
                    </button>
                  </div>
                </div>
                {p.status === 'failed' && p.errorMessage && (
                  <p className="mt-2 text-xs rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }}>{p.errorMessage}</p>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {editingPost && (
        <PostModal
          connectedPlatforms={connectedPlatforms}
          initial={{ content: editingPost.content ?? '', platform: editingPost.platform ?? '' }}
          onClose={() => setEditingPost(null)}
          onSave={handleUpdate}
          loading={false}
        />
      )}
    </div>
  );
}
