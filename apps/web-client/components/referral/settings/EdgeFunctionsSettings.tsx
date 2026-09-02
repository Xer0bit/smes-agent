import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";

/**
 * What the list endpoint returns. `inputs` is derived server-side from the
 * function body (services/edgeFunctionInputs.ts); the body itself never
 * reaches this component. A user here is looking at what each function takes
 * and gives back, not at JavaScript.
 */
interface EdgeFn {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  inputs: string[];
}

interface InvokeResult { result: unknown; logs: string[]; durationMs: number; error?: string; }

interface RunLog {
  id: string;
  params: unknown;
  result: unknown;
  error: string | null;
  duration_ms: number | null;
  invoked_at: string;
}

interface EdgeFunctionsSettingsProps {
  projectId?: string;
}

const RECENT_RUNS = 5;

export const EdgeFunctionsSettings = ({ projectId }: EdgeFunctionsSettingsProps) => {

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
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

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

  if (loading) return <SettingsSkeleton cards={1} />;

  return (
    <div className="space-y-6">
      <Heading count={fns.length} />

      {fns.length === 0 ? (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardContent className="py-8 text-center text-sm text-white/40">
            No functions yet. Ask the agent in chat to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {fns.map((fn) => (
            <FunctionRow
              key={fn.id}
              fn={fn}
              open={openId === fn.id}
              onToggle={() => setOpenId(openId === fn.id ? null : fn.id)}
              apiFetch={apiFetch}
            />
          ))}
        </div>
      )}
    </div>
  );
};

function Heading({ count }: { count?: number }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-white/85 mb-1">
        Edge Functions{typeof count === 'number' && count > 0 ? <span className="ml-2 text-white/35 font-normal">{count}</span> : null}
      </h2>
      <p className="text-sm text-white/45">
        Server-side functions the agent wrote for this app. Each one takes an input and returns an output; ask the agent in chat to change what a function does.
      </p>
    </div>
  );
}

// ─── One function ─────────────────────────────────────────────────────────────

function FunctionRow({ fn, open, onToggle, apiFetch }: {
  fn: EdgeFn;
  open: boolean;
  onToggle: () => void;
  apiFetch: (path: string, opts?: RequestInit, timeoutMs?: number) => Promise<any>;
}) {
  const [runs, setRuns] = useState<RunLog[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawInput, setRawInput] = useState('{}');
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [invoking, setInvoking] = useState(false);

  // Recent runs load once, the first time the row opens.
  useEffect(() => {
    if (!open || runs !== null) return;
    apiFetch(`/functions/${fn.name}/logs`)
      .then((res) => setRuns((res.logs || []).slice(0, RECENT_RUNS)))
      .catch(() => setRuns([]));
  }, [open, runs, apiFetch, fn.name]);

  const hasNamedInputs = fn.inputs.length > 0;

  const buildParams = (): unknown => {
    if (!hasNamedInputs) return JSON.parse(rawInput);
    const out: Record<string, unknown> = {};
    for (const key of fn.inputs) {
      const raw = values[key] ?? '';
      if (raw === '') continue;
      out[key] = coerce(raw);
    }
    return out;
  };

  const run = async () => {
    let params: unknown;
    try { params = buildParams(); } catch { toast.error('Input must be valid JSON'); return; }
    setInvoking(true); setResult(null);
    try {
      const res: InvokeResult = await apiFetch(`/functions/${fn.name}/invoke`, {
        method: 'POST', body: JSON.stringify({ params }),
      }, 10_000);
      setResult(res);
      setRuns((prev) => [{
        id: `local-${Date.now()}`, params, result: res.result, error: res.error ?? null,
        duration_ms: res.durationMs, invoked_at: new Date().toISOString(),
      }, ...(prev ?? [])].slice(0, RECENT_RUNS));
    } catch (e) { toast.error((e as Error).message); }
    finally { setInvoking(false); }
  };

  const lastOutput = runs?.find((r) => !r.error);

  return (
    <div className={cn("rounded-xl border border-white/[0.07] bg-workspace-surface transition-colors", open && "border-white/[0.14]")}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-white/90 truncate">{fn.name}</span>
            {!fn.is_active && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] text-white/40">Paused</span>
            )}
          </div>
          {fn.description && <p className="text-[12.5px] text-white/45 truncate mt-0.5">{fn.description}</p>}
        </div>
        <div className="hidden sm:flex items-center gap-1.5 shrink-0 max-w-[45%] overflow-hidden">
          <span className="text-[11px] text-white/35 mr-0.5">Input</span>
          {hasNamedInputs
            ? fn.inputs.slice(0, 4).map((k) => <Chip key={k}>{k}</Chip>)
            : <span className="text-[11px] text-white/30">none</span>}
          {fn.inputs.length > 4 && <span className="text-[11px] text-white/35">+{fn.inputs.length - 4}</span>}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-white/35 transition-transform duration-150", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-white/[0.07] px-4 py-4 grid gap-5 md:grid-cols-2">
          {/* Input */}
          <section className="space-y-3 min-w-0">
            <SectionLabel>Input</SectionLabel>
            {hasNamedInputs ? (
              <div className="space-y-2">
                {fn.inputs.map((key) => (
                  <label key={key} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-[12.5px] text-white/60 truncate" title={key}>{key}</span>
                    <Input
                      value={values[key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                      placeholder="value"
                      className="h-8 text-[12.5px] bg-white/[0.04] border-white/[0.08]"
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[12px] text-white/40">This function takes no named input. You can still pass one:</p>
                <Textarea
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                  className="min-h-[60px] text-[12.5px] bg-white/[0.04] border-white/[0.08] resize-none"
                />
              </div>
            )}
            <Button size="sm" onClick={run} disabled={invoking} className="h-8 text-xs gap-1.5">
              <Play className="h-3 w-3" />{invoking ? 'Running…' : 'Run'}
            </Button>
          </section>

          {/* Output */}
          <section className="space-y-3 min-w-0">
            <SectionLabel>Output</SectionLabel>
            {result ? (
              <OutputView value={result.error ? undefined : result.result} error={result.error} durationMs={result.durationMs} />
            ) : lastOutput ? (
              <>
                <p className="text-[11px] text-white/35">Last successful run, {relativeTime(lastOutput.invoked_at)}</p>
                <OutputView value={lastOutput.result} durationMs={lastOutput.duration_ms ?? undefined} />
              </>
            ) : (
              <p className="text-[12px] text-white/40">{runs === null ? 'Loading…' : 'Not run yet. Run it to see what it returns.'}</p>
            )}
          </section>

          {/* Recent runs */}
          {runs && runs.length > 0 && (
            <section className="md:col-span-2 space-y-2 min-w-0">
              <SectionLabel>Recent runs</SectionLabel>
              <div className="rounded-lg border border-white/[0.07] divide-y divide-white/[0.06] overflow-hidden">
                {runs.map((r) => (
                  <div key={r.id} className="grid grid-cols-[auto_1fr_1fr_auto] items-start gap-3 px-3 py-2 text-[12px]">
                    <span className={cn("mt-0.5 h-1.5 w-1.5 rounded-full shrink-0", r.error ? "bg-red-400" : "bg-emerald-400")} />
                    <div className="min-w-0">
                      <span className="text-white/35">in </span>
                      <span className="text-white/70 break-all">{brief(r.params)}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="text-white/35">out </span>
                      <span className={cn("break-all", r.error ? "text-red-300/90" : "text-white/70")}>{r.error ?? brief(r.result)}</span>
                    </div>
                    <span className="text-white/30 whitespace-nowrap">{r.duration_ms != null ? `${r.duration_ms}ms · ` : ''}{relativeTime(r.invoked_at)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-white/35">{children}</p>;
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[11px] text-white/65">{children}</span>;
}

/**
 * A returned value as rows, not a JSON dump. Objects become key/value rows,
 * arrays a count plus their first items, scalars a single line.
 */
function OutputView({ value, error, durationMs }: { value: unknown; error?: string; durationMs?: number }) {
  return (
    <div className={cn("rounded-lg border p-3 space-y-1.5", error ? "border-red-500/25 bg-red-500/[0.05]" : "border-white/[0.07] bg-white/[0.02]")}>
      {error ? (
        <p className="text-[12.5px] text-red-300/90 break-words">{error}</p>
      ) : isPlainObject(value) ? (
        Object.keys(value).length === 0
          ? <p className="text-[12.5px] text-white/40">Empty object</p>
          : Object.entries(value).map(([k, v]) => (
            <div key={k} className="flex gap-3 text-[12.5px]">
              <span className="w-28 shrink-0 text-white/50 truncate" title={k}>{k}</span>
              <span className="text-white/85 break-all">{brief(v)}</span>
            </div>
          ))
      ) : Array.isArray(value) ? (
        <>
          <p className="text-[12.5px] text-white/60">{value.length} item{value.length === 1 ? '' : 's'}</p>
          {value.slice(0, 3).map((v, i) => (
            <p key={i} className="text-[12.5px] text-white/80 break-all">{brief(v)}</p>
          ))}
          {value.length > 3 && <p className="text-[11px] text-white/35">+{value.length - 3} more</p>}
        </>
      ) : (
        <p className="text-[12.5px] text-white/85 break-all">{brief(value)}</p>
      )}
      {durationMs != null && <p className="text-[11px] text-white/30 pt-1">{durationMs}ms</p>}
    </div>
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One-line rendering of any value, capped so a row never becomes a wall. */
function brief(v: unknown, max = 140): string {
  let s: string;
  if (v === undefined) s = 'nothing';
  else if (v === null) s = 'null';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Form fields are strings; send numbers, booleans and JSON as themselves. */
function coerce(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { /* keep as text */ }
  }
  return raw;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
