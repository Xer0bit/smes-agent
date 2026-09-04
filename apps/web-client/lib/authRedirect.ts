function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

export function getOAuthCallbackUrl(path: string = '/auth/callback'): string {
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const envOrigin = (import.meta.env.VITE_SITE_URL || '').trim();
  const base = currentOrigin || envOrigin || 'https://www.SMEsAgent.dev';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${stripTrailingSlash(base)}${normalizedPath}`;
}
