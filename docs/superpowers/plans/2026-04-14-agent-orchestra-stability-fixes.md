# Agent Orchestra Production Stability Fixes   Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `activeServers` memory leak in the preview service and add daily reset to the guest request limit.

**Architecture:** Two independent fixes   (1) proactive LRU eviction in `getOrCreateServer()` before new Vite instances are created, and (2) a new Supabase migration that adds a `requests_reset_date` column and rewrites the guest request RPC to reset the counter at the start of each calendar day.

**Tech Stack:** Node.js/Express (preview server), PostgreSQL/Supabase (guest limit), no new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `preview-service/server.js` | Make `MAX_ACTIVE_SERVERS` env-configurable; add LRU eviction block in `getOrCreateServer()` |
| `supabase/migrations/20260616000001_guest_daily_reset.sql` | New file   adds `requests_reset_date` column; replaces both guest RPCs |

---

## Task 1: Make `MAX_ACTIVE_SERVERS` env-configurable

**Files:**
- Modify: `preview-service/server.js:1354`

- [ ] **Step 1: Open the file and locate the constant**

  File: `preview-service/server.js`, line 1354:
  ```js
  const MAX_ACTIVE_SERVERS = IS_PRODUCTION ? 20 : 50; // Limit concurrent servers
  ```

- [ ] **Step 2: Replace with env-configurable version**

  Replace that single line with:
  ```js
  const MAX_ACTIVE_SERVERS = parseInt(process.env.MAX_ACTIVE_SERVERS) || (IS_PRODUCTION ? 20 : 50);
  ```

- [ ] **Step 3: Verify the server starts without errors**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  node --no-deprecation preview-service/server.js &
  sleep 2
  curl -s http://localhost:3001/health | python3 -m json.tool
  kill %1
  ```

  Expected output contains:
  ```json
  {
    "status": "ok",
    "activeServers": 0
  }
  ```

- [ ] **Step 4: Verify env var override works**

  ```bash
  MAX_ACTIVE_SERVERS=5 node --no-deprecation preview-service/server.js &
  sleep 2
  curl -s http://localhost:3001/health
  kill %1
  ```

  Server should start cleanly (the cap value isn't visible in health, but no startup error should occur).

- [ ] **Step 5: Commit**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  git add preview-service/server.js
  git commit -m "fix: make MAX_ACTIVE_SERVERS env-configurable in preview service"
  ```

---

## Task 2: Add proactive LRU eviction in `getOrCreateServer`

**Files:**
- Modify: `preview-service/server.js:1426-1428`

- [ ] **Step 1: Locate the insertion point**

  In `preview-service/server.js`, find the `getOrCreateServer` function. The `closingServers` wait block ends at line ~1426. The next line is:
  ```js
      console.log(`[Preview] Starting server for project: ${projectId} (${NODE_ENV} mode)`);
  ```

- [ ] **Step 2: Insert LRU eviction block immediately before that `console.log`**

  Insert this block between the closing `}` of the `closingServers` wait block and the `console.log`:

  ```js
      // Proactive LRU eviction: if at capacity, close the least-recently-used server
      // before creating a new one. This prevents the cap from being exceeded between
      // periodic cleanup cycles.
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

  The full context after the edit should look like:

  ```js
      // If a close/restart is in progress, wait up to 8 s for it to finish
      if (closingServers.has(projectId)) {
          // ... existing polling code ...
          if (activeServers.has(projectId)) {
              const instance = activeServers.get(projectId);
              instance.lastAccessed = Date.now();
              return instance;
          }
      }

      // Proactive LRU eviction: if at capacity, close the least-recently-used server
      // before creating a new one. This prevents the cap from being exceeded between
      // periodic cleanup cycles.
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

      console.log(`[Preview] Starting server for project: ${projectId} (${NODE_ENV} mode)`);
      const projectRoot = initProject(projectId);
  ```

- [ ] **Step 3: Start the preview server and verify it starts cleanly**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  node --no-deprecation preview-service/server.js &
  sleep 2
  curl -s http://localhost:3001/health | python3 -m json.tool
  ```

  Expected:
  ```json
  { "status": "ok", "activeServers": 0, "uptime": 2 }
  ```

- [ ] **Step 4: Verify LRU eviction fires at cap**

  ```bash
  # With cap=2, create 3 projects and verify only 2 are active
  MAX_ACTIVE_SERVERS=2 node --no-deprecation preview-service/server.js &
  sleep 2

  # Create 3 fake project directories with minimal files
  for i in 1 2 3; do
    UUID="00000000-0000-0000-0000-00000000000$i"
    mkdir -p /home/xer0bit/Desktop/ecomgear-main/preview-service/projects/$UUID/src
    echo '<!DOCTYPE html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' \
      > /home/xer0bit/Desktop/ecomgear-main/preview-service/projects/$UUID/index.html
    echo '{"name":"test","version":"1.0.0","dependencies":{"react":"^18.0.0","react-dom":"^18.0.0"}}' \
      > /home/xer0bit/Desktop/ecomgear-main/preview-service/projects/$UUID/package.json
    echo 'import React from "react"; import ReactDOM from "react-dom/client"; ReactDOM.createRoot(document.getElementById("root")!).render(<div>Hello</div>);' \
      > /home/xer0bit/Desktop/ecomgear-main/preview-service/projects/$UUID/src/main.tsx
  done

  # Trigger server creation for all 3 via /update endpoint
  for i in 1 2 3; do
    UUID="00000000-0000-0000-0000-00000000000$i"
    curl -s -X POST http://localhost:3001/preview/$UUID/update \
      -H "Content-Type: application/json" \
      -d '{"files":[{"path":"src/main.tsx","content":"import React from \"react\"; export default function App() { return <div>Hello</div>; }"}]}' &
    sleep 1
  done
  wait

  # Check that activeServers <= 2
  ACTIVE=$(curl -s http://localhost:3001/health | python3 -c "import sys,json; print(json.load(sys.stdin)['activeServers'])")
  echo "Active servers: $ACTIVE (should be <= 2)"

  kill %1
  ```

  Expected: `Active servers: 2` (or 1 if third is still spinning up). Should never show 3.

- [ ] **Step 5: Check that eviction message appears in logs**

  In the server output, look for:
  ```
  [Preview] LRU eviction: closing 00000000-0000-0000-0000-000000000001 to make room (cap=2)
  ```

- [ ] **Step 6: Clean up test project directories**

  ```bash
  for i in 1 2 3; do
    rm -rf /home/xer0bit/Desktop/ecomgear-main/preview-service/projects/00000000-0000-0000-0000-00000000000$i
  done
  ```

- [ ] **Step 7: Commit**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  git add preview-service/server.js
  git commit -m "fix: proactive LRU eviction in getOrCreateServer prevents memory leak"
  ```

---

## Task 3: Add daily reset to guest request limit

**Files:**
- Create: `supabase/migrations/20260616000001_guest_daily_reset.sql`

- [ ] **Step 1: Create the migration file**

  Create `supabase/migrations/20260616000001_guest_daily_reset.sql` with this exact content:

  ```sql
  -- =============================================================================
  -- Guest AI Request Daily Reset
  -- Adds requests_reset_date to guest_sessions so the 3-request limit resets
  -- each calendar day (UTC) instead of being permanent.
  -- =============================================================================

  -- ── 1. Add requests_reset_date column ────────────────────────────────────────
  ALTER TABLE public.guest_sessions
    ADD COLUMN IF NOT EXISTS requests_reset_date date NOT NULL DEFAULT current_date;

  -- ── 2. Replace check_and_increment_guest_ai_request ──────────────────────────
  -- Returns TRUE if the request is allowed (under limit), FALSE if at limit.
  -- Atomically resets the counter at the start of each new calendar day (UTC),
  -- then increments. Single row lock prevents race conditions.
  CREATE OR REPLACE FUNCTION public.check_and_increment_guest_ai_request(p_fingerprint text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_requests        integer;
    v_reset_date      date;
    v_max_requests    constant integer := 3;
  BEGIN
    -- Upsert: create row if not exists
    INSERT INTO public.guest_sessions (fingerprint, ai_requests_used, requests_reset_date)
    VALUES (p_fingerprint, 0, current_date)
    ON CONFLICT (fingerprint) DO NOTHING;

    -- Lock the row
    SELECT ai_requests_used, requests_reset_date
      INTO v_requests, v_reset_date
      FROM public.guest_sessions
     WHERE fingerprint = p_fingerprint
       FOR UPDATE;

    -- Daily reset: if last reset was before today, zero the counter
    IF current_date > v_reset_date THEN
      UPDATE public.guest_sessions
         SET ai_requests_used   = 0,
             requests_reset_date = current_date,
             last_active_at      = now()
       WHERE fingerprint = p_fingerprint;
      v_requests := 0;
    END IF;

    -- Enforce limit
    IF v_requests >= v_max_requests THEN
      RETURN false;
    END IF;

    -- Increment
    UPDATE public.guest_sessions
       SET ai_requests_used = ai_requests_used + 1,
           last_active_at   = now()
     WHERE fingerprint = p_fingerprint;

    RETURN true;
  END;
  $$;

  -- ── 3. Replace get_guest_ai_requests ─────────────────────────────────────────
  -- Returns current request count for display in the UI.
  -- Applies the same date-reset logic so the UI shows 0 correctly after midnight.
  CREATE OR REPLACE FUNCTION public.get_guest_ai_requests(p_fingerprint text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_requests   integer;
    v_reset_date date;
  BEGIN
    SELECT ai_requests_used, requests_reset_date
      INTO v_requests, v_reset_date
      FROM public.guest_sessions
     WHERE fingerprint = p_fingerprint;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('requests_used', 0, 'requests_limit', 3, 'can_request', true);
    END IF;

    -- Apply daily reset for UI accuracy (read-only, no UPDATE here)
    IF current_date > v_reset_date THEN
      v_requests := 0;
    END IF;

    RETURN jsonb_build_object(
      'requests_used',  v_requests,
      'requests_limit', 3,
      'can_request',    v_requests < 3
    );
  END;
  $$;

  -- ── 4. Re-apply grants ────────────────────────────────────────────────────────
  GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO anon;
  GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO service_role;

  GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO anon;
  GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO service_role;
  ```

- [ ] **Step 2: Apply the migration via Supabase CLI (if linked)**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  supabase db push
  ```

  If not using CLI (running against remote directly), apply via Supabase dashboard SQL editor:
  - Open Supabase dashboard → SQL Editor
  - Paste the full migration file content
  - Run

- [ ] **Step 3: Verify the column was added**

  In Supabase SQL editor or via CLI:
  ```sql
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'guest_sessions'
    AND column_name = 'requests_reset_date';
  ```

  Expected:
  ```
  column_name          | data_type | column_default
  requests_reset_date  | date      | CURRENT_DATE
  ```

- [ ] **Step 4: Verify fresh fingerprint allows 3 requests then blocks**

  In Supabase SQL editor:
  ```sql
  -- Use a unique test fingerprint
  SELECT public.check_and_increment_guest_ai_request('testfp001abc');  -- expect: true
  SELECT public.check_and_increment_guest_ai_request('testfp001abc');  -- expect: true
  SELECT public.check_and_increment_guest_ai_request('testfp001abc');  -- expect: true
  SELECT public.check_and_increment_guest_ai_request('testfp001abc');  -- expect: false (limit hit)
  ```

- [ ] **Step 5: Verify daily reset works**

  ```sql
  -- Simulate yesterday's date on the reset column
  UPDATE public.guest_sessions
     SET requests_reset_date = current_date - 1
   WHERE fingerprint = 'testfp001abc';

  -- Should now allow requests again (counter resets)
  SELECT public.check_and_increment_guest_ai_request('testfp001abc');  -- expect: true

  -- Verify counter reset to 1 (was reset to 0 then incremented)
  SELECT ai_requests_used, requests_reset_date
  FROM public.guest_sessions
  WHERE fingerprint = 'testfp001abc';
  -- expect: ai_requests_used=1, requests_reset_date=today
  ```

- [ ] **Step 6: Verify get_guest_ai_requests reflects reset**

  ```sql
  -- Set back to yesterday again on a fresh row
  UPDATE public.guest_sessions
     SET requests_reset_date = current_date - 1,
         ai_requests_used = 3
   WHERE fingerprint = 'testfp001abc';

  SELECT public.get_guest_ai_requests('testfp001abc');
  -- expect: {"requests_used": 0, "requests_limit": 3, "can_request": true}
  ```

- [ ] **Step 7: Clean up test row**

  ```sql
  DELETE FROM public.guest_sessions WHERE fingerprint = 'testfp001abc';
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd /home/xer0bit/Desktop/ecomgear-main
  git add supabase/migrations/20260616000001_guest_daily_reset.sql
  git commit -m "fix: add daily reset to guest AI request limit (3 requests per day)"
  ```

---

## Done

Both fixes are independent   Task 1 and Task 2 can be applied without Task 3, and vice versa.

**Verification after both are deployed:**
- `GET /health` on preview service shows `activeServers` never exceeds `MAX_ACTIVE_SERVERS`
- Guest users who were permanently blocked can generate again the next day
- Existing authenticated user flows are unaffected (no changes to `ai.routes.ts` or authenticated quota logic)
