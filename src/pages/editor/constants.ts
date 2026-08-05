import type { BuilderTab } from "./types";

export const BUILDER_TABS: BuilderTab[] = ['brief', 'generate', 'code', 'preview', 'revisions', 'publish'];

// Auto-repair loop guards (see Editor.tsx's message-handler effect).
export const AUTO_REPAIR_COOLDOWN_MS = 60_000; // 60 s between auto-repairs
export const MAX_CONSECUTIVE_REPAIRS = 2;      // stop looping after 2 back-to-back attempts
// How long after a user-initiated navigation to suppress blank-screen auto-repair.
// Covers slow initial loads on new routes (SPA hydration + lazy chunks).
// If users report missed repairs after navigating, lower this value.
export const NAV_BLANK_GRACE_MS = 8_000;
