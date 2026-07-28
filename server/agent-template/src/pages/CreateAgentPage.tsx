import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check, ChevronRight, ChevronDown, Rocket, Plug, Database, CalendarClock, AlertTriangle, Loader2, PartyPopper,
  Wand2, Sparkles, Brain,
} from 'lucide-react';
import { ecgApi, isPreviewUnavailable } from '../lib/ecgClient';
import { DAYS_OF_WEEK, buildWeeklyCron, platformMeta, detectTimezone, Harness, DEFAULT_HARNESS, TagInput } from '../components/ui';
import { platformsForConnector } from './PostsPage';

interface Template {
  id: string; name: string; description?: string; category?: string;
  connectorTypes?: string[]; connector_types?: string[];
  scheduleCapable?: boolean; schedule_capable?: boolean;
  instructionsHint?: string; instructions_hint?: string;
}
interface Connector { id: string; type: string; name: string; status: string; platforms?: string[]; }
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
  const [timezone, setTimezone] = useState(detectTimezone);
  const [overlay, setOverlay] = useState('');
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [scheduleDays, setScheduleDays] = useState<string[]>([]);
  const [scheduleHour, setScheduleHour] = useState(9);
  const [harness, setHarness] = useState<Harness>(DEFAULT_HARNESS);
  const [showMemory, setShowMemory] = useState(false);

  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [launching, setLaunching] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [schedulerWarning, setSchedulerWarning] = useState('');
  const [harnessWarning, setHarnessWarning] = useState('');

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
  // Template connectorTypes are `zapier-mcp-<platform>`-shaped; a real connector
  // may be the generic multi-platform `zapier` type instead, so match on the
  // platforms it actually covers rather than its raw type string (same fix as
  // platformsForConnector elsewhere -- a type-string match alone silently
  // excludes any connector using the generic type).
  const templatePlatforms = connectorTypes.map(t => t.startsWith('zapier-mcp-') ? t.replace('zapier-mcp-', '') : t);
  const matchingConnectors = templatePlatforms.length === 0
    ? connectors
    : connectors.filter(c => platformsForConnector(c).some(p => templatePlatforms.includes(p)));

  function toggleConnector(id: string) {
    setSelectedConnectorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleKb(id: string) {
    setSelectedKbIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // Guided default: a schedule-capable template starts pre-checked at a
  // working Mon/Wed/Fri 9am cadence instead of an empty control most people
  // would forget to touch -- easy to turn off, harder to accidentally skip.
  useEffect(() => {
    if (tpl && (tpl.scheduleCapable ?? tpl.schedule_capable) && scheduleDays.length === 0) {
      setScheduleDays(['1', '3', '5']);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl?.id]);

  const harnessChanged = JSON.stringify(harness) !== JSON.stringify(DEFAULT_HARNESS);

  function harnessSummary(h: Harness): string {
    const parts: string[] = [];
    if (h.avoidRepeats) parts.push(`Avoids repeating last ${h.historyWindow} posts`);
    if (h.focusTopics.length) parts.push(`Focuses on ${h.focusTopics.join(', ')}`);
    if (h.topicsToAvoid.length) parts.push(`Avoids ${h.topicsToAvoid.join(', ')}`);
    return parts.length ? parts.join(' · ') : 'Off';
  }

  async function handlePreview() {
    if (!overlay.trim() || !tpl) return;
    setPreviewLoading(true); setPreviewError(''); setPreviewUnavailable(false);
    try {
      const systemPrompt = `You are "${agentName.trim() || tpl.name}", a ${tpl.name} agent for this organization. Instructions: ${overlay.trim()}`;
      const text = await ecgApi.assistant.preview(systemPrompt, 'Write one example post this agent would publish. Keep it realistic and under 3 sentences, no preamble.');
      setPreview(text.trim() || null);
    } catch (e: any) {
      if (isPreviewUnavailable(e)) setPreviewUnavailable(true);
      else setPreviewError(e.message ?? 'Could not generate a preview right now.');
    } finally {
      setPreviewLoading(false);
    }
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
      // Harness has no create-time equivalent on the backend (only
      // update_agent forwards it) -- same create-then-configure pattern as
      // the scheduler loop just below. Only bother if the user actually
      // changed something from the default.
      if (harnessChanged && created?.id) {
        try {
          await ecgApi.agents.update(created.id, { harness });
        } catch (e: any) {
          setHarnessWarning(e.message ?? 'Could not save memory settings -- set them up in the agent\'s Edit page.');
        }
      }
      if (scheduleCapable && scheduleDays.length > 0 && created?.id) {
        // Backend expects a platform TYPE string ("zapier-mcp-linkedin"), not
        // the connector's row id  passing the raw id silently created a
        // scheduler with a garbage `connector` value that the publish
        // pipeline could never match to a real connector. `platforms` must
        // also be passed explicitly: create_scheduler defaults it to
        // ['linkedin'] when omitted, so a generic multi-platform connector
        // covering e.g. only Facebook+YouTube would otherwise silently get
        // scheduled to post to LinkedIn instead. One scheduler is created per
        // selected connector -- previously only the first was ever used,
        // silently dropping the rest.
        const scheduleConnectors = selectedConnectorIds
          .map(id => connectors.find(c => c.id === id))
          .filter((c): c is Connector => !!c);
        const failedNames: string[] = [];
        for (const c of scheduleConnectors) {
          const platforms = platformsForConnector(c);
          try {
            await ecgApi.schedulers.create({
              agentId: created.id,
              cron: buildWeeklyCron(scheduleDays, scheduleHour),
              connector: c.type,
              platforms: platforms.length > 0 ? platforms : undefined,
            });
          } catch {
            failedNames.push(c.name);
          }
        }
        if (scheduleConnectors.length === 0) {
          setSchedulerWarning('Could not determine which connector to schedule  set up the schedule in Schedulers.');
        } else if (failedNames.length > 0) {
          // Agent creation still succeeds  surface the scheduler failure
          // instead of silently swallowing it, so the user isn't left
          // wondering why nothing gets posted.
          setSchedulerWarning(`Could not set up the schedule for: ${failedNames.join(', ')}. Set it up in Schedulers.`);
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
        <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: done && !error ? 'var(--success-bg)' : 'var(--accent-bg)' }}>
          {done && !error ? <PartyPopper className="w-8 h-8" style={{ color: 'var(--success)' }} /> : <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />}
        </div>
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>
          {done ? (error ? `${agentName} was created` : `${agentName} is live!`) : `Setting up ${agentName || 'your agent'}…`}
        </h2>
        {error && <p className="px-4 py-2" style={{ fontSize: 'var(--text-small)', background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 'var(--radius-sm)' }}>{error}</p>}
        {done && schedulerWarning && (
          <p className="px-4 py-2" style={{ fontSize: 'var(--text-small)', background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 'var(--radius-sm)' }}>{schedulerWarning}</p>
        )}
        {done && harnessWarning && (
          <p className="px-4 py-2" style={{ fontSize: 'var(--text-small)', background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 'var(--radius-sm)' }}>{harnessWarning}</p>
        )}
        {done && (
          <button onClick={() => navigate('/agents')}
            className="w-full py-2.5 text-white font-medium hover:opacity-90" style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
            Go to Agents
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 style={{ color: 'var(--text)' }}>Create Agent</h1>
        <p className="mt-0.5" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>Configure and launch in {STEP_LABELS.length} steps</p>
      </div>

      {/* Wizard page-type template (design.md): a persistent left step-rail
          showing all steps + current position, content column fixed-width
          across steps so nothing jumps between them. */}
      <div className="flex flex-col md:flex-row gap-8">
        <div className="flex md:flex-col gap-1 md:w-52 shrink-0 overflow-x-auto md:overflow-visible">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const state = step > n ? 'done' : step === n ? 'active' : 'upcoming';
            return (
              <div key={label} className="flex items-center gap-3 px-3 py-2.5 shrink-0" style={{ borderRadius: 'var(--radius-sm)', background: state === 'active' ? 'var(--accent-bg)' : 'transparent' }}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center font-bold border-2 shrink-0"
                  style={state === 'done'
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontSize: 'var(--text-tiny)' }
                    : state === 'active'
                      ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', fontSize: 'var(--text-tiny)' }
                      : { borderColor: 'var(--border)', color: 'var(--muted)', fontSize: 'var(--text-tiny)' }}>
                  {state === 'done' ? <Check className="w-3 h-3" /> : n}
                </div>
                <span style={{ fontSize: 'var(--text-small)', fontWeight: state === 'active' ? 600 : 400, color: state === 'upcoming' ? 'var(--muted)' : 'var(--text)' }}>{label}</span>
              </div>
            );
          })}
        </div>

        <div className="flex-1 min-w-0">

      {step === 1 && (
        <div className="space-y-3">
          {templates.length === 0 && <p className="text-center py-8" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No templates available.</p>}
          {templates.map(t => {
            const selected = tpl?.id === t.id;
            const hint = t.instructionsHint ?? t.instructions_hint;
            return (
              <button key={t.id} onClick={() => setTpl(t)} className="w-full text-left p-4 border transition-colors"
                style={selected ? { borderColor: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 'var(--radius)' } : { borderColor: 'var(--border)', background: 'var(--card-bg)', borderRadius: 'var(--radius)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{t.name}</p>
                    {t.description && <p className="mt-0.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{t.description}</p>}
                  </div>
                  <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
                    style={selected ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border)' }}>
                    {selected && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
                {/* Surface the guidance BEFORE the pick is made, not just after --
                    an informed choice beats re-reading it once already committed. */}
                {hint && (
                  <p className="mt-2 flex items-start gap-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                    <Sparkles className="w-3 h-3 shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
                    {hint}
                  </p>
                )}
              </button>
            );
          })}
          <div className="flex justify-end pt-2">
            <button onClick={() => tpl && setStep(2)} disabled={!tpl}
              className="flex items-center gap-1.5 px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-40"
              style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
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
              <p className="font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Connected Accounts</p>
            </div>
            {connectors.length === 0 ? (
              <div className="border border-dashed p-5 text-center" style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius)' }}>
                <AlertTriangle className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--muted)' }} />
                <p style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>No accounts connected yet.</p>
                <button onClick={() => navigate('/connectors')} className="mt-2 underline" style={{ fontSize: 'var(--text-tiny)', color: 'var(--accent)' }}>
                  Connect one in Connectors
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {(matchingConnectors.length > 0 ? matchingConnectors : connectors).map(c => {
                  const on = selectedConnectorIds.includes(c.id);
                  const platforms = platformsForConnector(c);
                  return (
                    <label key={c.id} className="flex items-center gap-3 p-3 border cursor-pointer"
                      style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--accent-bg)' : 'var(--card-bg)', borderRadius: 'var(--radius)' }}>
                      <input type="checkbox" checked={on} onChange={() => toggleConnector(c.id)} className="w-4 h-4" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{c.name}</p>
                        <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                          {platforms.length > 0 ? platforms.map(p => platformMeta(p).label).join(', ') : 'Unmapped connector'}
                        </p>
                      </div>
                      <span className="px-2 py-0.5 rounded-full border" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--muted)' }}>{c.status}</span>
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
                <p className="font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Knowledge Bases (optional)</p>
              </div>
              <div className="space-y-2">
                {knowledgeBases.map(kb => {
                  const on = selectedKbIds.includes(kb.id);
                  return (
                    <label key={kb.id} className="flex items-center gap-3 p-3 border cursor-pointer"
                      style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--accent-bg)' : 'var(--card-bg)', borderRadius: 'var(--radius)' }}>
                      <input type="checkbox" checked={on} onChange={() => toggleKb(kb.id)} className="w-4 h-4" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{kb.name}</p>
                      </div>
                      <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{kb.assetCount ?? kb.asset_count ?? 0} files</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(1)} className="px-4 py-2 border" style={{ fontSize: 'var(--text-small)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius)' }}>Back</button>
            <button onClick={() => setStep(3)} className="flex items-center gap-1.5 px-4 py-2 font-medium text-white hover:opacity-90" style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 3 && tpl && (
        <div className="space-y-5">
          {/* ── Basics ── */}
          <div className="space-y-3">
            <p className="font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Basics</p>
            <div>
              <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Agent Name *</label>
              <input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder={`e.g. ${tpl.name}`}
                className="w-full px-3 py-2 border" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} />
              <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Shows up wherever this agent's work appears — Posts, Run History, notifications.</p>
            </div>
            <div>
              <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Timezone</label>
              <select value={timezone} onChange={e => setTimezone(e.target.value)}
                className="w-full px-3 py-2 border" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
                {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
              <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Scheduled posts publish at the times you pick, in this timezone.</p>
            </div>
            <div>
              <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Instructions</label>
              {instructionsHint && <p className="mb-1.5 px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent-bg)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>{instructionsHint}</p>}
              <textarea value={overlay} onChange={e => setOverlay(e.target.value)} rows={4}
                placeholder="e.g. Write in a confident, concise tone. Focus on product launches and customer wins. Avoid discussing pricing or naming competitors."
                className="w-full px-3 py-2 border resize-none" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} />
              {overlay.trim().length > 0 && overlay.trim().length < 40 ? (
                <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--warning)' }}>
                  A bit more detail helps the agent sound like your brand — try mentioning tone, topics to focus on, or what to avoid.
                </p>
              ) : (
                <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>The more specific this is, the less editing you'll do later.</p>
              )}
            </div>
          </div>

          {/* ── Preview ── */}
          <div className="space-y-2 pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between pt-3">
              <p className="font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Preview</p>
              <button type="button" onClick={handlePreview} disabled={!overlay.trim() || previewLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 font-medium border disabled:opacity-40"
                style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
                <Wand2 className={`w-3.5 h-3.5 ${previewLoading ? 'animate-spin' : ''}`} style={{ color: 'var(--accent)' }} />
                {previewLoading ? 'Writing…' : preview ? 'Regenerate' : 'Preview a sample post'}
              </button>
            </div>
            {!overlay.trim() && (
              <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Write instructions above to preview what this agent would post.</p>
            )}
            {preview && (
              <div className="p-3 border" style={{ borderColor: 'var(--border)', background: 'var(--card-bg)', borderRadius: 'var(--radius-sm)' }}>
                <p style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{preview}</p>
                <p className="mt-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                  Approximate — the real agent may also draw on connected knowledge base docs.
                </p>
              </div>
            )}
            {previewUnavailable && (
              <p className="px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent-bg)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
                Preview isn't available for this dashboard yet — no AI model is configured for it. You can still create the agent; it'll write for real once one is set up.
              </p>
            )}
            {previewError && (
              <p className="px-3 py-2" style={{ fontSize: 'var(--text-tiny)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>{previewError}</p>
            )}
          </div>

          {/* ── Memory & Guardrails ── */}
          <div className="pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
            <button type="button" onClick={() => setShowMemory(v => !v)} className="w-full flex items-center justify-between pt-3">
              <span className="flex items-center gap-1.5 font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>
                <Brain className="w-3.5 h-3.5" /> Memory &amp; Guardrails {harnessChanged && <span style={{ color: 'var(--accent)' }}>· customized</span>}
              </span>
              <ChevronDown className="w-4 h-4 transition-transform" style={{ color: 'var(--muted)', transform: showMemory ? 'rotate(180deg)' : 'none' }} />
            </button>
            {!showMemory && (
              <p className="mt-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                Optional — controls what this agent remembers about its own past posts so it doesn't repeat itself. Sensible defaults apply either way.
              </p>
            )}
            {showMemory && (
              <div className="mt-2 space-y-3">
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
              </div>
            )}
          </div>

          {/* ── Schedule ── */}
          {scheduleCapable && (
            <div className="pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-1.5 mb-1.5 pt-3">
                <CalendarClock className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
                <label className="font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Posting Schedule</label>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {DAYS_OF_WEEK.map(d => {
                  const on = scheduleDays.includes(d.value);
                  return (
                    <button key={d.value} type="button"
                      onClick={() => setScheduleDays(prev => on ? prev.filter(v => v !== d.value) : [...prev, d.value])}
                      className="px-3 py-1.5 border transition-colors"
                      style={on ? { fontSize: 'var(--text-tiny)', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-sm)' } : { fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
              <select value={scheduleHour} onChange={e => setScheduleHour(Number(e.target.value))}
                className="w-full px-3 py-2 border" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                Started pre-filled at a working Mon/Wed/Fri cadence — adjust it, or clear every day to schedule manually later in Schedulers.
              </p>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(2)} className="px-4 py-2 border" style={{ fontSize: 'var(--text-small)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius)' }}>Back</button>
            <button onClick={() => agentName.trim() && setStep(4)} disabled={!agentName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
              Review <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 4 && tpl && (
        <div className="space-y-4">
          <div className="border p-4 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--card-bg)', borderRadius: 'var(--radius)' }}>
            <p className="font-semibold uppercase mb-1" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Summary</p>
            {[
              ['Name', agentName],
              ['Template', tpl.name],
              ['Timezone', timezone],
              ['Connected accounts', connectors.filter(c => selectedConnectorIds.includes(c.id)).map(c => c.name).join(', ') || 'None'],
              ['Knowledge Bases', String(selectedKbIds.length)],
              ['Memory settings', harnessSummary(harness)],
            ].map(([l, v]) => (
              <div key={l} className="flex gap-4" style={{ fontSize: 'var(--text-small)' }}><span className="w-32 shrink-0" style={{ color: 'var(--muted)' }}>{l}</span><span style={{ color: 'var(--text)' }}>{v}</span></div>
            ))}
            {scheduleCapable && scheduleDays.length > 0 && (
              <div className="flex gap-4" style={{ fontSize: 'var(--text-small)' }}>
                <span className="w-32 shrink-0" style={{ color: 'var(--muted)' }}>Will schedule</span>
                <span style={{ color: 'var(--text)' }}>
                  {connectors.filter(c => selectedConnectorIds.includes(c.id)).map(c => c.name).join(', ') || 'No account selected'}
                </span>
              </div>
            )}
            {preview && (
              <div className="flex gap-4" style={{ fontSize: 'var(--text-small)' }}>
                <span className="w-32 shrink-0" style={{ color: 'var(--muted)' }}>Preview</span>
                <span className="flex items-center gap-1" style={{ color: 'var(--success)' }}><Check className="w-3.5 h-3.5" /> Generated</span>
              </div>
            )}
          </div>
          {error && <p className="px-4 py-2" style={{ fontSize: 'var(--text-small)', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>{error}</p>}
          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(3)} className="px-4 py-2 border" style={{ fontSize: 'var(--text-small)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius)' }}>Back</button>
            <button onClick={launch} className="flex items-center gap-1.5 px-4 py-2 font-medium text-white hover:opacity-90" style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
              <Rocket className="w-4 h-4" /> Launch Agent
            </button>
          </div>
        </div>
      )}

        </div>
      </div>
    </div>
  );
}
