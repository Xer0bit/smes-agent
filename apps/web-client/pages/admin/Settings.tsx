import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { adminLlmService, type LlmProvider, type LlmStatus } from '@/services/adminLlmService';
import { Page, Stats, Panel, Table, Dot, Tag, btn, input, when } from '@/components/admin/ui';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROVIDERS: Array<{ id: LlmProvider; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'zai', label: 'z.ai' },
];
const EMPTY_KEYS: Record<LlmProvider, string> = { anthropic: '', deepseek: '', gemini: '', zai: '' };
const SELECT = 'h-8 text-xs bg-transparent border-white/10 text-white';
const isProvider = (v: string): v is LlmProvider => PROVIDERS.some((p) => p.id === v);

function normalizeModelId(value: string): string {
  return value.trim().replace(/[}\],;]+$/g, '').trim();
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface RuntimeServerStatus {
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; freeMB: number; totalMB: number };
  cpu: { model: string; cores: number; loadAvg: number[] };
  pid: number;
  env: string;
}

type TestResults = Record<string, { ok: boolean; reason: string; testedAt: string }>;

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeServerStatus | null>(null);
  const [testResults, setTestResults] = useState<TestResults | null>(null);
  const [keys, setKeys] = useState(EMPTY_KEYS);
  const [newModelId, setNewModelId] = useState('');
  const [newModelProvider, setNewModelProvider] = useState<LlmProvider>('anthropic');

  const load = async () => {
    setLoading(true);
    try {
      const [data, server] = await Promise.all([adminLlmService.getStatus(), adminLlmService.getServerStatus()]);
      setStatus(data);
      setRuntime(server);
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const persist = async (next: LlmStatus, okText: string) => {
    setSyncing(true);
    setStatus(next);
    try {
      setStatus(await adminLlmService.saveStatus(next));
      toast.success(okText);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to sync LLM settings');
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const applyModels = async (fn: () => Promise<LlmStatus>, okText: string) => {
    setSyncing(true);
    try {
      setStatus(await fn());
      toast.success(okText);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setSyncing(false);
    }
  };

  const runProviderTest = async () => {
    setTesting(true);
    try {
      setTestResults(await adminLlmService.testProviders());
      await load();
      toast.success('Provider test complete');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Provider test failed');
    } finally {
      setTesting(false);
    }
  };

  if (!status) {
    return <Page title="LLM"><div className="text-[13px] text-gray-500">{loading ? 'Loading' : 'Unavailable'}</div></Page>;
  }

  const { providers, models } = status;
  const providerConfig = (p: LlmProvider) => (p === 'zai' ? providers.zai : providers[p]);
  const isGlmExperiment = models.primary.toLowerCase().startsWith('glm');
  const freeModel = models.freeModel || models.fallback;
  const hasKeyInput = PROVIDERS.some((p) => keys[p.id]);

  const setProviderEnabled = (p: LlmProvider, enabled: boolean) => {
    const next: LlmStatus['providers'] = { ...providers };
    if (p === 'anthropic') next.anthropic = { ...providers.anthropic, enabled };
    else if (p === 'deepseek') next.deepseek = { ...providers.deepseek, enabled };
    else if (p === 'gemini') next.gemini = { ...providers.gemini, enabled };
    else next.zai = { ...providers.zai, enabled };
    return persist({ ...status, providers: next }, `${p} ${enabled ? 'enabled' : 'disabled'}`);
  };

  const setFallbackEnabled = (fallbackEnabled: boolean) =>
    persist({ ...status, providers: { ...providers, deepseek: { ...providers.deepseek, fallbackEnabled } } }, `Fallback ${fallbackEnabled ? 'enabled' : 'disabled'}`);

  const toggleGlmExperiment = (enable: boolean) =>
    persist(
      {
        ...status,
        models: enable
          ? { ...models, primary: 'glm-5.2', fallback: 'glm-5', freeModel: 'glm-4.7-flash' }
          : { ...models, primary: 'gemini-3.1-pro-preview', fallback: 'deepseek-chat', freeModel: 'gemini-flash-latest' },
      },
      enable ? 'Switched to GLM' : 'Reverted to Gemini',
    );

  const setModel = (slot: 'primary' | 'fallback' | 'freeModel', id: string) =>
    persist({ ...status, models: { ...models, [slot]: id } }, `${slot} model updated`);

  const saveApiKeys = async () => {
    await persist(
      {
        ...status,
        apiKeys: {
          anthropic: keys.anthropic || undefined,
          deepseek: keys.deepseek || undefined,
          gemini: keys.gemini || undefined,
          zai: keys.zai || undefined,
        },
      },
      'API keys updated',
    );
    setKeys(EMPTY_KEYS);
  };

  const addModel = () => {
    const id = normalizeModelId(newModelId);
    if (!id) return void toast.error('Model ID is required');
    if (!MODEL_ID_RE.test(id)) return void toast.error('Invalid model ID');
    setNewModelId(id);
    return applyModels(async () => {
      const next = await adminLlmService.addModel(id, newModelProvider);
      setNewModelId('');
      return next;
    }, 'Model added');
  };

  const removeModel = (id: string) => {
    if (id === models.primary || id === models.fallback || id === freeModel) return void toast.error('Model is in use');
    return applyModels(() => adminLlmService.removeModel(id), 'Model removed');
  };

  const modelSelect = (value: string, onChange: (id: string) => void) => (
    <Select value={value} onValueChange={onChange} disabled={syncing}>
      <SelectTrigger className={SELECT}><SelectValue /></SelectTrigger>
      <SelectContent>{models.allowed.map((m) => <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>)}</SelectContent>
    </Select>
  );

  return (
    <Page
      title="LLM"
      actions={
        <>
          <span className="text-[11px] text-gray-500">{syncing ? 'Syncing' : `Synced ${when(status.updatedAt)}`}</span>
          <button type="button" className={btn.ghost} onClick={() => void load()} disabled={loading || syncing}>Refresh</button>
          <button type="button" className={btn.primary} onClick={() => void runProviderTest()} disabled={testing || syncing}>{testing ? 'Testing' : 'Test providers'}</button>
        </>
      }
    >
      {runtime && (
        <Stats
          items={[
            { label: 'Env', value: runtime.env, tone: runtime.env === 'production' ? 'ok' : 'warn' },
            { label: 'Uptime', value: formatUptime(runtime.uptimeSeconds) },
            { label: 'Node', value: runtime.nodeVersion },
            { label: 'CPU', value: `${runtime.cpu.cores} cores / ${(runtime.cpu.loadAvg[0] ?? 0).toFixed(2)}` },
            { label: 'Heap MB', value: `${runtime.memory.heapUsedMB} / ${runtime.memory.heapTotalMB}` },
            { label: 'RAM free MB', value: `${runtime.memory.freeMB} / ${runtime.memory.totalMB}` },
          ]}
        />
      )}

      <Panel title="Providers">
        <Table head={['Provider', 'Key', 'Enabled']}>
          {PROVIDERS.map((p) => {
            const cfg = providerConfig(p.id);
            return (
              <tr key={p.id}>
                <td>{p.label}</td>
                <td><Dot tone={cfg?.keyConfigured ? 'ok' : 'off'} /></td>
                <td><Switch checked={Boolean(cfg?.enabled)} onCheckedChange={(v) => void setProviderEnabled(p.id, v)} disabled={syncing} /></td>
              </tr>
            );
          })}
          <tr>
            <td>Anthropic to DeepSeek fallback</td>
            <td />
            <td><Switch checked={Boolean(providers.deepseek.fallbackEnabled)} onCheckedChange={(v) => void setFallbackEnabled(v)} disabled={syncing} /></td>
          </tr>
          <tr>
            <td>GLM experiment</td>
            <td />
            <td><Switch checked={isGlmExperiment} onCheckedChange={(v) => void toggleGlmExperiment(v)} disabled={syncing} /></td>
          </tr>
        </Table>
      </Panel>

      {testResults && (
        <Panel title="Test results">
          <Table head={['Provider', 'Status', 'Reason', 'Tested']}>
            {Object.entries(testResults).map(([provider, r]) => (
              <tr key={provider}>
                <td>{provider}</td>
                <td><Tag tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'ok' : 'fail'}</Tag></td>
                <td className="text-gray-400">{r.reason}</td>
                <td className="text-gray-500">{when(r.testedAt)}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      <Panel title="API keys" actions={<button type="button" className={btn.primary} onClick={() => void saveApiKeys()} disabled={syncing || !hasKeyInput}>Save</button>}>
        <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2">
          {PROVIDERS.map((p) => (
            <label key={p.id} className="text-[11px] text-gray-500 space-y-1">
              <span>{p.label}</span>
              <input
                type="password"
                className={input}
                placeholder={providerConfig(p.id)?.keyConfigured ? 'configured' : ''}
                value={keys[p.id]}
                onChange={(e) => setKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="Routing">
        <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          <label className="text-[11px] text-gray-500 space-y-1"><span>Primary</span>{modelSelect(models.primary, (id) => void setModel('primary', id))}</label>
          <label className="text-[11px] text-gray-500 space-y-1"><span>Free tier</span>{modelSelect(freeModel, (id) => void setModel('freeModel', id))}</label>
          <label className="text-[11px] text-gray-500 space-y-1"><span>Fallback</span>{modelSelect(models.fallback, (id) => void setModel('fallback', id))}</label>
        </div>
      </Panel>

      <Panel
        title="Models"
        actions={
          <>
            <input className={input} placeholder="model id" value={newModelId} onChange={(e) => setNewModelId(e.target.value)} disabled={syncing} />
            <Select value={newModelProvider} onValueChange={(v) => { if (isProvider(v)) setNewModelProvider(v); }} disabled={syncing}>
              <SelectTrigger className={SELECT}><SelectValue /></SelectTrigger>
              <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>)}</SelectContent>
            </Select>
            <button type="button" className={btn.primary} onClick={() => void addModel()} disabled={syncing}>Add</button>
          </>
        }
      >
        <Table head={['Model', 'Provider', '']} empty="No models">
          {models.allowed.map((m) => (
            <tr key={m.id}>
              <td className="font-mono">{m.id}</td>
              <td><Tag>{m.provider}</Tag></td>
              <td className="text-right"><button type="button" className={btn.danger} onClick={() => void removeModel(m.id)} disabled={syncing}>Remove</button></td>
            </tr>
          ))}
        </Table>
      </Panel>
    </Page>
  );
}
