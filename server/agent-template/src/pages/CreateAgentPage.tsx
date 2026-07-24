import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Rocket, Plug, Database, CalendarClock, AlertTriangle, Loader2, PartyPopper } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { DAYS_OF_WEEK, buildWeeklyCron } from '../components/ui';

interface Template {
  id: string; name: string; description?: string; category?: string;
  connectorTypes?: string[]; connector_types?: string[];
  scheduleCapable?: boolean; schedule_capable?: boolean;
  instructionsHint?: string; instructions_hint?: string;
}
interface Connector { id: string; type: string; name: string; status: string; }
interface KnowledgeBase { id: string; name: string; description?: string; assetCount?: number; asset_count?: number; }

const TIMEZONES = [
  'Pacific/Honolulu', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

const STEP_LABELS = ['Select Template', 'Connect', 'Personalize', 'Review & Launch'];

export default function CreateAgentPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);

  const [tpl, setTpl] = useState<Template | null>(null);
  const [agentName, setAgentName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [overlay, setOverlay] = useState('');
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [scheduleDays, setScheduleDays] = useState<string[]>([]);
  const [scheduleHour, setScheduleHour] = useState(9);

  const [launching, setLaunching] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [schedulerWarning, setSchedulerWarning] = useState('');

  useEffect(() => {
    Promise.all([
      ecgApi.templates.list().then(d => Array.isArray(d) ? d : []),
      ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])),
      ecgApi.knowledgeBases.list().then(d => Array.isArray(d) ? d : (d.knowledgeBases ?? [])).catch(() => []),
    ])
      .then(([t, c, kb]) => { setTemplates(t); setConnectors(c); setKnowledgeBases(kb); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const connectorTypes = tpl?.connectorTypes ?? tpl?.connector_types ?? [];
  const scheduleCapable = tpl?.scheduleCapable ?? tpl?.schedule_capable ?? false;
  const instructionsHint = tpl?.instructionsHint ?? tpl?.instructions_hint;
  const matchingConnectors = connectorTypes.length === 0
    ? connectors
    : connectors.filter(c => connectorTypes.some(t => c.type === t || c.type.startsWith(t)));

  function toggleConnector(id: string) {
    setSelectedConnectorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleKb(id: string) {
    setSelectedKbIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function launch() {
    if (!tpl || !agentName.trim()) return;
    setLaunching(true);
    setError('');
    try {
      const created: any = await ecgApi.agents.create({
        name: agentName.trim(),
        templateId: tpl.id,
        timezone,
        prompt_overlay: overlay,
        connectorIds: selectedConnectorIds,
        knowledgeBaseIds: selectedKbIds,
      });
      if (scheduleCapable && scheduleDays.length > 0 && created?.id) {
        // Backend expects a platform TYPE string ("zapier-mcp-linkedin"), not
        // the connector's row id  passing the raw id silently created a
        // scheduler with a garbage `connector` value that the publish
        // pipeline could never match to a real connector.
        const connectorType = connectors.find(c => c.id === selectedConnectorIds[0])?.type;
        if (connectorType) {
          try {
            await ecgApi.schedulers.create({ agentId: created.id, cron: buildWeeklyCron(scheduleDays, scheduleHour), connector: connectorType });
          } catch (e: any) {
            // Agent creation still succeeds  surface the scheduler failure
            // instead of silently swallowing it, so the user isn't left
            // wondering why nothing gets posted.
            setSchedulerWarning(e?.message ?? 'Could not set up the posting schedule.');
          }
        } else {
          setSchedulerWarning('Could not determine the platform for the selected connector  set up the schedule in Schedulers.');
        }
      }
      setDone(true);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create agent');
    } finally {
      setLaunching(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--muted)' }} /></div>;
  }

  if (launching || done) {
    return (
      <div className="flex flex-col items-center justify-center min-h-96 max-w-sm mx-auto text-center space-y-6 p-6">
        <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: done && !error ? '#dcfce7' : 'var(--accent-bg,#ede9fe)' }}>
          {done && !error ? <PartyPopper className="w-8 h-8 text-green-600" /> : <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />}
        </div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {done ? (error ? `${agentName} was created` : `${agentName} is live!`) : `Setting up ${agentName || 'your agent'}…`}
        </h2>
        {error && <p className="text-sm px-4 py-2 rounded-lg bg-amber-50 text-amber-700">{error}</p>}
        {done && schedulerWarning && (
          <p className="text-sm px-4 py-2 rounded-lg bg-amber-50 text-amber-700">{schedulerWarning}</p>
        )}
        {done && (
          <button onClick={() => navigate('/agents')}
            className="w-full py-2.5 rounded-lg text-white text-sm font-medium" style={{ background: 'var(--accent)' }}>
            Go to Agents
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Create Agent</h1>
        <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Configure and launch in {STEP_LABELS.length} steps</p>
      </div>

      <div className="flex items-center gap-2">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2"
              style={step > i + 1
                ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                : step === i + 1
                  ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
                  : { borderColor: 'var(--border)', color: 'var(--muted)' }}>
              {step > i + 1 ? <Check className="w-3 h-3" /> : i + 1}
            </div>
            <span className="text-[10px] text-center px-1" style={{ color: step >= i + 1 ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-3">
          {templates.length === 0 && <p className="text-sm text-center py-8" style={{ color: 'var(--muted)' }}>No templates available.</p>}
          {templates.map(t => {
            const selected = tpl?.id === t.id;
            return (
              <button key={t.id} onClick={() => setTpl(t)} className="w-full text-left p-4 rounded-xl border transition-colors"
                style={selected ? { borderColor: 'var(--accent)', background: 'var(--accent-bg,#ede9fe)' } : { borderColor: 'var(--border)', background: 'var(--card-bg)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{t.name}</p>
                    {t.description && <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{t.description}</p>}
                  </div>
                  <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
                    style={selected ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border)' }}>
                    {selected && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
              </button>
            );
          })}
          <div className="flex justify-end pt-2">
            <button onClick={() => tpl && setStep(2)} disabled={!tpl}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40"
              style={{ background: 'var(--accent)' }}>
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 2 && tpl && (
        <div className="space-y-5">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Plug className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Connected Accounts</p>
            </div>
            {connectors.length === 0 ? (
              <div className="rounded-xl border border-dashed p-5 text-center" style={{ borderColor: 'var(--border)' }}>
                <AlertTriangle className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text)' }}>No accounts connected yet.</p>
                <button onClick={() => navigate('/connectors')} className="text-xs mt-2 underline" style={{ color: 'var(--accent)' }}>
                  Connect one in Connectors
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {(matchingConnectors.length > 0 ? matchingConnectors : connectors).map(c => {
                  const on = selectedConnectorIds.includes(c.id);
                  return (
                    <label key={c.id} className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer"
                      style={{ borderColor: 'var(--border)', background: on ? 'var(--accent-bg,#ede9fe)' : 'var(--card-bg)' }}>
                      <input type="checkbox" checked={on} onChange={() => toggleConnector(c.id)} className="w-4 h-4" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{c.name}</p>
                        <p className="text-xs" style={{ color: 'var(--muted)' }}>{c.type}</p>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>{c.status}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {knowledgeBases.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Database className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Knowledge Bases (optional)</p>
              </div>
              <div className="space-y-2">
                {knowledgeBases.map(kb => {
                  const on = selectedKbIds.includes(kb.id);
                  return (
                    <label key={kb.id} className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer"
                      style={{ borderColor: 'var(--border)', background: on ? 'var(--accent-bg,#ede9fe)' : 'var(--card-bg)' }}>
                      <input type="checkbox" checked={on} onChange={() => toggleKb(kb.id)} className="w-4 h-4" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{kb.name}</p>
                      </div>
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>{kb.assetCount ?? kb.asset_count ?? 0} files</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(1)} className="px-4 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>Back</button>
            <button onClick={() => setStep(3)} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: 'var(--accent)' }}>
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 3 && tpl && (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Agent Name *</label>
            <input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder={`e.g. ${tpl.name}`}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Timezone</label>
            <select value={timezone} onChange={e => setTimezone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Instructions</label>
            {instructionsHint && <p className="text-xs mb-1.5 px-3 py-2 rounded-lg" style={{ background: 'var(--accent-bg,#ede9fe)', color: 'var(--text)' }}>{instructionsHint}</p>}
            <textarea value={overlay} onChange={e => setOverlay(e.target.value)} rows={4}
              placeholder="Org-specific instructions for this agent…"
              className="w-full px-3 py-2 rounded-lg border text-sm resize-none" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} />
          </div>
          {scheduleCapable && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CalendarClock className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
                <label className="text-xs font-medium" style={{ color: 'var(--text)' }}>Posting Schedule (optional)</label>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {DAYS_OF_WEEK.map(d => {
                  const on = scheduleDays.includes(d.value);
                  return (
                    <button key={d.value} type="button"
                      onClick={() => setScheduleDays(prev => on ? prev.filter(v => v !== d.value) : [...prev, d.value])}
                      className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
                      style={on ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
              <select value={scheduleHour} onChange={e => setScheduleHour(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>Leave no days selected to set up a schedule later in Schedulers.</p>
            </div>
          )}
          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(2)} className="px-4 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>Back</button>
            <button onClick={() => agentName.trim() && setStep(4)} disabled={!agentName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>
              Review <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 4 && tpl && (
        <div className="space-y-4">
          <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--card-bg)' }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--muted)' }}>Summary</p>
            {[['Name', agentName], ['Template', tpl.name], ['Timezone', timezone], ['Connectors', String(selectedConnectorIds.length)], ['Knowledge Bases', String(selectedKbIds.length)]].map(([l, v]) => (
              <div key={l} className="flex gap-4 text-sm"><span className="w-32 shrink-0" style={{ color: 'var(--muted)' }}>{l}</span><span style={{ color: 'var(--text)' }}>{v}</span></div>
            ))}
          </div>
          {error && <p className="text-sm px-4 py-2 rounded-lg bg-red-50 text-red-700">{error}</p>}
          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(3)} className="px-4 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>Back</button>
            <button onClick={launch} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: 'var(--accent)' }}>
              <Rocket className="w-4 h-4" /> Launch Agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
