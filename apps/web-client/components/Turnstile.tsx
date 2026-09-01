/**
 * Cloudflare Turnstile widget.
 *
 * Loads the Turnstile script once and renders the widget explicitly so it works
 * inside conditionally-rendered React forms (the implicit `.cf-turnstile` scan
 * only runs on the initial script load). Reports the token via `onToken`; an
 * empty string means "no valid token" (not yet solved, expired, or errored) so
 * callers can gate submission on a non-empty value.
 *
 * The site key is public. It comes from VITE_TURNSTILE_SITE_KEY, falling back
 * to this project's key so the widget works without a build-env change.
 */
import { useEffect, useRef } from 'react';

// A real Turnstile site key renders ONLY on hostnames allow-listed for the
// widget in the Cloudflare dashboard, so it draws nothing on localhost. In dev
// we fall back to Cloudflare's official "always passes" test key, which renders
// on any host with no dashboard config; production uses the real key. An
// explicit VITE_TURNSTILE_SITE_KEY always wins.
const PROD_SITE_KEY = '0x4AAAAAAEj2pIhgoJHjNXUd';
const DEV_TEST_SITE_KEY = '1x00000000000000000000AA'; // Cloudflare dummy: always passes, renders anywhere
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY
  || (import.meta.env.DEV ? DEV_TEST_SITE_KEY : PROD_SITE_KEY);
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
}
interface TurnstileApi {
  render: (el: HTMLElement, opts: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function ensureScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Turnstile script failed to load')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileProps {
  /** 1-32 chars, letters/numbers/underscore/hyphen. Must match the server's expected action. */
  action: string;
  onToken: (token: string) => void;
  theme?: 'light' | 'dark' | 'auto';
}

export function Turnstile({ action, onToken, theme = 'auto' }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ensureScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          action,
          theme,
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        });
      })
      .catch(() => onToken(''));
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
      }
    };
    // Re-render only when the action changes; onToken is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  return <div ref={containerRef} />;
}
