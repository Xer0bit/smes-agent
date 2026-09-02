/**
 * eCG Cloud: workspace-wide view of hosted databases.
 * Server: apps/api-gateway/src/routes/database.routes.ts (`GET /list`)
 */
import { getApiServerUrl } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';

export interface WorkspaceDatabase {
  id: string;
  project_id: string;
  project_name: string;
  schema_name: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface WorkspaceDatabases {
  databases: WorkspaceDatabase[];
  projects_without_database: Array<{ id: string; name: string }>;
}

export async function fetchWorkspaceDatabases(organizationId: string): Promise<WorkspaceDatabases> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  const res = await fetch(getApiServerUrl(`/api/v1/database/list?organization_id=${encodeURIComponent(organizationId)}`), {
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as WorkspaceDatabases;
}

export interface DatabaseOverview {
  schema: string;
  health: {
    connected: boolean;
    latency_ms: number | null;
    server_version: string | null;
    size_bytes: number;
    tables: number;
    views: number;
    functions: number;
    sequences: number;
    indexes: number;
    policies: number;
    triggers: number;
    rls_enabled_tables: number;
    tables_without_policies: string[];
    connections: number;
    roles: { anon: boolean; service: boolean; owner: boolean };
    api_exposed: boolean | null;
    dead_tuple_ratio: number | null;
    last_analyze: string | null;
  };
  tables: Array<{
    name: string;
    row_estimate: number;
    size_bytes: number;
    index_count: number;
    seq_scans: number;
    idx_scans: number;
    dead_tuples: number;
    rls_enabled: boolean;
    policy_count: number;
    columns: Array<{ name: string; type: string; nullable: boolean; default: string | null; primary_key: boolean; unique: boolean }>;
  }>;
  relationships: Array<{ table: string; column: string; refTable: string; refColumn: string }>;
}

export async function fetchDatabaseOverview(projectId: string): Promise<DatabaseOverview> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  const res = await fetch(getApiServerUrl(`/api/v1/database/overview?project_id=${encodeURIComponent(projectId)}`), {
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as DatabaseOverview;
}
