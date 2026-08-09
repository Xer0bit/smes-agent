// External Edge Function Configuration
// All API calls go through Supabase Edge Functions

const IS_PRODUCTION = import.meta.env.PROD;
const DEFAULT_SUPABASE_BASE = IS_PRODUCTION ? 'https://api.ecomgear.dev' : 'http://127.0.0.1:54321';
const RESOLVED_SUPABASE_BASE = (import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_BASE).replace(/\/$/, '');

export const EXTERNAL_API_CONFIG = {
  // Edge functions base URL (Supabase)
  BASE_URL: `${RESOLVED_SUPABASE_BASE}/functions/v1`,
  ANON_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '',

  endpoints: {
    // Existing edge functions
    createProject: '/revision-create-project',
    createRevision: '/revision-create-revision',
    getRevisions: '/revision-get-revisions',
    getProjects: '/revision-get-projects',
    publishVersion: '/revision-publish-version',
    getPublishedVersions: '/revision-get-published-versions',
    debugSandbox: '/debug-sandbox',
    signupComplete: '/signup-complete',
    agentWithTools: '/agent-with-tools',

    // NEW: API edge functions (replacing Express backend)
    apiProjects: '/api-projects',
    apiFiles: '/api-files',
    apiAuth: '/api-auth',
    apiAiGenerate: '/api-ai-generate',
  }
};

// Preview Service Configuration
// Normalize URL to remove trailing /preview for consistent construction
const rawPreviewUrl = import.meta.env.VITE_PREVIEW_URL || import.meta.env.VITE_PREVIEW_SERVICE_URL || (IS_PRODUCTION ? 'https://preview.ecomgear.app' : 'http://localhost:3001');
export const PREVIEW_CONFIG = {
  BASE_URL: rawPreviewUrl.replace(/\/preview\/?$/, ''),
};

// Helper function to build full URL for edge functions
export const getEndpointUrl = (endpoint: keyof typeof EXTERNAL_API_CONFIG.endpoints): string => {
  return `${EXTERNAL_API_CONFIG.BASE_URL}${EXTERNAL_API_CONFIG.endpoints[endpoint]}`;
};

// NEW: Helper to get edge function URL with query params
export const getEdgeFunctionUrl = (
  endpoint: keyof typeof EXTERNAL_API_CONFIG.endpoints,
  params?: Record<string, string>
): string => {
  const baseUrl = `${EXTERNAL_API_CONFIG.BASE_URL}${EXTERNAL_API_CONFIG.endpoints[endpoint]}`;
  if (!params) return baseUrl;
  const searchParams = new URLSearchParams(params);
  return `${baseUrl}?${searchParams.toString()}`;
};

// Helper to check if external API is configured
export const isExternalApiConfigured = (): boolean => {
  return EXTERNAL_API_CONFIG.BASE_URL !== 'https://your-server.com/functions/v1';
};

// ── VPS3 Generation & AI Server (US) ─────────────────────────────────────
// All AI / code-gen workloads run here for lower Anthropic latency.
const resolvedGenBase = import.meta.env.VITE_GEN_SERVER_URL || (IS_PRODUCTION ? 'https://gen.ecomgear.dev' : 'http://localhost:5001');
const resolvedAgentBase = import.meta.env.VITE_AGENT_SERVER_URL || resolvedGenBase;

export const GEN_SERVER_CONFIG = {
  BASE_URL: resolvedGenBase.replace(/\/$/, ''),
  AGENT_URL: resolvedAgentBase.replace(/\/$/, ''),
};

const LOCAL_GEN_FALLBACK_BASES = ['http://localhost:5001', 'http://localhost:5000'];

export const getGenServerCandidateUrls = (path: string): string[] => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const primary = `${GEN_SERVER_CONFIG.BASE_URL}${normalizedPath}`;

  try {
    const parsed = new URL(GEN_SERVER_CONFIG.BASE_URL);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!isLocal) return [primary];

    const candidates = [primary];
    for (const base of LOCAL_GEN_FALLBACK_BASES) {
      const normalizedBase = base.replace(/\/$/, '');
      const candidate = `${normalizedBase}${normalizedPath}`;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  } catch {
    return [primary];
  }
};

// Helper to build VPS3 gen-server URL
export const getGenServerUrl = (path: string): string =>
  `${GEN_SERVER_CONFIG.BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

// Helper to build VPS3 agent-server URL
export const getAgentServerUrl = (path: string): string =>
  `${GEN_SERVER_CONFIG.AGENT_URL}${path.startsWith('/') ? path : `/${path}`}`;

// ── VPS1 API Server   everything except LLM generation ──────────────────
// All /api/v1/* routes other than /api/v1/ai (auth, projects, files, preview,
// system, runtime, database, admin-database, seo, header-integrations, github,
// functions, ecg-*). In local dev this is the same single process as the gen
// server (port 5001), so it defaults to the same fallback.
const resolvedApiBase = import.meta.env.VITE_API_SERVER_URL || (IS_PRODUCTION ? 'https://api.ecomgear.dev' : 'http://localhost:5001');

export const API_SERVER_CONFIG = {
  BASE_URL: resolvedApiBase.replace(/\/$/, ''),
};

export const getApiServerUrl = (path: string): string =>
  `${API_SERVER_CONFIG.BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

// Check edge function availability
export const checkEdgeFunctionHealth = async (): Promise<boolean> => {
  try {
    const response = await fetch(getEndpointUrl('apiAuth') + '?action=health');
    return response.ok;
  } catch {
    return false;
  }
};

