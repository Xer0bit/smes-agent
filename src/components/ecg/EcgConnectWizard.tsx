/**
 * 3-step onboarding wizard for connecting an eCG Agent org:
 *  1. Connect  paste the ecg_... API key, discovery only (no project yet).
 *  2. Confirm & brand  proof of what was found + name/logo/theme/modules.
 *  3. Provision  live SSE checklist while the dashboard project is built.
 *
 * The confirmed config feeds seedEcgTemplate() 1:1 and is stored in
 * project_settings.ecg_customizer, so the in-editor Customizer (dev agent)
 * can keep editing it after onboarding  this wizard stays minimal on purpose.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { getApiServerUrl } from '@/config/external-api';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Loader2, ArrowRight, Check, Circle, Plug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Discovery {
  agents: any[];
  connectors: any[];
  platforms: any[];
}

// Mirrors THEME_DEFAULTS in server/src/services/ecg-template.ts  the seeder
// resolves colors server-side; these values only drive the wizard preview.
const THEMES = [
  { key: 'light',  label: 'Light',  accent: '#2563eb', sidebar: '#161c3d', body: '#f4f5f7' },
  { key: 'dark',   label: 'Dark',   accent: '#60a5fa', sidebar: '#111827', body: '#030712' },
  { key: 'ocean',  label: 'Ocean',  accent: '#0ea5c9', sidebar: '#0c3d5e', body: '#eef8fc' },
  { key: 'forest', label: 'Forest', accent: '#16a34a', sidebar: '#16301f', body: '#eef8f0' },
  { key: 'sunset', label: 'Sunset', accent: '#ea580c', sidebar: '#6b2810', body: '#fef3ea' },
  { key: 'slate',  label: 'Slate',  accent: '#7c3aed', sidebar: '#293548', body: '#f4f5f7' },
] as const;

// Plain-language descriptions, not just the raw module key -- whoever builds
// this dashboard may not know what "Schedulers" or "Run History" means to
// the person who'll actually use it day to day.
const MODULES = [
  { key: 'agents',     label: 'AI Agents',        hint: 'The AI workers that write posts', core: true },
  { key: 'posts',      label: 'Posts & Approvals', hint: 'Review, edit, and approve what gets published', core: true },
  { key: 'connectors', label: 'Connected Accounts', hint: 'Link LinkedIn, Instagram, Facebook, etc.', core: true },
  { key: 'schedulers', label: 'Posting Schedule',  hint: 'When and how often agents post', core: false },
  { key: 'knowledge',  label: 'Business Knowledge', hint: 'Teach agents about the business', core: false },
  { key: 'runs',       label: 'Activity Log',      hint: 'Technical history of every agent run', core: false },
] as const;

const SIMPLE_MODULES = MODULES.filter((m) => m.core).map((m) => m.key);
const ALL_MODULE_KEYS = MODULES.map((m) => m.key);

type SetupType = 'simple' | 'advanced' | 'custom';

const PROVISION_STEPS: Array<{ id: string; label: string }> = [
  { id: 'discovery',            label: 'Verifying connection' },
  { id: 'project_created',      label: 'Creating project' },
  { id: 'password_protected',   label: 'Securing dashboard access' },
  { id: 'template_import',      label: 'Setting up base app' },
  { id: 'database_provisioned', label: 'Provisioning hosted database' },
  { id: 'edge_function_created', label: 'Creating server functions' },
  { id: 'template_seeded',      label: 'Building your dashboard' },
  { id: 'revision_saved',       label: 'Saving dashboard' },
  { id: 'preview_synced',       label: 'Syncing live preview' },
];

export default function EcgConnectWizard({ emptyState }: { emptyState: boolean }) {
  const navigate = useNavigate();
  const { currentOrganizationId } = useOrganization();
  const [step, setStep] = useState<'connect' | 'confirm' | 'provision'>('connect');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  // Confirm-step form
  // Which of the org's agents this dashboard manages -- defaults to all of
  // them (matches the previous implicit "every agent" behavior) so existing
  // single-agent orgs see no change; multi-agent orgs can narrow it down.
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [appName, setAppName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [themeKey, setThemeKey] = useState<string>('light');
  const [accent, setAccent] = useState('');
  const [modules, setModules] = useState<string[]>(ALL_MODULE_KEYS);
  const [setupType, setSetupType] = useState<SetupType>('advanced');
  const [assistantEnabled, setAssistantEnabled] = useState(true);
  const [password, setPassword] = useState('');

  // Provision-step progress
  const [doneSteps, setDoneSteps] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const theme = THEMES.find((t) => t.key === themeKey) ?? THEMES[0];
  const previewAccent = accent || theme.accent;

  const authHeader = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
  };

  const handleDiscover = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/ecg-dev-agent/discover'), {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      setDiscovery(data);
      setSelectedAgentIds(new Set((data.agents ?? []).map((a: any) => a?.id).filter(Boolean)));
      const guess = data.agents?.[0]?.orgName || data.agents?.[0]?.name || 'eCG Agent';
      setAppName(`${guess} Dashboard`);
      setStep('confirm');
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not verify eCG Agent key');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setStep('provision');
    setProvisionError(null);
    setDoneSteps(new Set());
    try {
      const res = await fetch(getApiServerUrl('/api/v1/ecg-dev-agent'), {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          password: password.trim() || undefined,
          // Without this the project is created with no organization at all,
          // which silently breaks every org-scoped paid-plan check later
          // (hosted database requires a Pro/Agency org  the check reads the
          // PROJECT's own organization_id, not whichever org is active in
          // the sidebar) regardless of whether the user's real org is paid.
          organizationId: currentOrganizationId ?? undefined,
          config: {
            appName: appName.trim() || undefined,
            logoUrl: logoUrl.trim() || undefined,
            theme: themeKey,
            ...(accent ? { accentColor: accent } : {}),
            // Same moduleSettings.chat.enabled key CustomizerSettings.tsx
            // writes post-creation -- only sent when turned off, since
            // Layout.tsx already defaults to shown when this is absent.
            ...(assistantEnabled ? {} : { moduleSettings: { chat: { enabled: false } } }),
          },
          // All six selected means "everything"  same as the seeder default.
          modules: modules.length === MODULES.length ? [] : modules,
          // Which of the org's agents this dashboard is scoped to (+ names for
          // the in-dashboard agent switcher) -- omitted entirely when every
          // discovered agent is selected, so the server's own "all agents"
          // fallback behavior stays the single source of truth for that case.
          ...(discovery && selectedAgentIds.size > 0 && selectedAgentIds.size < discovery.agents.length
            ? {
                selectedAgentIds: Array.from(selectedAgentIds),
                agentNames: Object.fromEntries(
                  discovery.agents
                    .filter((a: any) => selectedAgentIds.has(a?.id))
                    .map((a: any) => [a.id, a?.name ?? 'Agent']),
                ),
              }
            : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let newProjectId: string | null = null;
      let failMessage: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const chunk of events) {
          const eventMatch = /event: (\w+)/.exec(chunk);
          const dataMatch = /data: (.*)/.exec(chunk);
          if (!eventMatch || !dataMatch) continue;
          const payload = JSON.parse(dataMatch[1]);
          if (eventMatch[1] === 'step') {
            setDoneSteps((prev) => new Set(prev).add(payload.id));
          } else if (eventMatch[1] === 'done') {
            newProjectId = payload.projectId;
          } else if (eventMatch[1] === 'error') {
            failMessage = payload.message;
          }
        }
      }

      if (failMessage) throw new Error(failMessage);
      if (!newProjectId) throw new Error('Provisioning finished without a project. Please try again.');
      setProjectId(newProjectId);
      toast.success('eCG Agent dashboard is ready');
    } catch (err: any) {
      setProvisionError(err?.message ?? 'Failed to create the dashboard');
    } finally {
      setBusy(false);
    }
  };

  // ── Step 1: Connect ─────────────────────────────────────────────────────────
  if (step === 'connect') {
    return (
      <Card className="rounded-xl border-dashed border-border/60 bg-card/40">
        <CardContent className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h3 className="font-display text-xl font-semibold text-foreground">
            {emptyState ? 'No eCG Agent connected yet' : 'Connect another eCG Agent'}
          </h3>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Paste your eCG Agent API key. We'll discover what's set up in your org, then you
            confirm the dashboard's name, branding and features before anything is created.
            Get a key from <span className="text-foreground">app.ecomgear.ai/org/api-keys</span>.
          </p>
          <div className="mt-6 flex w-full max-w-sm items-center gap-2">
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) handleDiscover(); }}
              placeholder="ecg_..."
              disabled={busy}
              className="rounded-full border-border/60 bg-card/60"
            />
            <Button onClick={handleDiscover} disabled={!apiKey.trim() || busy} className="rounded-full gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Checking…' : 'Connect'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Step 2: Confirm & brand ─────────────────────────────────────────────────
  if (step === 'confirm' && discovery) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left: what we found  real discovery data only */}
        <Card className="rounded-xl border-border/60 bg-card/40">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold text-foreground">Connected to your org</h3>
            <p className="mt-1 text-xs text-muted-foreground">This is what your eCG Agent key gives access to.</p>

            <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Which agents should this dashboard manage? ({selectedAgentIds.size}/{discovery.agents.length})
            </p>
            <div className="mt-2 space-y-2">
              {discovery.agents.length === 0 && <p className="text-xs text-muted-foreground">No agents yet. The dashboard will still work.</p>}
              {discovery.agents.map((a: any, i: number) => {
                const id = a?.id ?? String(i);
                const checked = selectedAgentIds.has(id);
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelectedAgentIds((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(id); else next.add(id);
                        return next;
                      })}
                      className="accent-[var(--primary)]"
                    />
                    <Zap className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{a?.name ?? 'Agent'}</span>
                    {a?.status && <span className="text-xs text-muted-foreground">{a.status}</span>}
                  </label>
                );
              })}
            </div>

            <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Connectors ({discovery.connectors.length})</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {discovery.connectors.length === 0 && <p className="text-xs text-muted-foreground">None connected yet.</p>}
              {discovery.connectors.slice(0, 10).map((c: any, i: number) => (
                <span key={c?.id ?? i} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-xs text-foreground">
                  <Plug className="h-3 w-3 text-muted-foreground" />{c?.name ?? c?.type ?? 'Connector'}
                </span>
              ))}
            </div>

            {discovery.platforms.length > 0 && (
              <>
                <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Platforms</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {discovery.platforms.map((p: any, i: number) => (
                    <span key={i} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
                      {typeof p === 'string' ? p : p?.name ?? p?.platform ?? 'platform'}
                    </span>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Right: branding + live mini preview */}
        <Card className="rounded-xl border-border/60 bg-card/40">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold text-foreground">Your dashboard</h3>

            {/* Mini preview  abstract blocks in the chosen theme */}
            <div className="mt-3 overflow-hidden rounded-lg border border-border/60" style={{ background: theme.body }}>
              <div className="flex h-28">
                <div className="w-16 shrink-0 p-2" style={{ background: theme.sidebar }}>
                  <div className="h-2 w-8 rounded-sm" style={{ background: previewAccent }} />
                  <div className="mt-2 space-y-1.5">
                    {[0, 1, 2, 3].map((i) => <div key={i} className="h-1.5 w-10 rounded-sm bg-white/20" />)}
                  </div>
                </div>
                <div className="flex-1 p-3">
                  <div className="flex items-center gap-2">
                    {logoUrl && <img src={logoUrl} alt="" className="h-5 w-5 rounded-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                    <div className="h-2.5 w-24 rounded-sm" style={{ background: previewAccent }} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((i) => <div key={i} className="h-8 rounded-md bg-black/10" style={{ background: theme.key === 'dark' ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)' }} />)}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Dashboard name</label>
                <Input value={appName} onChange={(e) => setAppName(e.target.value)} className="mt-1 border-border/60 bg-card/60" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Logo URL (optional)</label>
                <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" className="mt-1 border-border/60 bg-card/60" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Theme</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {THEMES.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => { setThemeKey(t.key); setAccent(''); }}
                      title={t.label}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition-colors',
                        themeKey === t.key ? 'border-primary text-foreground' : 'border-border/60 text-muted-foreground hover:border-border',
                      )}
                    >
                      <span className="flex overflow-hidden rounded-full border border-border/40">
                        <span className="h-3 w-2" style={{ background: t.sidebar }} />
                        <span className="h-3 w-2" style={{ background: t.body }} />
                        <span className="h-3 w-2" style={{ background: t.accent }} />
                      </span>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">Accent</label>
                <input
                  type="color"
                  value={previewAccent}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border border-border/60 bg-transparent"
                />
                {accent && (
                  <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setAccent('')}>
                    reset
                  </button>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Dashboard password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="mt-1 border-border/60 bg-card/60"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Visitors must enter this to open the dashboard. Required.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Who is this dashboard for?</label>
                <div className="mt-1.5 flex gap-2">
                  <button type="button"
                    onClick={() => { setSetupType('simple'); setModules(SIMPLE_MODULES); }}
                    className={cn('flex-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                      setupType === 'simple' ? 'border-primary bg-primary/5 text-foreground' : 'border-border/60 text-muted-foreground hover:border-border')}>
                    <span className="block font-medium text-foreground">Simple</span>
                    Just the essentials  approve posts, connect accounts. Fewest things to learn.
                  </button>
                  <button type="button"
                    onClick={() => { setSetupType('advanced'); setModules(ALL_MODULE_KEYS); }}
                    className={cn('flex-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                      setupType === 'advanced' ? 'border-primary bg-primary/5 text-foreground' : 'border-border/60 text-muted-foreground hover:border-border')}>
                    <span className="block font-medium text-foreground">Advanced</span>
                    Everything, including scheduling, run logs and knowledge tuning.
                  </button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Features</label>
                  {setupType === 'custom' && <span className="text-[11px] text-muted-foreground">Custom selection</span>}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {MODULES.map((m) => {
                    const checked = modules.includes(m.key);
                    return (
                      <label key={m.key} title={m.hint}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => { setSetupType('custom'); setModules((prev) => checked ? prev.filter((k) => k !== m.key) : [...prev, m.key]); }}
                          className="mt-0.5 accent-[var(--primary)]"
                        />
                        <span className="min-w-0">
                          <span className="block leading-tight">{m.label}</span>
                          <span className="block text-[11px] leading-tight text-muted-foreground">{m.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 cursor-pointer">
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">AI Assistant</span>
                  <span className="block text-[11px] leading-tight text-muted-foreground">
                    A chat panel that can read and act on the user's behalf. Turn off if you'd rather they only use the regular pages.
                  </span>
                </span>
                <input type="checkbox" checked={assistantEnabled} onChange={(e) => setAssistantEnabled(e.target.checked)}
                  className="accent-[var(--primary)] shrink-0" />
              </label>
            </div>

            <div className="mt-5 flex items-center justify-between">
              <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setStep('connect')}>← Back</Button>
              <Button onClick={handleCreate} disabled={busy || modules.length === 0 || password.trim().length < 6 || (discovery.agents.length > 0 && selectedAgentIds.size === 0)} className="rounded-full gap-1.5">
                Create dashboard <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Step 3: Provision ───────────────────────────────────────────────────────
  return (
    <Card className="rounded-xl border-border/60 bg-card/40">
      <CardContent className="mx-auto max-w-md py-12">
        <h3 className="text-center font-display text-lg font-semibold text-foreground">
          {projectId ? 'Dashboard ready' : provisionError ? 'Something went wrong' : 'Building your dashboard…'}
        </h3>
        <div className="mt-6 space-y-2.5">
          {PROVISION_STEPS.map((s) => {
            const done = doneSteps.has(s.id);
            return (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                {done
                  ? <Check className="h-4 w-4 shrink-0 text-primary" />
                  : provisionError
                    ? <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                    : <Loader2 className={cn('h-4 w-4 shrink-0', busy ? 'animate-spin text-muted-foreground' : 'text-muted-foreground/40')} />}
                <span className={done ? 'text-foreground' : 'text-muted-foreground'}>{s.label}</span>
              </div>
            );
          })}
        </div>
        {provisionError && (
          <>
            <p className="mt-5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{provisionError}</p>
            <Button variant="outline" className="mt-4 w-full rounded-full" onClick={() => setStep('confirm')}>Back to settings</Button>
          </>
        )}
        {projectId && (
          <>
            <Button className="mt-6 w-full rounded-full gap-1.5" onClick={() => navigate(`/project/${projectId}`)}>
              Open dashboard <ArrowRight className="h-4 w-4" />
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Your dashboard is a full project: edit any page with the dev agent, or change
              branding anytime in Settings → Customizer.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
