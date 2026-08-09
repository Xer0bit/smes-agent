import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FunctionSquare, Play, Clock, Bot, Lock } from "lucide-react";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { cn } from "@/lib/utils";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface EdgeFn { id: string; name: string; description: string | null; is_active: boolean; created_at: string; }
interface InvokeResult { result: unknown; logs: string[]; durationMs: number; error?: string; }

interface EdgeFunctionsSettingsProps {
  projectId?: string;
}

export const EdgeFunctionsSettings = ({ projectId }: EdgeFunctionsSettingsProps) => {
  const { hasFeature } = useSubscription();
  const isPaid = hasFeature("ecomgear_cloud");

  // Functions are project-scoped, not database-scoped   no provisioned
  // database is required to list, invoke (if the function doesn't touch a
  // DB), or delete a function. Only db.* calls inside a function's own code
  // need one.
  const apiFetch = useCallback(async (path: string, opts: RequestInit = {}, timeoutMs = 10_000) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Not authenticated");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sep = path.includes('?') ? '&' : '?';
    const qs = projectId ? `${sep}project_id=${encodeURIComponent(projectId)}` : '';
    try {
      const res = await fetch(getApiServerUrl(`/api/v1${path}${qs}`), {
        ...opts,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      return json;
    } finally { clearTimeout(timer); }
  }, [projectId]);

  const [fns, setFns] = useState<EdgeFn[]>([]);
  const [selected, setSelected] = useState<EdgeFn | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [params, setParams] = useState('{}');
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [invoking, setInvoking] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/functions');
      setFns(res.functions || []);
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  }, [apiFetch, projectId]);

  useEffect(() => { load(); }, [load]);

  // Load the full source for whichever function is selected   the list
  // endpoint only returns name/description/is_active, never the code itself.
  useEffect(() => {
    if (!selected) { setCode(null); return; }
    setCodeLoading(true);
    setCode(null);
    apiFetch(`/functions/${selected.name}`)
      .then(res => setCode(res.code ?? ''))
      .catch(e => toast.error((e as Error).message))
      .finally(() => setCodeLoading(false));
  }, [selected, apiFetch]);

  const invoke = async () => {
    if (!selected) return;
    let parsed: unknown = {};
    try { parsed = JSON.parse(params); } catch { toast.error('Params must be valid JSON'); return; }
    setInvoking(true); setResult(null);
    try {
      const res = await apiFetch(`/functions/${selected.name}/invoke`, {
        method: 'POST', body: JSON.stringify({ params: parsed }),
      }, 10_000);
      setResult(res);
    } catch (e) { toast.error((e as Error).message); }
    finally { setInvoking(false); }
  };

  if (!isPaid) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white/85 mb-1">Edge Functions</h2>
          <p className="text-sm text-white/45">Serverless functions your AI agent writes and your app can invoke   no database required.</p>
        </div>
        <Card className="bg-workspace-surface border-indigo-500/25">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Pro or Agency plan required</CardTitle>
            </div>
            <CardDescription>Edge functions are part of eComGear Cloud   upgrade to unlock them.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (loading) return <SettingsSkeleton cards={1} />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Edge Functions</h2>
        <p className="text-sm text-white/45">Serverless functions your AI agent writes and your app can invoke   no database required.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white/85">
            <FunctionSquare className="h-4 w-4 text-primary" />
            Functions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {fns.length === 0 ? (
            <p className="py-6 text-center text-sm text-white/30">No functions yet. Ask the agent to create one.</p>
          ) : (
            <div className="flex gap-4 min-h-0">
              <div className="w-44 shrink-0 flex flex-col gap-1 border-r border-white/[0.07] pr-3">
                <span className="text-xs text-white/45 font-medium mb-2">{fns.length} function{fns.length !== 1 ? 's' : ''}</span>
                {fns.map(fn => (
                  <button
                    key={fn.id}
                    onClick={() => { setSelected(fn); setResult(null); }}
                    className={cn(
                      "text-left text-xs px-2 py-1.5 rounded-md transition-colors duration-smooth flex items-center gap-1.5 truncate",
                      selected?.id === fn.id ? "bg-primary/15 text-primary" : "text-white/60 hover:text-white/85 hover:bg-white/[0.04]"
                    )}
                  >
                    <FunctionSquare className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{fn.name}</span>
                  </button>
                ))}
              </div>

              {selected ? (
                <div className="flex-1 flex flex-col gap-3 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <FunctionSquare className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-mono text-sm font-medium truncate">{selected.name}</span>
                      {selected.description && (
                        <span className="text-xs text-white/30 truncate">{selected.description}</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/45 font-medium">Source (read-only   ask the agent to change it)</span>
                    </div>
                    <div className="rounded-lg border border-white/[0.07] bg-black/40 max-h-56 overflow-y-auto">
                      {codeLoading ? (
                        <p className="text-xs text-white/30 p-3">Loading…</p>
                      ) : (
                        <pre className="text-xs font-mono text-white/60 p-3 whitespace-pre-wrap break-all">{code || '(empty)'}</pre>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Textarea
                      value={params}
                      onChange={e => setParams(e.target.value)}
                      placeholder='{"key": "value"}'
                      className="text-xs font-mono bg-white/[0.04] border-white/[0.07] flex-1 min-h-[60px] resize-none"
                    />
                    <Button size="sm" className="h-9 text-xs shrink-0 gap-1" onClick={invoke} disabled={invoking}>
                      <Play className="h-3 w-3" />{invoking ? 'Running…' : 'Run'}
                    </Button>
                  </div>

                  {result && (
                    <div className={cn(
                      "rounded-lg border p-2 text-xs space-y-1 max-h-40 overflow-y-auto",
                      result.error ? "border-red-500/30 bg-red-500/5" : "border-green-500/20 bg-green-500/5"
                    )}>
                      <div className="flex items-center gap-1.5 text-white/45 mb-1">
                        <Clock className="h-3 w-3" /><span>{result.durationMs}ms</span>
                        {result.error
                          ? <span className="text-red-400 ml-auto">Error</span>
                          : <span className="text-green-400 ml-auto">OK</span>}
                      </div>
                      {result.error && <p className="text-red-400 font-mono break-all">{result.error}</p>}
                      {result.logs.map((l, i) => (
                        <p key={i} className="text-white/45 font-mono break-all">{l}</p>
                      ))}
                      {!result.error && (
                        <pre className="text-green-300/80 font-mono break-all whitespace-pre-wrap">
                          {JSON.stringify(result.result, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-sm text-white/30">
                  Select a function to run it
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
