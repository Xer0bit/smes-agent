/**
 * 3-step onboarding wizard for connecting an eCG Agent org:
 *  1. Connect  paste the ecg_... API key, discovery only (no project yet).
 *  2. Confirm  proof of what was found + a password. Nothing else to
 *     configure here on purpose -- branding/theme/features are all
 *     post-creation settings (Settings -> Customizer), not onboarding
 *     friction. Simplified 2026-08-11: this step used to also ask for a
 *     dashboard name, logo, theme, accent color, a feature checklist, and
 *     an AI-assistant toggle -- all removed. Server-side defaults (light
 *     theme, every module, assistant on, name guessed from the org) apply
 *     silently; the in-editor Customizer is still there for anyone who
 *     wants to change them afterward.
 *  3. Provision  live SSE checklist while the dashboard project is built.
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

const PROVISION_STEPS: Array<{ id: string; label: string }> = [
  { id: 'discovery',            label: 'Verifying connection' },
  { id: 'project_created',      label: 'Creating project' },
  { id: 'password_protected',   label: 'Securing dashboard access' },
  { id: 'template_import',      label: 'Setting up base app' },
  { id: 'database_provisioned', label: 'Provisioning hosted database' },
  { id: 'edge_function_created', label: 'Creating server functions' },
  { id: 'template_functions_deployed', label: 'Deploying data functions' },
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

  // Confirm-step form -- deliberately just these two. Which of the org's
  // agents this dashboard manages defaults to all of them; a multi-agent
  // org can narrow it down, a single-agent org never sees this control at
  // all (see the confirm-step render below).
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState('');

  // Provision-step progress
  const [doneSteps, setDoneSteps] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

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
          // No agentType sent -- the server's own default (social-v2) is the
          // only dashboard this wizard creates now.
          // Without this the project is created with no organization at all,
          // which silently breaks every org-scoped paid-plan check later
          // (hosted database requires a Pro/Agency org  the check reads the
          // PROJECT's own organization_id, not whichever org is active in
          // the sidebar) regardless of whether the user's real org is paid.
          organizationId: currentOrganizationId ?? undefined,
          // No config sent -- appName/theme/logo all take the server's own
          // defaults (name guessed from the org, light theme, no logo).
          // Everything here is a Settings -> Customizer change later, not
          // an onboarding decision.
          modules: [],
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
            Paste your eCG Agent API key. We'll discover what's set up in your org, then
            you set a password and your dashboard is ready.
            Get a key from <a href="https://agents.SMEsAgent.ai/org/api-keys" target="_blank" rel="noopener noreferrer" className="text-foreground underline">agents.SMEsAgent.ai/org/api-keys</a>.
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

  // ── Step 2: Confirm ──────────────────────────────────────────────────────────
  if (step === 'confirm' && discovery) {
    return (
      <Card className="mx-auto max-w-lg rounded-xl border-border/60 bg-card/40">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold text-foreground">Connected to your org</h3>
          <p className="mt-1 text-xs text-muted-foreground">This is what your eCG Agent key gives access to.</p>

          {discovery.agents.length > 1 && (
            <>
              <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Which agents should this dashboard manage? ({selectedAgentIds.size}/{discovery.agents.length})
              </p>
              <div className="mt-2 space-y-2">
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
            </>
          )}
          {discovery.agents.length === 1 && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <Zap className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{discovery.agents[0]?.name ?? 'Agent'}</span>
            </div>
          )}
          {discovery.agents.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">No agents yet. The dashboard will still work.</p>
          )}

          {discovery.connectors.length > 0 && (
            <>
              <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Connectors ({discovery.connectors.length})</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {discovery.connectors.slice(0, 10).map((c: any, i: number) => (
                  <span key={c?.id ?? i} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-xs text-foreground">
                    <Plug className="h-3 w-3 text-muted-foreground" />{c?.name ?? c?.type ?? 'Connector'}
                  </span>
                ))}
              </div>
            </>
          )}

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

          <div className="mt-5">
            <label className="text-xs font-medium text-muted-foreground">Dashboard password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy && password.trim().length >= 6) handleCreate(); }}
              placeholder="Min 6 characters"
              className="mt-1 border-border/60 bg-card/60"
              autoFocus
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Visitors must enter this to open the dashboard. Required. Everything else
              (name, branding, features) can be changed later in Settings → Customizer.
            </p>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setStep('connect')}>← Back</Button>
            <Button onClick={handleCreate} disabled={busy || password.trim().length < 6 || (discovery.agents.length > 0 && selectedAgentIds.size === 0)} className="rounded-full gap-1.5">
              Create dashboard <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
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
