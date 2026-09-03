/**
 * Admin-only API calls that RLS cannot serve from the browser: the platform
 * server registry (server-side health probes) and platform role verification.
 * Backed by apps/api-gateway/src/routes/admin.routes.ts.
 */
import { getApiServerUrl } from '@/config/external-api';
import { supabase } from '@/integrations/supabase/adminClient';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Admin session missing');
  const res = await fetch(getApiServerUrl(`/api/v1/admin${path}`), {
    ...init,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Request failed with ${res.status}`);
  return body;
}

// ── Servers ──────────────────────────────────────────────────────────────────

export type ServerRole = 'api' | 'gen' | 'preview' | 'hosting' | 'tenant_db' | 'functions' | 'web' | 'other';
export type ServerHealth = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

export interface AppServer {
  id: string;
  name: string;
  role: ServerRole;
  base_url: string;
  health_path: string;
  host: string | null;
  notes: string | null;
  enabled: boolean;
  health_status: ServerHealth;
  health_http: number | null;
  health_latency_ms: number | null;
  health_detail: Record<string, unknown> | null;
  health_last_check: string | null;
  created_at: string;
  updated_at: string;
  uptime_24h: number | null;
  checks_24h: number;
  history: CheckPoint[];
}

export interface CheckPoint { status: 'healthy' | 'degraded' | 'unreachable'; latency_ms: number | null; checked_at: string }

export interface AppServerInput {
  name: string;
  role: ServerRole;
  base_url: string;
  health_path: string;
  host: string | null;
  notes: string | null;
  enabled?: boolean;
}

export const adminServersService = {
  list: () => request<{ servers: AppServer[] }>('/servers').then((r) => r.servers),
  create: (input: AppServerInput) => request<{ server: AppServer }>('/servers', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.server),
  update: (id: string, input: Partial<AppServerInput>) => request<{ server: AppServer }>(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(input) }).then((r) => r.server),
  remove: (id: string) => request<{ success: boolean }>(`/servers/${id}`, { method: 'DELETE' }),
  check: (id: string) => request<{ server: AppServer }>(`/servers/${id}/check`, { method: 'POST' }).then((r) => r.server),
  checkAll: () => request<{ servers: AppServer[] }>('/servers/check', { method: 'POST' }).then((r) => r.servers),
};

// ── Roles ────────────────────────────────────────────────────────────────────

export type PlatformRole = 'user' | 'admin' | 'super_admin';

export interface RoleHolder {
  id: string;
  user_id: string;
  role: PlatformRole;
  granted_at: string;
  email: string | null;
  full_name: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  banned_until: string | null;
  mfa_factors: number;
  account_status: string | null;
  checks: { auth_exists: boolean; email_confirmed: boolean; not_banned: boolean; profile_active: boolean; mfa: boolean };
  verified: boolean;
}

export interface RoleIssue { code: string; user_id: string; email: string | null; message: string }

export interface RoleAuditEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  target_user_id: string;
  target_email: string | null;
  action: string;
  old_role: string | null;
  new_role: string | null;
  created_at: string;
}

export interface RoleReport {
  holders: RoleHolder[];
  issues: RoleIssue[];
  orgIssues: Array<{ org_id: string; name: string }>;
  audit: RoleAuditEntry[];
  caller: { user_id: string; role: 'super_admin' | 'admin' | null };
  checked_at: string;
}

export const adminRolesService = {
  report: () => request<RoleReport>('/roles'),
  setRole: (userId: string, role: PlatformRole) => request<{ success: boolean }>(`/roles/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  confirmEmail: (userId: string) => request<{ success: boolean }>(`/roles/${userId}/confirm-email`, { method: 'POST' }),
  ban: (userId: string, unban = false) => request<{ success: boolean }>(`/roles/${userId}/ban`, { method: 'POST', body: JSON.stringify({ unban }) }),
};
