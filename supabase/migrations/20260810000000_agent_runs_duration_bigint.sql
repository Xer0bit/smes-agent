-- 2026-08-10: fix the watchdog-killing int4 overflow in agent_runs.duration_ms
--
-- duration_ms is GENERATED ALWAYS AS
--   (EXTRACT(epoch FROM completed_at - started_at)::integer * 1000)
-- stored as int4. Setting completed_at on a row whose started_at is more than
-- ~24.86 days in the past overflows int4 (max 2147483647 ms), and because the
-- watchdog sweep (agentRunWatchdog.service.ts) updates all stale rows in ONE
-- statement, a single ancient row poisons the entire sweep: it failed with
-- "integer out of range" on every 5-minute tick (132 failures on 2026-08-09
-- alone) and never once succeeded. 17 rows were stuck in status='running'
-- (oldest since April), 15 of them past the overflow horizon.
--
-- Fix, in order:
--   1. Recreate the generated column as bigint with bigint math (drop+add is
--      the only way to change a generated column's type/expression; the table
--      is small and the value is recomputable, so nothing is lost).
--   2. One-time cleanup of the stuck-'running' backlog: mark failed with a
--      bounded completed_at so history stays readable. With bigint this would
--      no longer overflow anyway, but a 3-month "duration" is a lie -- cap it
--      at started_at + 20 minutes, matching what the watchdog would have done
--      had it worked.

ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS duration_ms;
ALTER TABLE public.agent_runs ADD COLUMN duration_ms bigint GENERATED ALWAYS AS (
  CASE
    WHEN completed_at IS NOT NULL
      THEN (EXTRACT(epoch FROM (completed_at - started_at)) * 1000)::bigint
    ELSE NULL::bigint
  END
) STORED;

UPDATE public.agent_runs
SET status        = 'failed',
    error_message = 'Marked failed by 20260810 stuck-run cleanup: row was abandoned in status=running (pre-watchdog-era crash) and its age overflowed the old int4 duration_ms, poisoning every watchdog sweep.',
    completed_at  = started_at + interval '20 minutes'
WHERE status = 'running'
  AND started_at < now() - interval '20 minutes';
