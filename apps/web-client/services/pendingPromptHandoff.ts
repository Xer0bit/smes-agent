import type { AgentAttachment } from '@/eCG/UserPrompt/types';

/**
 * Carries a dashboard hero-launch prompt across the `/project/:id` mount.
 *
 * React Router `location.state` is the primary carrier, but RequireAuth
 * (App.tsx) runs its own fresh getSession() check on every mount of
 * `/project/:id` and redirects to /auth on anything but an immediate
 * 'authenticated' result. That redirect rebuilds the target from
 * pathname+search+hash only, silently dropping `state` -- so a session
 * that isn't hydrated on the very first check destroys the initial prompt
 * with no error shown (found 2026-08-16: projects created via the
 * dashboard hero prompt ended up with zero messages/agent_runs).
 * sessionStorage survives that remount; Editor.tsx falls back to it when
 * `location.state` comes back empty.
 */
export interface PendingPrompt {
  initialPrompt: string;
  fileContext?: string;
  attachments?: AgentAttachment[];
}

function storageKey(projectId: string): string {
  return `ecg_pending_prompt_${projectId}`;
}

export function stashPendingPrompt(projectId: string, payload: PendingPrompt): void {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(payload));
  } catch {
    // sessionStorage unavailable (private mode, quota) -- location.state
    // still carries the prompt on the common path, so this is best-effort.
  }
}

/** Reads and removes the stashed prompt for a project, if any. */
export function consumePendingPrompt(projectId: string): PendingPrompt | null {
  const key = storageKey(projectId);
  const stashed = sessionStorage.getItem(key);
  if (!stashed) return null;
  sessionStorage.removeItem(key);
  try {
    const parsed = JSON.parse(stashed);
    if (typeof parsed?.initialPrompt !== 'string' || !parsed.initialPrompt) return null;
    return parsed as PendingPrompt;
  } catch {
    return null;
  }
}
