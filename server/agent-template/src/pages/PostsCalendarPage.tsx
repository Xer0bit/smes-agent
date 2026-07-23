import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle, XCircle, FileText } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';
import { Card, Spinner, platformMeta } from '../components/ui';

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PostsCalendarPage() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    ecgApi.posts.list()
      .then(d => setPosts(Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])))
      .finally(() => setLoading(false));
  }, []);

  // The proxy's planned-posts response only ever gives pending/approved/
  // rejected (see DashboardPage.tsx's note on toDashboardPostStatus)  
  // "scheduled for" here means scheduledAt if set, otherwise the post is
  // grouped under its createdAt day instead of being dropped from the view.
  const postsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const p of posts) {
      const raw = p.scheduledAt ?? p.scheduled_at ?? p.createdAt ?? p.created_at;
      if (!raw) continue;
      const key = dateKey(new Date(raw));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [posts]);

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
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/posts')} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity" style={{ color: 'var(--muted)' }}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Content</p>
          <h1 className="text-lg mt-0.5" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>Posts Calendar</h1>
        </div>
      </div>

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
                return (
                  <button key={key} onClick={() => setSelectedDay(dayPosts.length ? key : null)}
                    className="min-h-20 p-1.5 text-left border-b border-r flex flex-col gap-1"
                    style={{
                      borderColor: 'var(--border)',
                      background: isSelected ? 'var(--accent-bg)' : 'transparent',
                      opacity: inMonth ? 1 : 0.35,
                      cursor: dayPosts.length ? 'pointer' : 'default',
                    }}>
                    <span className="text-xs font-medium" style={isToday ? { color: 'var(--accent)' } : { color: 'var(--text)' }}>{day.getDate()}</span>
                    {dayPosts.slice(0, 3).map((p, i) => {
                      const pm = platformMeta(p.platform ?? '');
                      return (
                        <span key={i} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded truncate"
                          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}>
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
              <div key={p.id} className="flex items-start gap-2 p-2.5 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                {p.status === 'approved' ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                  : p.status === 'rejected' ? <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
                  : <FileText className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--muted)' }} />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-relaxed line-clamp-2" style={{ color: 'var(--text)' }}>{p.content ?? '(no content)'}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {p.platform && (
                      <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} /> {pm.label}
                      </span>
                    )}
                    <StatusBadge status={p.status} />
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
