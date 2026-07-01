import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Trash2, KeyRound, RefreshCw, CheckCircle2, FlaskConical, XCircle, Server, Cpu, Beaker } from 'lucide-react';
import { toast } from 'sonner';
import { adminLlmService, type LlmProvider, type LlmStatus } from '@/services/adminLlmService';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalizeModelId(input: string): string {
  return input
    .trim()
    .replace(/[}\],;]+$/g, '')
    .trim();
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

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelProvider, setNewModelProvider] = useState<LlmProvider>('anthropic');
  const [apiKeys, setApiKeys] = useState<{ anthropic: string; deepseek: string; gemini: string; zai: string }>({
    anthropic: '',
    deepseek: '',
    gemini: '',
    zai: '',
  });
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; reason: string; testedAt: string }> | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeServerStatus | null>(null);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const [data, runtime] = await Promise.all([
        adminLlmService.getStatus(),
        adminLlmService.getServerStatus(),
      ]);
      setStatus(data);
      setRuntimeStatus(runtime);
      setLastSyncedAt(data.updatedAt);
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const persistStatus = async (next: LlmStatus, successText = 'LLM settings synced') => {
    setSyncing(true);
    setStatus(next);
    try {
      const saved = await adminLlmService.saveStatus(next);
      setStatus(saved);
      setLastSyncedAt(saved.updatedAt);
      toast.success(successText);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to sync LLM settings');
      await loadSettings();
    } finally {
      setSyncing(false);
    }
  };

  const runProviderTest = async () => {
    setTesting(true);
    try {
      const results = await adminLlmService.testProviders();
      setTestResults(results);
      await loadSettings(); // refresh provider enabled states
      toast.success('Provider test complete — states updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Provider test failed');
    } finally {
      setTesting(false);
    }
  };

  const saveApiKeys = async () => {
    if (!status) return;
    const updates = {
      apiKeys: {
        anthropic: apiKeys.anthropic || undefined,
        deepseek: apiKeys.deepseek || undefined,
        gemini: apiKeys.gemini || undefined,
        zai: apiKeys.zai || undefined,
      }
    };
    await persistStatus({ ...status, ...updates }, 'API Keys updated securely');
    setApiKeys({ anthropic: '', deepseek: '', gemini: '', zai: '' });
  };

  const isGlmExperiment = status?.models.primary?.toLowerCase().startsWith('glm') ?? false;

  const toggleGlmExperiment = async (enable: boolean) => {
    if (!status) return;
    if (enable) {
      await persistStatus({
        ...status,
        models: { ...status.models, primary: 'glm-5.2', fallback: 'glm-5', freeModel: 'glm-4.7-flash' },
      }, 'Switched to GLM experiment (z.ai)');
    } else {
      await persistStatus({
        ...status,
        models: { ...status.models, primary: 'gemini-3.1-pro-preview', fallback: 'deepseek-chat', freeModel: 'gemini-2.5-flash' },
      }, 'Reverted to Gemini primary model');
    }
  };

  const setZaiEnabled = async (enabled: boolean) => {
    if (!status) return;
    await persistStatus({
      ...status,
      providers: { ...status.providers, zai: { ...(status.providers.zai ?? {}), enabled } },
    }, `z.ai (GLM) ${enabled ? 'enabled' : 'disabled'}`);
  };

  const availableModelIds = useMemo(
    () => (status?.models.allowed || []).map((item) => item.id),
    [status]
  );

  const setProviderEnabled = async (provider: LlmProvider, enabled: boolean) => {
    if (!status) return;
    if (provider === 'anthropic') {
      await persistStatus({
        ...status,
        providers: {
          ...status.providers,
          anthropic: { ...status.providers.anthropic, enabled },
        },
      }, `Anthropic ${enabled ? 'enabled' : 'disabled'}`);
      return;
    }

    if (provider === 'gemini') {
      await persistStatus({
        ...status,
        providers: {
          ...status.providers,
          gemini: { ...status.providers.gemini, enabled },
        },
      }, `Gemini ${enabled ? 'enabled' : 'disabled'}`);
      return;
    }

    await persistStatus({
      ...status,
      providers: {
        ...status.providers,
        deepseek: { ...status.providers.deepseek, enabled },
      },
    }, `DeepSeek ${enabled ? 'enabled' : 'disabled'}`);
  };

  const setFallbackEnabled = async (enabled: boolean) => {
    if (!status) return;
    await persistStatus({
      ...status,
      providers: {
        ...status.providers,
        deepseek: { ...status.providers.deepseek, fallbackEnabled: enabled },
      },
    }, `Fallback ${enabled ? 'enabled' : 'disabled'}`);
  };

  const setPrimaryModel = async (modelId: string) => {
    if (!status) return;
    await persistStatus({ ...status, models: { ...status.models, primary: modelId } }, 'Primary model updated');
  };

  const setFallbackModel = async (modelId: string) => {
    if (!status) return;
    await persistStatus({ ...status, models: { ...status.models, fallback: modelId } }, 'Fallback model updated');
  };

  const setFreeModel = async (modelId: string) => {
    if (!status) return;
    await persistStatus({ ...status, models: { ...status.models, freeModel: modelId } }, 'Free user model updated');
  };

  const addModel = async () => {
    const normalized = normalizeModelId(newModelId);
    if (!normalized) {
      toast.error('Model ID is required');
      return;
    }
    if (!MODEL_ID_RE.test(normalized)) {
      toast.error('Invalid model ID. Use letters, numbers, and . _ : / - only.');
      return;
    }

    // Keep input synchronized with what we actually submit.
    if (normalized !== newModelId) {
      setNewModelId(normalized);
    }

    try {
      setSyncing(true);
      const next = await adminLlmService.addModel(normalized, newModelProvider);
      setStatus(next);
      setLastSyncedAt(next.updatedAt);
      setNewModelId('');
      toast.success('Model added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add model');
    } finally {
      setSyncing(false);
    }
  };

  const removeModel = async (id: string) => {
    if (!status) return;
    if (id === status.models.primary || id === status.models.fallback || id === (status.models.freeModel || status.models.fallback)) {
      toast.error('Cannot remove active primary, fallback, or free-tier model');
      return;
    }
    try {
      setSyncing(true);
      const next = await adminLlmService.removeModel(id);
      setStatus(next);
      setLastSyncedAt(next.updatedAt);
      toast.success('Model removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove model');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border p-4 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <div className="flex items-center gap-2 text-xs text-gray-300">
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
          {syncing ? 'Syncing LLM control with server...' : `Synced${lastSyncedAt ? ` at ${new Date(lastSyncedAt).toLocaleTimeString()}` : ''}`}
        </div>
        <Button variant="outline" size="sm" onClick={loadSettings} disabled={loading || syncing} className="h-8 gap-2 border-white/10 bg-white/5 text-gray-200 hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* ── Experiments ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border p-6" style={{ background: 'rgba(99,102,241,0.04)', borderColor: 'rgba(99,102,241,0.25)' }}>
        <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
          <Beaker className="h-4 w-4 text-indigo-400" />
          Experiments
        </h3>
        <p className="text-xs text-gray-500 mb-5">Toggle experimental model families on or off. Switching off reverts all three model slots to the previous Gemini defaults.</p>
        <div className="flex items-center justify-between py-1">
          <div>
            <Label className="text-gray-300 text-xs font-medium">GLM / z.ai Experiment</Label>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {isGlmExperiment
                ? <>Active — primary: <span className="font-mono text-indigo-300">{status?.models.primary}</span>, fallback: <span className="font-mono text-indigo-300">{status?.models.fallback}</span></>
                : 'Off — using Gemini primary (gemini-3.1-pro-preview)'}
            </p>
          </div>
          <Switch
            checked={isGlmExperiment}
            onCheckedChange={(v) => void toggleGlmExperiment(v)}
            disabled={syncing}
          />
        </div>
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
          <Server className="h-4 w-4 text-purple-400" />
          Gen/API Runtime (Production)
        </h3>
        <p className="text-xs text-gray-500 mb-4">Live runtime details from the active production API server.</p>
        {runtimeStatus ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500">Environment</span><span className={runtimeStatus.env === 'production' ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>{runtimeStatus.env}</span></div>
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500">Uptime</span><span className="text-white font-medium">{formatUptime(runtimeStatus.uptimeSeconds)}</span></div>
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500">Node</span><span className="text-white font-mono">{runtimeStatus.nodeVersion}</span></div>
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500 flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span><span className="text-white">{runtimeStatus.cpu.cores} cores · load {runtimeStatus.cpu.loadAvg[0]?.toFixed(2)}</span></div>
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500">Heap</span><span className="text-white">{runtimeStatus.memory.heapUsedMB} / {runtimeStatus.memory.heapTotalMB} MB</span></div>
            <div className="flex justify-between rounded-lg bg-white/[0.02] p-3"><span className="text-gray-500">RAM free</span><span className="text-white">{runtimeStatus.memory.freeMB} / {runtimeStatus.memory.totalMB} MB</span></div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Server runtime details unavailable.</p>
        )}
      </div>

      {/* ── API Health Check ── */}
      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-white">API Health Check</h3>
          <Button onClick={runProviderTest} disabled={testing || syncing} size="sm" className="h-8 gap-2 bg-purple-600 hover:bg-purple-700 text-white text-xs">
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
            {testing ? 'Testing…' : 'Test All Providers'}
          </Button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Runs a live API call against each provider. Passing providers are enabled; failing ones are disabled automatically.</p>
        {testResults && (
          <div className="space-y-2">
            {Object.entries(testResults).map(([provider, result]) => (
              <div key={provider} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: result.ok ? 'rgba(52,211,153,0.2)' : 'rgba(239,68,68,0.2)', background: result.ok ? 'rgba(52,211,153,0.04)' : 'rgba(239,68,68,0.04)' }}>
                <div className="flex items-center gap-2">
                  {result.ok
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                  <span className="text-xs text-white capitalize font-medium">{provider}</span>
                  <span className="text-[11px] text-gray-500">— {result.reason}</span>
                </div>
                <span className="text-[10px] text-gray-600">{new Date(result.testedAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <h3 className="text-sm font-semibold text-white mb-1">LLM Provider Controls</h3>
        <p className="text-xs text-gray-500 mb-5">Enable or disable providers and fallback behavior globally.</p>
        <div className="space-y-5">
          <div className="flex items-center justify-between py-1">
            <div>
              <Label className="text-gray-300 text-xs">Anthropic</Label>
              <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-2">
                <KeyRound className="h-3 w-3" />
                API Key: {status?.providers.anthropic.keyConfigured ? 'Configured' : 'Missing'}
              </p>
            </div>
            <Switch checked={Boolean(status?.providers.anthropic.enabled)} onCheckedChange={(v) => void setProviderEnabled('anthropic', v)} disabled={syncing} />
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <Label className="text-gray-300 text-xs">DeepSeek</Label>
              <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-2">
                <KeyRound className="h-3 w-3" />
                API Key: {status?.providers.deepseek.keyConfigured ? 'Configured' : 'Missing'}
              </p>
            </div>
            <Switch checked={Boolean(status?.providers.deepseek.enabled)} onCheckedChange={(v) => void setProviderEnabled('deepseek', v)} disabled={syncing} />
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <Label className="text-gray-300 text-xs">Gemini</Label>
              <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-2">
                <KeyRound className="h-3 w-3" />
                API Key: {status?.providers.gemini?.keyConfigured ? 'Configured' : 'Missing'}
              </p>
            </div>
            <Switch checked={Boolean(status?.providers.gemini?.enabled)} onCheckedChange={(v) => void setProviderEnabled('gemini', v)} disabled={syncing} />
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <Label className="text-gray-300 text-xs">z.ai (GLM)</Label>
              <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-2">
                <KeyRound className="h-3 w-3" />
                API Key: {status?.providers.zai?.keyConfigured ? 'Configured' : 'Missing'}
              </p>
            </div>
            <Switch checked={Boolean(status?.providers.zai?.enabled)} onCheckedChange={(v) => void setZaiEnabled(v)} disabled={syncing} />
          </div>

          <div className="flex items-center justify-between py-1 border-t border-white/5 pt-4">
            <div>
              <Label className="text-gray-300 text-xs">Allow Anthropic → DeepSeek Fallback</Label>
              <p className="text-[11px] text-gray-500 mt-0.5">If Anthropic credits are exhausted, auto-switch to DeepSeek.</p>
            </div>
            <Switch checked={Boolean(status?.providers.deepseek?.fallbackEnabled)} onCheckedChange={(v) => void setFallbackEnabled(v)} disabled={syncing} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <h3 className="text-sm font-semibold text-white mb-1">API Key Management</h3>
        <p className="text-xs text-gray-500 mb-5">Set your API keys. They will be stored securely on the backend server.</p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-gray-300 text-xs text-white">Anthropic API Key</Label>
            <Input 
              type="password"
              placeholder={status?.providers.anthropic.keyConfigured ? "⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤" : "sk-ant-..."}
              value={apiKeys.anthropic}
              onChange={(e) => setApiKeys(prev => ({ ...prev, anthropic: e.target.value }))}
              className="bg-white/5 border-white/10 text-white h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-gray-300 text-xs text-white">DeepSeek API Key</Label>
            <Input 
              type="password"
              placeholder={status?.providers.deepseek.keyConfigured ? "⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤" : "sk-..."}
              value={apiKeys.deepseek}
              onChange={(e) => setApiKeys(prev => ({ ...prev, deepseek: e.target.value }))}
              className="bg-white/5 border-white/10 text-white h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-gray-300 text-xs text-white">Gemini API Key</Label>
            <Input
              type="password"
              placeholder={status?.providers.gemini?.keyConfigured ? "⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤" : "AIza..."}
              value={apiKeys.gemini}
              onChange={(e) => setApiKeys(prev => ({ ...prev, gemini: e.target.value }))}
              className="bg-white/5 border-white/10 text-white h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-gray-300 text-xs text-white">z.ai API Key <span className="text-indigo-400 ml-1">(GLM models)</span></Label>
            <Input
              type="password"
              placeholder={status?.providers.zai?.keyConfigured ? "⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤" : "your-zai-key..."}
              value={apiKeys.zai}
              onChange={(e) => setApiKeys(prev => ({ ...prev, zai: e.target.value }))}
              className="bg-white/5 border-white/10 text-white h-9 text-sm"
            />
          </div>
          <Button onClick={saveApiKeys} disabled={syncing || (!apiKeys.anthropic && !apiKeys.deepseek && !apiKeys.gemini && !apiKeys.zai)} className="w-full h-9 bg-purple-600 hover:bg-purple-700 text-white text-xs mt-2">
            Save API Keys
          </Button>
        </div>
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <h3 className="text-sm font-semibold text-white mb-1">Model Routing</h3>
        <p className="text-xs text-gray-500 mb-5">Set default primary and fallback models used by backend services.</p>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-gray-300 text-xs">Primary Model <span className="text-purple-400 ml-1">(Paid users — EcomGear Smart)</span></Label>
            <Select value={status?.models.primary} onValueChange={(v) => void setPrimaryModel(v)} disabled={syncing}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white h-9 text-sm">
                <SelectValue placeholder="Select primary model" />
              </SelectTrigger>
              <SelectContent>
                {availableModelIds.map((id) => (
                  <SelectItem value={id} key={`primary-${id}`}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-gray-300 text-xs">Free User Model <span className="text-amber-400 ml-1">(Free tier — restricted access)</span></Label>
            <Select value={status?.models.freeModel || status?.models.fallback || ''} onValueChange={(v) => void setFreeModel(v)} disabled={syncing}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white h-9 text-sm">
                <SelectValue placeholder="Select free tier model" />
              </SelectTrigger>
              <SelectContent>
                {availableModelIds.map((id) => (
                  <SelectItem value={id} key={`free-${id}`}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-gray-500">This model is served to free-tier users instead of EcomGear Smart. ECG Smart (Claude) remains paid-only.</p>
          </div>
          <div className="space-y-2">
            <Label className="text-gray-300 text-xs">Fallback Model</Label>
            <Select value={status?.models.fallback} onValueChange={(v) => void setFallbackModel(v)} disabled={syncing}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white h-9 text-sm">
                <SelectValue placeholder="Select fallback model" />
              </SelectTrigger>
              <SelectContent>
                {availableModelIds.map((id) => (
                  <SelectItem value={id} key={`fallback-${id}`}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <h3 className="text-sm font-semibold text-white mb-1">Allowed Models</h3>
        <p className="text-xs text-gray-500 mb-5">Add or remove models available to primary/fallback routing.</p>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-3 mb-4">
          <Input
            placeholder="Model ID, e.g. claude-3-5-sonnet-20241022"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            disabled={syncing}
            className="bg-white/5 border-white/10 text-white h-9 text-sm"
          />
          <Select value={newModelProvider} onValueChange={(v) => setNewModelProvider(v as LlmProvider)} disabled={syncing}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zai">z.ai (GLM)</SelectItem>
              <SelectItem value="anthropic">anthropic</SelectItem>
              <SelectItem value="deepseek">deepseek</SelectItem>
              <SelectItem value="gemini">gemini</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={addModel} disabled={syncing} className="h-9 bg-purple-600 hover:bg-purple-700 text-white gap-2 text-xs">
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        <div className="space-y-2">
          {(status?.models.allowed || []).map((model) => (
            <div key={model.id} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
              <div>
                <div className="text-xs text-white font-medium">{model.id}</div>
                <div className="text-[11px] text-gray-500">{model.provider}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void removeModel(model.id)} disabled={syncing} className="text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 h-8 px-2">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
