/**
 * Server status: probe a registered app server, persist the result on the
 * row and append it to app_server_checks, and keep a background monitor
 * running on the API process so status exists even when nobody opens the
 * admin page.
 */
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { probeUrl } from './serverHealth.js';

export interface ServerRow {
  id: string;
  base_url: string;
  health_path: string;
  [key: string]: unknown;
}

export interface CheckPoint { status: 'healthy' | 'degraded' | 'unreachable'; latency_ms: number | null; checked_at: string }

export const HISTORY_POINTS = 48;
const RETENTION_DAYS = 7;

export function healthUrl(s: { base_url: string; health_path: string }): string {
  const base = s.base_url.replace(/\/$/, '');
  const path = s.health_path.startsWith('/') ? s.health_path : `/${s.health_path}`;
  return base + path;
}

export async function checkServer(row: ServerRow): Promise<Record<string, unknown>> {
  const r = await probeUrl(healthUrl(row));
  const now = new Date().toISOString();
  const patch = {
    health_status: r.status, health_http: r.http, health_latency_ms: r.latencyMs,
    health_detail: r.error ? { error: r.error } : r.detail, health_last_check: now,
  };
  const [{ data, error }, { error: checkErr }] = await Promise.all([
    supabase.from('app_servers').update(patch).eq('id', row.id).select('*').single(),
    supabase.from('app_server_checks').insert({ server_id: row.id, status: r.status, http: r.http, latency_ms: r.latencyMs, error: r.error, checked_at: now }),
  ]);
  if (error) throw new Error(error.message);
  if (checkErr) logger.warn('[server-status] check insert failed', { server: row.id, error: checkErr.message });
  return data;
}

/** Pure: uptime percentage over a window of points (healthy counts as up). */
export function uptimePercent(points: Array<{ status: string }>): number | null {
  if (points.length === 0) return null;
  const up = points.filter((p) => p.status === 'healthy').length;
  return Math.round((up / points.length) * 1000) / 10;
}

/** Servers with their recent check history and 24h uptime attached. */
export async function listServersWithStatus(): Promise<Array<Record<string, unknown>>> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ data: servers, error }, { data: checks }] = await Promise.all([
    supabase.from('app_servers').select('*').order('created_at').order('name'),
    supabase.from('app_server_checks').select('server_id, status, latency_ms, checked_at').gte('checked_at', since).order('checked_at', { ascending: false }).limit(HISTORY_POINTS * 50),
  ]);
  if (error) throw new Error(error.message);
  const byServer = new Map<string, CheckPoint[]>();
  for (const c of checks ?? []) {
    const list = byServer.get(c.server_id) ?? [];
    list.push({ status: c.status as CheckPoint['status'], latency_ms: c.latency_ms, checked_at: c.checked_at });
    byServer.set(c.server_id, list);
  }
  return (servers ?? []).map((s) => {
    const points = byServer.get(s.id) ?? [];
    return { ...s, uptime_24h: uptimePercent(points), checks_24h: points.length, history: points.slice(0, HISTORY_POINTS).reverse() };
  });
}

export async function checkAllEnabled(): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase.from('app_servers').select('id, base_url, health_path').eq('enabled', true);
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map((row) => checkServer(row)));
}

let monitorTimer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const results = await checkAllEnabled();
    const bad = results.filter((r) => r.health_status !== 'healthy').map((r) => `${r.name}:${r.health_status}`);
    if (bad.length) logger.warn('[server-status] unhealthy servers', { bad });
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
    await supabase.from('app_server_checks').delete().lt('checked_at', cutoff);
  } catch (err) {
    logger.warn('[server-status] monitor tick failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Every SERVER_STATUS_INTERVAL_MS (default 5 min; 0 disables). */
export function startServerStatusMonitor(): void {
  if (monitorTimer) return;
  const interval = Number(process.env.SERVER_STATUS_INTERVAL_MS ?? 5 * 60 * 1000);
  if (!Number.isFinite(interval) || interval <= 0) return;
  monitorTimer = setInterval(tick, interval);
  monitorTimer.unref();
  setTimeout(tick, 5000).unref();
  logger.info('[server-status] monitor started', { intervalMs: interval });
}
