import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Zap, Pencil, Calendar, History, FileText } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';
import { Card, Spinner, EmptyState, relTime } from '../components/ui';

interface AgentDetail {
  agent: { id: string; name: string; status: string; lastRunAt: string | null };
  recentRuns: Array<{ id: string; status: string; startedAt: string; durationMs: number; cost: number; tokensIn: number; tokensOut: number }>;
  schedulers: Array<{ id: string; cron: string; status: string; nextRun: string | null; lastRun: string | null; postCount: number }>;
}

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    ecgApi.agents.get(agentId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleRun = async () => {
    if (!agentId) return;
    setRunning(true);
    try {
      await ecgApi.agents.run(agentId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div className="p-6"><Spinner /></div>;

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 text-xs mb-4 hover:opacity-70" style={{ color: 'var(--muted)' }}>
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
        </button>
        <div className="text-sm rounded-lg px-4 py-3" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>
          {error || 'Agent not found'}
        </div>
      </div>
    );
  }

  const { agent, recentRuns, schedulers } = data;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 text-xs hover:opacity-70" style={{ color: 'var(--muted)' }}>
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
      </button>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white text-lg"
            style={{ background: 'var(--accent)', fontWeight: 'var(--font-weight-heading)' }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg truncate" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{agent.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={agent.status} />
              {agent.lastRunAt && (
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Last run {relTime(agent.lastRunAt)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleRun} disabled={running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--accent)' }}>
            <Zap className="w-3.5 h-3.5" /> {running ? 'Running…' : 'Run now'}
          </button>
          <button onClick={() => navigate(`/agents/${agent.id}/edit`)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-sm font-medium" style={{ color: 'var(--text)' }}>Schedulers</h3>
            <button onClick={() => navigate('/schedulers')} className="ml-auto text-xs hover:opacity-70" style={{ color: 'var(--accent)' }}>
              Manage
            </button>
          </div>
          {schedulers.length === 0 ? (
            <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>No scheduler set up for this agent yet.</p>
          ) : (
            <div className="space-y-2">
              {schedulers.map(s => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                  <div>
                    <p className="text-xs font-mono" style={{ color: 'var(--text)' }}>{s.cron}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{s.postCount} post{s.postCount === 1 ? '' : 's'} per run</p>
                  </div>
                  <div className="text-right shrink-0">
                    <StatusBadge status={s.status} />
                    {s.nextRun && <p className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>next {relTime(s.nextRun)}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <History className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-sm font-medium" style={{ color: 'var(--text)' }}>Recent runs</h3>
            <button onClick={() => navigate('/runs')} className="ml-auto text-xs hover:opacity-70" style={{ color: 'var(--accent)' }}>
              View all
            </button>
          </div>
          {recentRuns.length === 0 ? (
            <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>No runs yet.</p>
          ) : (
            <div className="space-y-2">
              {recentRuns.map(r => (
                <div key={r.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)' }}>
                  <StatusBadge status={r.status} />
                  <span style={{ color: 'var(--muted)' }}>{(r.durationMs / 1000).toFixed(1)}s</span>
                  <span style={{ color: 'var(--muted)' }}>${Number(r.cost).toFixed(3)}</span>
                  <span style={{ color: 'var(--muted)' }}>{relTime(r.startedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {schedulers.length === 0 && recentRuns.length === 0 && (
        <EmptyState Icon={FileText} title="Nothing here yet"
          hint="Run this agent or set up a scheduler to start seeing activity." />
      )}
    </div>
  );
}
