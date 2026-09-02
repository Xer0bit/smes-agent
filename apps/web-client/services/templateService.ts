/**
 * Community templates: browse shared projects and remix one into a workspace.
 * Server: apps/api-gateway/src/routes/templates.routes.ts
 */
import { getApiServerUrl } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';

export interface CommunityTemplate {
  id: string;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  preview_url: string | null;
  template_category: string | null;
  template_tags: string[];
  remix_count: number;
  template_published_at: string | null;
  author: string | null;
  is_mine: boolean;
}

export interface TemplateSettings {
  is_template: boolean;
  template_category: string | null;
  template_tags: string[];
  remix_count: number;
  template_published_at: string | null;
}

export const TEMPLATE_CATEGORIES = ['Storefront', 'Landing page', 'Dashboard', 'Portfolio', 'Booking', 'Directory', 'Internal tool', 'Other'] as const;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  const res = await fetch(getApiServerUrl(`/api/v1/templates${path}`), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(init.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function fetchTemplates(params: { q?: string; category?: string } = {}): Promise<{ templates: CommunityTemplate[] }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category) qs.set('category', params.category);
  const suffix = qs.toString();
  return request<{ templates: CommunityTemplate[] }>(suffix ? `?${suffix}` : '');
}

export function remixTemplate(templateId: string, body: { organization_id?: string | null; name?: string }): Promise<{ project: { id: string; name: string } }> {
  return request<{ project: { id: string; name: string } }>(`/${encodeURIComponent(templateId)}/remix`, { method: 'POST', body: JSON.stringify(body) });
}

export function fetchTemplateSettings(projectId: string): Promise<TemplateSettings> {
  return request<TemplateSettings>(`/${encodeURIComponent(projectId)}/settings`);
}

export function updateTemplateSettings(projectId: string, patch: Partial<Pick<TemplateSettings, 'is_template' | 'template_category' | 'template_tags'>>): Promise<TemplateSettings> {
  return request<TemplateSettings>(`/${encodeURIComponent(projectId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export interface Blueprint {
  id: string;
  name: string;
  category: string;
  tagline: string;
  description: string;
  accent: string;
  stack: string[];
  pages: string[];
}

export function fetchBlueprints(): Promise<{ blueprints: Blueprint[] }> {
  return request<{ blueprints: Blueprint[] }>('/blueprints');
}

export function startBlueprint(id: string, body: { organization_id?: string | null; name?: string }): Promise<{ project: { id: string; name: string }; starter_prompt: string }> {
  return request<{ project: { id: string; name: string }; starter_prompt: string }>(`/blueprints/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify(body) });
}
