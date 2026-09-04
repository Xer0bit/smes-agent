import { useEffect, useRef, useState } from 'react';
import AdminServers from './Servers';
import { EXTERNAL_API_CONFIG, getGenServerUrl, getApiServerUrl } from '@/config/external-api';
import { supabase } from '@/integrations/supabase/adminClient';

type ServiceState = 'checking' | 'online' | 'offline';

interface SupabaseChecks {
  db: ServiceState;
  auth: ServiceState;
  edgeFunctions: ServiceState;
}

function StatusDot({ state }: { state: ServiceState }) {
  if (state === 'checking') return <span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />;
  if (state === 'online')   return <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />;
  return <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />;
}

function statusLabel(state: ServiceState) {
  if (state === 'checking') return 'Checking…';
  if (state === 'online')   return 'Online';
  return 'Offline';
}

function SupabaseStatusCard() {
  const [checks, setChecks] = useState<SupabaseChecks>({
    db: 'checking',
    auth: 'checking',
    edgeFunctions: 'checking',
  });
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const runChecks = async () => {
    setChecks({ db: 'checking', auth: 'checking', edgeFunctions: 'checking' });

    // DB   query a lightweight system table via REST
    const dbOk = await (async () => {
      try {
        const { error } = await supabase.from('organizations').select('id').limit(1);
        return !error;
      } catch { return false; }
    })();

    // Auth   get current session (non-network if already cached, but validates client)
    const authOk = await (async () => {
      try {
        const { error } = await supabase.auth.getSession();
        return !error;
      } catch { return false; }
    })();

    // Edge Functions   probe signup-complete (always deployed).
    // Any HTTP response other than a network error means the edge runtime is up.
    // We expect a 400/422 (missing required fields)   that's fine, it proves the
    // function exists and is executing.
    const edgeOk = await (async () => {
      try {
        const url = `${EXTERNAL_API_CONFIG.BASE_URL}/signup-complete`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(8000),
        });
        // 404 = function not found; anything else (200, 400, 401, etc.) = runtime up
        return res.status !== 404;
      } catch { return false; }
    })();

    setChecks({
      db: dbOk ? 'online' : 'offline',
      auth: authOk ? 'online' : 'offline',
      edgeFunctions: edgeOk ? 'online' : 'offline',
    });
    setLastChecked(new Date().toLocaleTimeString());
  };

  useEffect(() => { runChecks(); }, []);

  const rows: { label: string; key: keyof SupabaseChecks }[] = [
    { label: 'Database (REST)', key: 'db' },
    { label: 'Auth Service',    key: 'auth' },
    { label: 'Edge Functions',  key: 'edgeFunctions' },
  ];

  return (
    <div className="rounded-none border border-border bg-muted/50 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-white">Supabase</h3>
          {lastChecked && <p className="text-xs text-muted-foreground mt-0.5">Last checked {lastChecked}</p>}
        </div>
        <button
          onClick={runChecks}
          className="text-xs text-muted-foreground hover:text-muted-foreground border border-border rounded px-2.5 py-1 transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="space-y-3">
        {rows.map(({ label, key }) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-sm text-foreground/80">{label}</span>
            <div className="flex items-center gap-2">
              <StatusDot state={checks[key]} />
              <span className={`text-xs font-medium ${
                checks[key] === 'online' ? 'text-green-400' :
                checks[key] === 'offline' ? 'text-red-400' : 'text-yellow-400'
              }`}>
                {statusLabel(checks[key])}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Troubleshoot Panel ────────────────────────────────────────────────────────

interface DiagResult {
  label: string;
  url: string;
  status: number | null;
  ok: boolean;
  latencyMs: number | null;
  body: string;
  error: string | null;
}

async function probe(label: string, url: string, init?: RequestInit): Promise<DiagResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - t0;
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    // Truncate to 600 chars for display
    if (body.length > 600) body = body.slice(0, 600) + '…';
    return { label, url, status: res.status, ok: res.status < 500 && res.status !== 404, latencyMs, body, error: null };
  } catch (e: any) {
    return { label, url, status: null, ok: false, latencyMs: Date.now() - t0, body: '', error: e?.message || 'Network error' };
  }
}

function DiagRow({ r }: { r: DiagResult }) {
  const [expanded, setExpanded] = useState(false);
  const dot = r.status === null
    ? 'bg-red-500'
    : r.ok ? 'bg-green-500' : 'bg-red-500';
  const statusText = r.status === null ? 'No response' : `HTTP ${r.status}`;

  return (
    <div className="rounded border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-accent/40 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${dot}`} />
          <span className="text-sm text-foreground font-medium">{r.label}</span>
          {r.error && <span className="text-xs text-red-400 truncate">{r.error}</span>}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-3">
          {r.latencyMs !== null && (
            <span className="text-xs text-muted-foreground">{r.latencyMs}ms</span>
          )}
          <span className={`text-xs font-mono ${r.ok ? 'text-green-400' : 'text-red-400'}`}>
            {statusText}
          </span>
          <span className="text-muted-foreground/60 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/60 px-4 py-3 space-y-1">
          <p className="text-xs text-muted-foreground font-mono break-all">{r.url}</p>
          {r.error ? (
            <p className="text-xs text-red-400 mt-1">{r.error}</p>
          ) : (
            <pre className="text-xs text-foreground/80 whitespace-pre-wrap break-all mt-1 font-mono max-h-40 overflow-y-auto">
              {r.body || '(empty body)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TroubleshootPanel() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<DiagResult[]>([]);
  const [lastRan, setLastRan] = useState<string | null>(null);

  // Manual probe state
  const [probeUrl, setProbeUrl] = useState('');
  const [probeMethod, setProbeMethod] = useState<'GET' | 'POST'>('GET');
  const [probeBody, setProbeBody] = useState('');
  const [probeResult, setProbeResult] = useState<DiagResult | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);
  const probeRef = useRef<HTMLInputElement>(null);

  const runDiagnostics = async () => {
    setRunning(true);
    setResults([]);

    const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
    const authHeader = session?.access_token
      ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };

    const checks = await Promise.all([
      // Supabase REST
      probe('Supabase DB (REST)', `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/organizations?select=id&limit=1`, {
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || ''}`,
        },
      }),
      // Edge Function runtime
      probe('Supabase Edge Functions', `${EXTERNAL_API_CONFIG.BASE_URL}/signup-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      // Gen API health (no auth needed)   VPS3, generation-only now
      probe('Gen API (/health)', getGenServerUrl('/health')),
      // API server health   VPS1, everything else
      probe('API Server (/health)', getApiServerUrl('/health')),
      // API server LLM status (admin auth required)
      probe('API Server (LLM status)', getApiServerUrl('/api/v1/system/llm/status'), { headers: authHeader }),
      // API server status
      probe('API Server (server status)', getApiServerUrl('/api/v1/system/server-status'), { headers: authHeader }),
    ]);

    setResults(checks);
    setLastRan(new Date().toLocaleTimeString());
    setRunning(false);
  };

  const runManualProbe = async () => {
    if (!probeUrl.trim()) return;
    setProbeRunning(true);
    setProbeResult(null);
    const init: RequestInit = { method: probeMethod };
    if (probeMethod === 'POST') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = probeBody || '{}';
    }
    const r = await probe(probeUrl, probeUrl.trim(), init);
    setProbeResult(r);
    setProbeRunning(false);
  };

  return (
    <div className="rounded-none border border-border bg-muted/50 p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-white">Troubleshoot</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Run detailed diagnostics to see actual errors and response bodies
            {lastRan && ` · Last ran ${lastRan}`}
          </p>
        </div>
        <button
          onClick={runDiagnostics}
          disabled={running}
          className="flex items-center gap-2 text-sm text-white bg-primary hover:bg-primary disabled:opacity-50 rounded px-3 py-1.5 transition-colors"
        >
          {running ? (
            <>
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Running…
            </>
          ) : 'Run Diagnostics'}
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map(r => <DiagRow key={r.label} r={r} />)}
        </div>
      )}

      {results.length === 0 && !running && (
        <p className="text-xs text-muted-foreground/60 text-center py-4">
          Click "Run Diagnostics" to probe all production endpoints and see detailed status.
        </p>
      )}

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Manual endpoint probe */}
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-2">Manual Endpoint Probe</p>
        <div className="flex gap-2">
          <select
            value={probeMethod}
            onChange={e => setProbeMethod(e.target.value as 'GET' | 'POST')}
            className="bg-background border border-border rounded text-xs text-foreground/80 px-2 py-1.5"
          >
            <option>GET</option>
            <option>POST</option>
          </select>
          <input
            ref={probeRef}
            type="text"
            value={probeUrl}
            onChange={e => setProbeUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runManualProbe()}
            placeholder="https://gen.SMEsAgent.dev/health"
            className="flex-1 bg-background border border-border rounded text-xs text-foreground/80 px-3 py-1.5 placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary"
          />
          <button
            onClick={runManualProbe}
            disabled={probeRunning || !probeUrl.trim()}
            className="text-xs text-white bg-accent hover:bg-gray-600 disabled:opacity-50 rounded px-3 py-1.5 transition-colors"
          >
            {probeRunning ? '…' : 'Test'}
          </button>
        </div>
        {probeMethod === 'POST' && (
          <textarea
            value={probeBody}
            onChange={e => setProbeBody(e.target.value)}
            placeholder='{"key": "value"}'
            rows={2}
            className="mt-2 w-full bg-background border border-border rounded text-xs text-foreground/80 font-mono px-3 py-2 placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary resize-none"
          />
        )}
        {probeResult && <DiagRow r={probeResult} />}
      </div>
    </div>
  );
}

export default function AdminSystemStatus() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">System Status</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Live status of Supabase, the generation API, and hosting servers.
        </p>
      </div>

      <SupabaseStatusCard />
      <TroubleshootPanel />
      <AdminServers />
    </div>
  );
}
