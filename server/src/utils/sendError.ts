import { logger } from './logger.js';

// 2026-08 security audit finding (Domain 4): 51 route handlers echoed
// `(err as Error).message` directly into the client response, bypassing
// error.middleware.ts's production sanitization entirely -- since none of
// them call next(err), the centralized handler never sees these. Confirmed
// this leaked raw Supabase/PostgREST error text (table/column/constraint
// names) to real API callers in production (functions.routes.ts especially,
// since it's invoked by anonymous end users of generated apps).
//
// safeErrorMessage() is a drop-in replacement for the message VALUE at each
// call site -- it doesn't change response shape or control flow (still just
// `res.status(500).json({ error: safeErrorMessage(err) })`), which keeps
// this a low-risk, uniform substitution instead of restructuring every route
// into the next(err) pattern. Full detail always goes to the log; the
// client only gets it back when NODE_ENV !== 'production'.
export function safeErrorMessage(err: unknown, fallback = 'Request failed'): string {
  // Not every thrown/returned "error" here is a true Error instance --
  // Supabase's PostgrestError is a plain object with a .message field, not
  // an Error subclass. Fall back to that shape before stringifying the
  // whole object (which would otherwise silently produce "[object Object]").
  const raw =
    err instanceof Error ? err.message :
    (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message) :
    String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(fallback, { error: raw, stack });

  if (process.env.NODE_ENV === 'production') {
    return fallback;
  }
  return raw;
}
