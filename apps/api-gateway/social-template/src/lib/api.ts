/**
 * apiFetch: use this for EVERY network request instead of bare fetch().
 * Adds a timeout, retries transient failures (network error / 5xx / 429)
 * twice with backoff, and throws a descriptive Error on failure so calling
 * code can show a real message instead of failing silently.
 *
 * NOTE: this file is also injected verbatim by the platform's base-template
 * scaffold at project-seed time (baseTemplateService.ts) -- kept here only
 * so this template typechecks/builds standalone in the template's own repo.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {},
  { retries = 2, timeoutMs = 15000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  let lastError: Error = new Error('Request failed');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: options.signal ?? controller.signal });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(`Request to ${new URL(url, window.location.href).pathname} failed with status ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError' && options.signal?.aborted) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastError;
}

/** apiFetch + JSON parse with a readable error on non-2xx or invalid JSON. */
export async function apiFetchJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(url, options);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    throw new Error(`Request failed (${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json() as Promise<T>;
}
