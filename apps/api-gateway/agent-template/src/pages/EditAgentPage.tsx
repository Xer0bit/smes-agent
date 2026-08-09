import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Trash2, ArrowLeft } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { PageHeader, Card, SectionHeader, platformMeta, AgentDeleteModal, detectTimezone, Harness, DEFAULT_HARNESS, TagInput } from '../components/ui';
import { platformsForConnector } from './PostsPage';

const TIMEZONES = [
  'Pacific/Honolulu', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export default function EditAgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(detectTimezone);
  const [overlay, setOverlay] = useState('');
  const [status, setStatus] = useState('active');
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [harness, setHarness] = useState<Harness>(DEFAULT_HARNESS);

  const [connectors, setConnectors] = useState<any[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);

  useEffect(() => {
    if (!agentId) return;
    Promise.all([
      ecgApi.agents.get(agentId),
      ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])),
      ecgApi.knowledgeBases.list().then(d => Array.isArray(d) ? d : (d.knowledgeBases ?? [])).catch(() => []),
    ])
      .then(([agentResp, c, kb]: any[]) => {
        // get_agent_status nests the actual agent record under `.agent`
        // (the response also carries recentRuns/schedulers alongside it).
        const agent = agentResp.agent ?? agentResp;
        setName(agent.name ?? '');
        setTimezone(agent.timezone ?? detectTimezone());
        setOverlay(agent.prompt_overlay ?? agent.promptOverlay ?? '');
        setStatus(agent.status ?? 'active');
        setSelectedConnectorIds(agent.connector_ids ?? agent.connectorIds ?? []);
        setSelectedKbIds(agent.knowledge_base_ids ?? agent.knowledgeBaseIds ?? []);
        setHarness({ ...DEFAULT_HARNESS, ...(agent.harness ?? {}) });
        setConnectors(c);
        setKnowledgeBases(kb);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  function toggleConnector(id: string) {
    setSelectedConnectorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleKb(id: string) {
    setSelectedKbIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!agentId || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      // PATCH /agents/:id only accepts snake_case keys   no camelCase
      // fallback like POST has (see agents.ts's PATCH handler).
      await ecgApi.agents.update(agentId, {
        name: name.trim(),
        timezone,
        prompt_overlay: overlay,
        connector_ids: selectedConnectorIds,
        knowledge_base_ids: selectedKbIds,
        harness,
      });
      navigate('/agents');
    } catch (e: any) {
      setError(e.message ?? 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!agentId) return;
    setDeleting(true);
    setDeleteBlocked(false);
    try {
      await ecgApi.agents.delete(agentId);
      navigate('/agents');
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to delete agent';
      setError(msg);
      setDeleting(false);
      // Same rule AgentsPage.tsx handles (delete requires status='archived'
      // first) -- previously this page had no recovery for it, just a raw error.
      if (/only archived agents can be deleted/i.test(msg)) setDeleteBlocked(true);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--muted)' }} /></div>;
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
      </button>

      <PageHeader title="Edit Agent" />

      {error && <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>{error}</div>}

      <Card className="p-5 space-y-4">
        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Name</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full px-3 py-2 border" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Timezone</label>
          <select value={timezone} onChange={e => setTimezone(e.target.value)}
            className="w-full px-3 py-2 border" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
            {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Instructions</label>
          <textarea value={overlay} onChange={e => setOverlay(e.target.value)} rows={5}
            className="w-full px-3 py-2 border resize-none" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Status</label>
          <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Currently <span className="font-medium" style={{ color: 'var(--text)' }}>{status}</span>   change via the run/pause controls in Agents.</p>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <SectionHeader title="What this agent remembers" />
        <p className="-mt-2" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
          Controls what this agent remembers about its own past posts when it writes new ones, so it doesn't repeat itself.
        </p>

        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Avoid repeating recent topics</span>
          <input type="checkbox" checked={harness.avoidRepeats}
            onChange={e => setHarness(h => ({ ...h, avoidRepeats: e.target.checked }))} className="w-4 h-4" />
        </label>

        {harness.avoidRepeats && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>How many recent posts to remember</label>
              <span className="font-mono" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{harness.historyWindow}</span>
            </div>
            <input type="range" min={0} max={30} value={harness.historyWindow}
              onChange={e => setHarness(h => ({ ...h, historyWindow: Number(e.target.value) }))} className="w-full" />
          </div>
        )}

        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Topics to never post about</label>
          <TagInput tags={harness.topicsToAvoid} placeholder="Type a topic and press Enter…"
            onChange={t => setHarness(h => ({ ...h, topicsToAvoid: t }))} />
        </div>

        <div>
          <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Topics to prioritize / rotate through</label>
          <TagInput tags={harness.focusTopics} placeholder="Type a topic and press Enter…"
            onChange={t => setHarness(h => ({ ...h, focusTopics: t }))} />
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <SectionHeader title="Connected Accounts" />
        {connectors.length === 0 ? (
          <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No accounts connected yet.</p>
        ) : (
          <div className="space-y-2">
            {connectors.map((c: any) => {
              const on = selectedConnectorIds.includes(c.id);
              const platforms = platformsForConnector(c);
              return (
                <label key={c.id} className="flex items-center gap-3 p-2.5 border cursor-pointer"
                  style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--accent-bg)' : 'transparent', borderRadius: 'var(--radius-sm)' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleConnector(c.id)} className="w-4 h-4" />
                  <span className="flex-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{c.name}</span>
                  <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                    {platforms.length > 0 ? platforms.map(p => platformMeta(p).label).join(', ') : 'Unmapped connector'}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Card>

      {knowledgeBases.length > 0 && (
        <Card className="p-5 space-y-3">
          <SectionHeader title="Knowledge Bases" />
          <div className="space-y-2">
            {knowledgeBases.map((kb: any) => {
              const on = selectedKbIds.includes(kb.id);
              return (
                <label key={kb.id} className="flex items-center gap-3 p-2.5 border cursor-pointer"
                  style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--accent-bg)' : 'transparent', borderRadius: 'var(--radius-sm)' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleKb(kb.id)} className="w-4 h-4" />
                  <span style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{kb.name}</span>
                </label>
              );
            })}
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between pt-2">
        <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)' }}>
          <Trash2 className="w-3.5 h-3.5" /> Delete agent
        </button>
        <button onClick={handleSave} disabled={saving || !name.trim()}
          className="px-4 py-2 text-white font-medium hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {confirmDelete && agentId && (
        <AgentDeleteModal
          agentName={name}
          onClose={() => { setConfirmDelete(false); setDeleteBlocked(false); }}
          onConfirm={handleDelete}
          loading={deleting}
          blocked={deleteBlocked}
          onArchiveThenDelete={async () => {
            await ecgApi.agents.update(agentId, { status: 'archived' });
            setDeleteBlocked(false);
            handleDelete();
          }}
        />
      )}
    </div>
  );
}
