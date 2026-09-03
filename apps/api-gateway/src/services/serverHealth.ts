/**
 * Server-side HTTP health probe for the admin server registry. Runs on the
 * api-gateway so the browser never needs CORS or mixed-content access to a
 * node; the result is persisted on the server row.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unreachable';

export interface ProbeResult {
  status: HealthStatus;
  http: number | null;
  latencyMs: number;
  detail: Record<string, unknown> | null;
  error: string | null;
}

const OK_WORDS = new Set(['ok', 'healthy', 'up', 'pass']);

/** Pure: an HTTP status plus the parsed body decide healthy vs degraded. */
export function classifyProbe(http: number, body: unknown): HealthStatus {
  if (http < 200 || http >= 300) return 'degraded';
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (b.ok === false) return 'degraded';
    if (typeof b.status === 'string' && !OK_WORDS.has(b.status.toLowerCase())) return 'degraded';
  }
  return 'healthy';
}

/** Keep only small scalar fields so health_detail stays a readable summary. */
export function summarizeBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 8 && v.every((x) => typeof x === 'string') ? v : `${v.length} items`;
    } else if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const flat = entries.length <= 6 && entries.every(([, x]) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
      if (flat) out[k] = Object.fromEntries(entries);
    }
  }
  return out;
}

export async function probeUrl(url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'follow' });
    const latencyMs = Date.now() - t0;
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: classifyProbe(res.status, body), http: res.status, latencyMs, detail: summarizeBody(body), error: null };
  } catch (e) {
    return { status: 'unreachable', http: null, latencyMs: Date.now() - t0, detail: null, error: e instanceof Error ? e.message : String(e) };
  }
}
