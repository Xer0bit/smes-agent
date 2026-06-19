import { supabase } from '../config/database.js';
import { config } from '../config/environment.js';
import { logger } from '../utils/logger.js';

export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

interface RuntimeStartResponse {
  success: boolean;
  projectId: string;
  previewUrl?: string;
  containerId?: string;
  hostNode?: string;
  runtimeStatus?: RuntimeStatus;
  metadata?: Record<string, unknown>;
}

interface RuntimeStopResponse {
  success: boolean;
  projectId: string;
  runtimeStatus?: RuntimeStatus;
}

interface RuntimeControlStatusResponse {
  success: boolean;
  projectId: string;
  runtimeStatus: RuntimeStatus;
  previewUrl?: string;
  containerId?: string;
  hostNode?: string;
  metadata?: Record<string, unknown>;
}

interface RuntimeRecord {
  id: string;
  project_id: string;
  container_id: string | null;
  runtime_status: RuntimeStatus;
  runtime_mode: string;
  preview_url: string | null;
  host_node: string | null;
  started_at: string | null;
  last_active_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  idle_timeout_minutes: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

class RuntimeService {
  private readonly controlBaseUrl = config.previewControlUrl.replace(/\/$/, '');

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.controlBaseUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      ...init,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Runtime control ${response.status}: ${body || response.statusText}`);
    }

    return await response.json() as T;
  }

  async startRuntime(projectId: string, userId: string): Promise<RuntimeRecord> {
    const now = new Date().toISOString();

    await this.upsertRuntimeRecord(projectId, {
      runtime_status: 'starting',
      started_at: now,
      stopped_at: null,
      stop_reason: null,
      last_active_at: now,
      updated_at: now,
    });

    try {
      const started = await this.fetchJson<RuntimeStartResponse>(`/control/runtime/${projectId}/start`, {
        method: 'POST',
        body: JSON.stringify({ projectId, userId }),
      });

      const runtimeStatus: RuntimeStatus = started.runtimeStatus || 'running';
      const record = await this.upsertRuntimeRecord(projectId, {
        container_id: started.containerId || null,
        host_node: started.hostNode || null,
        preview_url: started.previewUrl || `${config.previewBaseUrl.replace(/\/$/, '')}/preview/${projectId}`,
        runtime_status: runtimeStatus,
        started_at: now,
        stopped_at: runtimeStatus === 'stopped' ? now : null,
        stop_reason: null,
        last_active_at: now,
        metadata: started.metadata || {},
        updated_at: now,
      });

      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[runtime] start failed for project=${projectId}: ${message}`);
      await this.upsertRuntimeRecord(projectId, {
        runtime_status: 'failed',
        stop_reason: message,
        updated_at: now,
      });
      throw error;
    }
  }

  async stopRuntime(projectId: string, reason: string = 'manual_stop'): Promise<RuntimeRecord> {
    const now = new Date().toISOString();

    await this.upsertRuntimeRecord(projectId, {
      runtime_status: 'stopping',
      stop_reason: reason,
      updated_at: now,
    });

    try {
      const stopped = await this.fetchJson<RuntimeStopResponse>(`/control/runtime/${projectId}/stop`, {
        method: 'POST',
        body: JSON.stringify({ projectId, reason }),
      });

      const runtimeStatus: RuntimeStatus = stopped.runtimeStatus || 'stopped';
      return await this.upsertRuntimeRecord(projectId, {
        runtime_status: runtimeStatus,
        stopped_at: now,
        last_active_at: now,
        updated_at: now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[runtime] stop failed for project=${projectId}: ${message}`);
      return await this.upsertRuntimeRecord(projectId, {
        runtime_status: 'failed',
        stop_reason: message,
        updated_at: now,
      });
    }
  }

  async heartbeat(projectId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.upsertRuntimeRecord(projectId, {
      last_active_at: now,
      updated_at: now,
      runtime_status: 'running',
    });
  }

  async getRuntimeStatus(projectId: string): Promise<RuntimeRecord | null> {
    const { data, error } = await supabase
      .from('project_runtime_instances')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read runtime record: ${error.message}`);
    }

    return data as RuntimeRecord | null;
  }

  async refreshFromControlPlane(projectId: string): Promise<RuntimeRecord> {
    const status = await this.fetchJson<RuntimeControlStatusResponse>(`/control/runtime/${projectId}/status`, {
      method: 'GET',
    });

    const now = new Date().toISOString();
    return await this.upsertRuntimeRecord(projectId, {
      runtime_status: status.runtimeStatus || 'stopped',
      preview_url: status.previewUrl || `${config.previewBaseUrl.replace(/\/$/, '')}/preview/${projectId}`,
      container_id: status.containerId || null,
      host_node: status.hostNode || null,
      metadata: status.metadata || {},
      last_active_at: now,
      updated_at: now,
      stopped_at: status.runtimeStatus === 'stopped' ? now : null,
    });
  }

  private async upsertRuntimeRecord(projectId: string, patch: Partial<RuntimeRecord>): Promise<RuntimeRecord> {
    const now = new Date().toISOString();

    const payload = {
      project_id: projectId,
      runtime_mode: 'single-host-docker',
      idle_timeout_minutes: config.previewIdleTimeoutMinutes,
      metadata: {},
      ...patch,
      updated_at: patch.updated_at || now,
    };

    const { data, error } = await supabase
      .from('project_runtime_instances')
      .upsert(payload, { onConflict: 'project_id' })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to upsert runtime record: ${error.message}`);
    }

    return data as RuntimeRecord;
  }
}

export const runtimeService = new RuntimeService();
export default runtimeService;
