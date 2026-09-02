/**
 * Architecture guards: the shapes of "admin page" the agent must not ship.
 *
 * Observed 2026-09-02: asked for an admin page, the agent added a button to
 * the user page that flipped a boolean and rendered the admin UI in place.
 * No sign-in, no role, no route, no data. The prompt already said otherwise;
 * this is the tool-layer refusal so the prompt is not the only defence.
 *
 * Pure functions so the patterns can be tested without the tool set.
 */

/**
 * Client-side privilege toggles. Deliberately narrow: `isAdmin` read from a
 * session is fine, `setIsAdmin(!isAdmin)` on a click is not, and a role kept
 * in localStorage is never an access control.
 */
const CLIENT_SIDE_ADMIN_TOGGLE: readonly RegExp[] = [
  /set(?:Is)?Admin(?:Mode|View)?\(\s*(?:true|!\s*(?:is)?[Aa]dmin\w*|\(?\s*\w+\s*\)?\s*=>\s*!\s*\w+)\s*\)/,
  /(?:local|session)Storage\.(?:get|set)Item\(\s*['"](?:role|isAdmin|is_admin|admin|adminMode|userRole|user_role)['"]\s*[,)]/,
  /(?:password|passcode|pin)\s*===?\s*['"][^'"]{1,40}['"]/i,
];

export function findClientSideAdminToggle(content: string): string | null {
  for (const re of CLIENT_SIDE_ADMIN_TOGGLE) {
    const m = re.exec(content);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/** A file whose creation shapes the app's structure: a page or the route table. */
export function isStructuralFile(path: string): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return /^src\/(pages|routes|views|screens|app)\//.test(p) || /^src\/App\.(tsx|jsx)$/.test(p);
}

export const ADMIN_TOGGLE_BLOCK_MESSAGE =
  'BLOCKED: this file grants admin access from the client (a toggle, a stored flag or a hardcoded secret). ' +
  'Admin access comes from an authenticated session and the user\'s role in the hosted database: ' +
  'an auth-login edge function that verifies the password and returns a session token, an auth-session ' +
  'function (or the profile row) that returns the role, and a route guard that redirects anyone else. ' +
  'Put the admin area on its own routes under /admin behind that guard. If no hosted database exists ' +
  'yet, say so and stop; do not fake it.';
