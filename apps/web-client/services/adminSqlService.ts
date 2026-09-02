/**
 * Admin-mode SQL: the agent's query_database tool (admin chat mode only)
 * stages a dangerous statement (schema-mutating, or an unqualified UPDATE/
 * DELETE) here instead of executing it -- the agent has no tool that can
 * confirm its own pending change (see agentToolSet.ts's
 * AGENT_NEVER_CONFIRMS_TOOLS server-side). Only a real click through these
 * functions, from a human, executes or discards it.
 */
import { getApiServerUrl } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';

export interface PendingAdminSqlChange {
  id: string;
  sql_text: string;
  status: string;
  created_at: string;
  staged_by_user_id: string;
  /** agent run that staged it; groups rows under the reply that produced them */
  batch_id?: string | null;
  /** Postgres message from the last failed batch run, if any */
  error_message?: string | null;
}

export interface RunAdminSqlBatchResult {
  success: boolean;
  executed: string[];
  failedId?: string;
  failedIndex?: number;
  error?: string;
}

/**
 * Run every pending statement (of one batch, or the project) in staging
 * order as one transaction. On failure nothing was applied; `failedId`
 * names the statement and `error` carries Postgres's message.
 */
export async function runAdminSqlBatch(projectId: string, batchId?: string): Promise<RunAdminSqlBatchResult> {
  const headers = await authHeaders();
  const res = await fetch(getApiServerUrl(`/api/v1/database/admin-sql/run-all?project_id=${encodeURIComponent(projectId)}`), {
    method: 'POST', headers, body: JSON.stringify({ project_id: projectId, batch_id: batchId }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 422) return { success: false, executed: [], failedId: json.failedId, failedIndex: json.failedIndex, error: json.error };
  if (!res.ok) throw new Error(json.error || `Run failed (${res.status})`);
  return { success: true, executed: json.executed ?? [] };
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
}

export async function fetchPendingAdminSql(projectId: string): Promise<PendingAdminSqlChange[]> {
  const headers = await authHeaders();
  const res = await fetch(getApiServerUrl(`/api/v1/database/admin-sql/pending?project_id=${encodeURIComponent(projectId)}`), { headers });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.pending) ? data.pending : [];
}

export async function confirmAdminSql(id: string): Promise<{ success: boolean; error?: string }> {
  const headers = await authHeaders();
  const res = await fetch(getApiServerUrl(`/api/v1/database/admin-sql/${encodeURIComponent(id)}/confirm`), { method: 'POST', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { success: false, error: data?.error || `HTTP ${res.status}` };
  return { success: true };
}

export async function rejectAdminSql(id: string): Promise<{ success: boolean; error?: string }> {
  const headers = await authHeaders();
  const res = await fetch(getApiServerUrl(`/api/v1/database/admin-sql/${encodeURIComponent(id)}/reject`), { method: 'POST', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { success: false, error: data?.error || `HTTP ${res.status}` };
  return { success: true };
}
