import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Theme for the dashboard: light (white), dark, or follow the system.
 *
 * Only the dashboard honours it. The editor, project settings, admin and the
 * marketing pages are built on hardcoded dark surfaces, so those routes force
 * `dark` on <html> whatever the preference (see ThemeScope in App.tsx) and the
 * portals they open (dialogs, sheets, popovers) inherit it.
 *
 * The same key and rule live in index.html's inline script, which sets the
 * class before the first paint so a light dashboard never flashes dark.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'SMEsAgent:theme';

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Whether <html> should carry `dark` right now. */
export function resolveDark(preference: ThemePreference, forceDark: boolean): boolean {
  if (forceDark) return true;
  if (preference === 'system') return systemPrefersDark();
  return preference === 'dark';
}

export function applyTheme(preference: ThemePreference, forceDark: boolean): void {
  const dark = resolveDark(preference, forceDark);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemePreference(next: ThemePreference): void {
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* storage blocked */ }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', listener);
  return () => { listeners.delete(listener); mq.removeEventListener('change', listener); };
}

export function useTheme(): { preference: ThemePreference; isDark: boolean; setPreference: (p: ThemePreference) => void; toggle: () => void } {
  const preference = useSyncExternalStore(subscribe, readPreference, () => 'system' as ThemePreference);
  const isDark = resolveDark(preference, false);
  const setPreference = useCallback((p: ThemePreference) => setThemePreference(p), []);
  const toggle = useCallback(() => setThemePreference(isDark ? 'light' : 'dark'), [isDark]);
  return { preference, isDark, setPreference, toggle };
}

/** Keeps <html> in step with the preference and the route's dark requirement. */
export function useApplyTheme(forceDark: boolean): void {
  const { preference } = useTheme();
  useEffect(() => { applyTheme(preference, forceDark); }, [preference, forceDark]);
}
