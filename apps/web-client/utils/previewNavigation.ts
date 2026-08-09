/**
 * Normalises a raw pathname received from the preview iframe's postMessage.
 *
 * Older versions of the preview service injected script sent the full
 * `window.location.pathname + search + hash` (e.g. `/preview/{id}/?t=...#/route`).
 * The updated version sends only the hash route (e.g. `/route`), but we keep
 * this sanitiser for backwards compatibility with cached service instances.
 */
export function normalizePreviewRoute(raw: string): string {
  if (!raw) return '/';
  // If it contains a '#', the route lives after it   strip everything before.
  const hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) return raw.slice(hashIdx + 1) || '/';
  // If it's a /preview/{uuid}/sub-path, strip the prefix.
  const m = raw.match(/^\/preview\/[^/]+\/(.*)/);
  if (m) return `/${m[1]}` || '/';
  return raw;
}

/**
 * Builds the preview iframe navigation URL for the given route.
 * Generated apps use HashRouter, so routes are appended as hash fragments.
 */
export function buildPreviewNavigationUrl(
  baseUrl: string,
  routePath: string,
  cacheBust = false,
): string {
  // Strip any existing hash from base URL
  const hashIndex = baseUrl.indexOf('#');
  const baseWithoutHash = hashIndex >= 0 ? baseUrl.slice(0, hashIndex) : baseUrl;
  const cleanBase = baseWithoutHash.replace(/\/$/, '');

  let result = cacheBust
    ? (cleanBase + (cleanBase.includes('?') ? '&' : '?') + `t=${Date.now()}`)
    : cleanBase + '/';

  // Generated apps use HashRouter   navigate via hash fragment, not pathname
  if (routePath && routePath !== '/') {
    const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
    result = `${result.replace(/\/$/, '')}/#${normalized}`;
  }

  return result;
}
