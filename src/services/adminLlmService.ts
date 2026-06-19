import { getGenServerUrl } from '@/config/external-api';
import { supabase } from '@/integrations/supabase/client';

export type LlmProvider = 'anthropic' | 'deepseek' | 'gemini';

export interface LlmModelEntry {
  id: string;
  provider: LlmProvider;
}

export interface LlmStatus {
  providers: {
    anthropic: { enabled: boolean; keyConfigured?: boolean };
    deepseek: { enabled: boolean; fallbackEnabled: boolean; keyConfigured?: boolean };
    gemini: { enabled: boolean; fallbackEnabled: boolean; keyConfigured?: boolean };
  };
  models: {
    primary: string;
    fallback: string;
    /** Model served to free-tier users. Defaults to fallback model. */
    freeModel?: string;
    allowed: LlmModelEntry[];
  };
  apiKeys?: {
    anthropic?: string;
    deepseek?: string;
    gemini?: string;
  };
  updatedAt: string;
}

const getAuthHeader = async (): Promise<HeadersInit> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Admin session missing');
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
};

const readJson = async <T>(response: Response): Promise<T> => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as any)?.error || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
};

export const adminLlmService = {
  async getStatus(): Promise<LlmStatus> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl('/api/v1/system/llm/status'), { headers });
    const payload = await readJson<{ success: boolean; data: LlmStatus }>(response);
    return payload.data;
  },

  async saveStatus(input: Partial<LlmStatus>): Promise<LlmStatus> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl('/api/v1/system/llm/status'), {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    });
    const payload = await readJson<{ success: boolean; data: LlmStatus }>(response);
    return payload.data;
  },

  async addModel(id: string, provider: LlmProvider): Promise<LlmStatus> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl('/api/v1/system/llm/models'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, provider }),
    });
    const payload = await readJson<{ success: boolean; data: LlmStatus }>(response);
    return payload.data;
  },

  async removeModel(id: string): Promise<LlmStatus> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl(`/api/v1/system/llm/models/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers,
    });
    const payload = await readJson<{ success: boolean; data: LlmStatus }>(response);
    return payload.data;
  },

  async testProviders(): Promise<Record<string, { ok: boolean; reason: string; testedAt: string }>> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl('/api/v1/ai/test-providers'), {
      method: 'POST',
      headers,
    });
    const payload = await readJson<{ success: boolean; results: Record<string, { ok: boolean; reason: string; testedAt: string }> }>(response);
    return payload.results;
  },

  async getServerStatus(): Promise<{
    nodeVersion: string;
    platform: string;
    uptimeSeconds: number;
    memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; freeMB: number; totalMB: number };
    cpu: { model: string; cores: number; loadAvg: number[] };
    pid: number;
    env: string;
  }> {
    const headers = await getAuthHeader();
    const response = await fetch(getGenServerUrl('/api/v1/system/server-status'), { headers });
    const payload = await readJson<{ success: boolean; data: any }>(response);
    return payload.data;
  },
};
