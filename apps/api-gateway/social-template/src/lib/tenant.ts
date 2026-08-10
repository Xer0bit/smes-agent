// The ONLY data-access layer this app uses. Every table read/write, file
// upload, and Buffer/social-publishing action goes through invokeFn() ->
// one of the platform edge functions in src/edge-functions/ (mirrored,
// read-only reflection at __edge_functions__/ once deployed).
//
// Identity: cloud auth (src/integrations/supabase/client.ts, sign up / log
// in / session) is the ONLY source of who's calling. invokeFn() attaches
// the caller's current access token to every call; each edge function
// verifies it itself (fetching /auth/v1/user) before touching any table --
// there is no direct PostgREST access anywhere in this app, and no
// client-side authorization decision anywhere in this app either.
import { apiFetch, apiFetchJson } from './api';
import { supabase } from '@/integrations/supabase/client';

const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_API_URL;
const DB_ANON_KEY = import.meta.env.VITE_DB_ANON_KEY;
const AUTH_URL = import.meta.env.VITE_SUPABASE_URL;
const AUTH_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export class TenantNotProvisionedError extends Error {
  constructor() {
    super('This dashboard has no hosted database yet. Ask the owner to provision one in Settings.');
    this.name = 'TenantNotProvisionedError';
  }
}

interface InvokeEnvelope<T> {
  result?: T;
  error?: string;
}

/**
 * Calls one platform edge function. `fnParams` becomes `params` inside the
 * function; the caller's access token + the auth service's own address are
 * merged in automatically so the function can verify identity (both values
 * are already public in this bundle, not secrets).
 */
export async function invokeFn<T = unknown>(name: string, fnParams: Record<string, unknown> = {}): Promise<T> {
  if (!FUNCTIONS_URL || !DB_ANON_KEY) throw new TenantNotProvisionedError();

  const { data: { session } } = await supabase.auth.getSession();

  const res = await apiFetch(`${FUNCTIONS_URL}/${name}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: DB_ANON_KEY },
    body: JSON.stringify({
      params: {
        ...fnParams,
        accessToken: session?.access_token ?? null,
        authUrl: AUTH_URL,
        authAnonKey: AUTH_ANON_KEY,
      },
    }),
  });
  const body = (await res.json()) as InvokeEnvelope<T>;
  if (body.error) throw new Error(body.error);
  return body.result as T;
}

/** Upload helper: reads a File as base64 and stores it via the `files` function. */
export async function uploadFile(file: File, clientId?: string): Promise<{ id: string; fileName: string }> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return invokeFn('files', {
    action: 'upload',
    clientId,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    dataBase64: base64,
  });
}

/**
 * Resolves a stored file to a displayable `data:` URL. Edge-function invoke
 * is always POST+JSON (no bare-GET path a plain <img src> could hit), so
 * this genuinely has to be fetched, not built as a string -- use the
 * `useFileUrl` hook below in components instead of calling this directly.
 */
export async function getFileDataUrl(fileId: string): Promise<string> {
  const { dataUrl } = await invokeFn<{ dataUrl: string }>('files', { action: 'get', fileId });
  return dataUrl;
}

export { apiFetchJson };
