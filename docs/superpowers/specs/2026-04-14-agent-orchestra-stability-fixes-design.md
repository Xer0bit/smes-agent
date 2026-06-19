# Agent Orchestra Production Stability Fixes

**Date:** 2026-04-14  
**Scope:** Production stability — memory leak and guest limit permanence  
**Files touched:** `preview-service/server.js`, `supabase/migrations/`

---

## Problem Summary

Two production stability issues identified in the agent orchestra review:

1. **`activeServers` memory leak** — `getOrCreateServer()` creates new Vite instances without checking the cap first. `MAX_ACTIVE_SERVERS` is only enforced in `cleanupInactiveServers()` which runs every 5 minutes. Between cycles, the server count can exceed the cap, leading to OOM risk under concurrent load.

2. **Guest limit is permanent** — `check_and_increment_guest_ai_request` RPC tracks a lifetime counter with no date reset. Guests hitting 3 requests are blocked forever, causing conversion loss and poor UX.

---

## Fix 1: Proactive LRU Eviction in `getOrCreateServer`

### File
`preview-service/server.js`

### Change 1: Make cap env-configurable (line ~1354)

```js
// Before
const MAX_ACTIVE_SERVERS = IS_PRODUCTION ? 20 : 50;

// After
const MAX_ACTIVE_SERVERS = parseInt(process.env.MAX_ACTIVE_SERVERS) || (IS_PRODUCTION ? 20 : 50);
```

Allows ops tuning without redeployment.

### Change 2: Proactive eviction before server creation (in `getOrCreateServer`, after the `closingServers` wait block, before `initProject()`)

```js
// Evict LRU server if at capacity before creating a new one
if (activeServers.size >= MAX_ACTIVE_SERVERS) {
    let lruId = null;
    let lruTime = Infinity;
    for (const [id, inst] of activeServers.entries()) {
        if (inst.lastAccessed < lruTime) {
            lruTime = inst.lastAccessed;
            lruId = id;
        }
    }
    if (lruId) {
        console.log(`[Preview] LRU eviction: closing ${lruId} to make room (cap=${MAX_ACTIVE_SERVERS})`);
        await closeProjectServer(lruId, 'lru eviction');
    }
}
```

### Behaviour
- On every new server creation, if `size >= cap`, synchronously close the least-recently-used instance before proceeding.
- Existing periodic cleanup (`cleanupInactiveServers` every 5 min) stays unchanged — it handles inactivity eviction independently.
- Cold start cost on eviction: ~2–3s. Acceptable for production cap of 20.
- Env var `MAX_ACTIVE_SERVERS` defaults: 20 prod, 50 dev.

---

## Fix 2: Guest Daily Reset

### New Migration
`supabase/migrations/20260616000001_guest_daily_reset.sql`

### Change 1: Add `requests_reset_date` column to `guest_sessions`

```sql
ALTER TABLE public.guest_sessions
  ADD COLUMN IF NOT EXISTS requests_reset_date date NOT NULL DEFAULT current_date;
```

### Change 2: Replace `check_and_increment_guest_ai_request` function

Add a date-check block at the top of the function. If `current_date > requests_reset_date`, reset the counter before evaluating the limit:

```sql
-- At top of function, before the limit check:
IF current_date > (SELECT requests_reset_date FROM public.guest_sessions WHERE fingerprint = p_fingerprint) THEN
    UPDATE public.guest_sessions
    SET ai_requests_used = 0,
        requests_reset_date = current_date
    WHERE fingerprint = p_fingerprint;
END IF;
-- Then proceed with existing limit check logic unchanged
```

### Change 3: Update `get_guest_ai_requests` for UI accuracy

Apply the same date-check logic so the UI shows `requests_used = 0` correctly after a daily reset, not the stale previous-day count.

### Behaviour
- Guests get 3 requests per calendar day (UTC).
- On the first request of a new day, the counter resets atomically within the same transaction as the increment.
- RPC interface is unchanged — still returns `boolean`. No changes to `ai.routes.ts`.
- Existing grants (`anon`, `authenticated`, `service_role`) are re-applied in the migration.

---

## What Is Not Changing

- Rate limiting logic (`isRateLimited`) — unchanged
- Guest model enforcement (Gemini-only) — unchanged
- Concurrency fan-out logic — unchanged
- Token budget, XML parsing, agent loop monolith — out of scope for this pass

---

## Testing

### Fix 1
- Start preview service, create 21+ projects (exceed cap)
- Verify oldest server is evicted before the 21st is created
- Verify `GET /health` reports `activeServers <= MAX_ACTIVE_SERVERS`
- Verify evicted project cold-starts correctly on next request

### Fix 2
- Call RPC with a fresh fingerprint: should allow 3 requests
- Call a 4th time same day: should return `false`
- Simulate date change (set `requests_reset_date` to yesterday in DB): should allow 3 new requests
- Verify `get_guest_ai_requests` reflects reset correctly
