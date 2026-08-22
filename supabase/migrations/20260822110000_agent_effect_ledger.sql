-- Agent effect ledger -- Phase 1 of spatiotemporal composability adoption.
--
-- Basis: Shi, Zhang & Cui, "A Programming Paradigm for Spatiotemporal
-- Composability" (PKU + DeepSeek-AI, 2026), sections 3.1 (revertible effects)
-- and 6.1 (system boundary).
--
-- WHY THIS IS DURABLE RATHER THAN IN-MEMORY -- the one deliberate divergence
-- from the paper's reference implementation (Cordis). Cordis accumulates each
-- effect's inverse in a `dispose` closure chain held in process memory
-- (Algorithm 1), which is correct for its setting: a plugin is *unloaded*
-- cleanly, so the chain is still alive when recovery runs. Our components are
-- not unloaded, they are SIGKILLed -- OOM, `pm2 restart`, the 15s force-exit in
-- index.ts. An in-memory inverse dies with the memory that held it, which is
-- exactly how agent_locks rows leaked and wedged projects. So the inverse has
-- to outlive the process that registered it, which means Postgres.
--
-- BOUNDARY CLASSIFICATION (section 6.1). The paper draws the system boundary
-- per LOCATION, not per medium: a location is *inside* when the system can
-- modify it exclusively AND restore the prior state; *outside* when either
-- ability fails, in which case the operation is identity -- neither tracked nor
-- recovered. We make that classification explicit per effect rather than
-- pretending every effect has an inverse, because ours genuinely do not:
--
--   'inside'      -- exclusive + restorable. A true inverse exists and running
--                    it returns the location to its prior state (a lock row we
--                    alone own; a secret we alone set).
--   'compensable' -- crosses outside, but section 6.1's *compensation* applies:
--                    an action restoring state up to an equivalence the
--                    application supplies, coarser than exact equality (delete
--                    a file that was created; roll a preview back to its prior
--                    snapshot). Compensations compose in LIFO order just as
--                    inverses do.
--   'barrier'     -- crosses outside with no compensation we are willing to
--                    assert (a published container; a committed DDL migration
--                    against live customer data). Recorded for OBSERVABILITY
--                    only. Recovery stops at a barrier rather than silently
--                    skipping it -- half-reverted state is worse than
--                    un-reverted state, because it is silent.
--
-- Section 5.1.1 is explicit that Cordis does NOT verify an inverse actually
-- inverts: "that the inverse recovers the effect it accompanies is an
-- obligation on the component author rather than a property the runtime
-- verifies." Classifying honestly here is how we discharge that obligation
-- instead of assuming it.

CREATE TABLE IF NOT EXISTS public.agent_run_effects (
    id           bigserial PRIMARY KEY,
    -- The component instance whose effects these are. Cordis calls this a
    -- fiber; for us one agent run is one component instantiation.
    run_id       text        NOT NULL,
    project_id   uuid        NOT NULL,
    -- LIFO recovery order. Inverses must run newest-first (Algorithm 1 composes
    -- `inverse := value ∘ inverse`, so the most recent inverse runs first).
    seq          integer     NOT NULL,

    -- What was done, and to what. `target` is the location in section 6.1's
    -- sense -- the thing the boundary is drawn around.
    kind         text        NOT NULL,
    target       text        NOT NULL,

    boundary     text        NOT NULL
                 CHECK (boundary IN ('inside', 'compensable', 'barrier')),

    -- Enough to run the inverse/compensation later, from a DIFFERENT process
    -- than the one that recorded it. A closure cannot survive a SIGKILL; a
    -- payload can. NULL for a barrier, which has no recovery action.
    before_state jsonb,
    after_state  jsonb,

    recorded_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL while the effect still stands. Set when its inverse/compensation has
    -- run, so recovery is idempotent and a partially-recovered run is legible
    -- rather than ambiguous.
    reverted_at  timestamptz,
    -- Set when recovery was attempted and failed. An effect with a non-null
    -- revert_error is the operator's signal that a location is now in an
    -- unknown state -- exactly the case that must never pass silently.
    revert_error text,

    UNIQUE (run_id, seq)
);

-- Recovery scans one run newest-first.
CREATE INDEX IF NOT EXISTS agent_run_effects_run_seq_idx
    ON public.agent_run_effects (run_id, seq DESC);

-- "What is still standing for this project?" -- the query that replaces the
-- per-process activeAgentRuns Map as the cross-worker source of truth, and the
-- one that makes an orphaned effect visible instead of invisible.
CREATE INDEX IF NOT EXISTS agent_run_effects_unreverted_idx
    ON public.agent_run_effects (project_id, recorded_at DESC)
    WHERE reverted_at IS NULL;

-- Surfacing failed recovery is the whole point of recording revert_error; make
-- it cheap to ask.
CREATE INDEX IF NOT EXISTS agent_run_effects_failed_idx
    ON public.agent_run_effects (project_id)
    WHERE revert_error IS NOT NULL;

COMMENT ON TABLE public.agent_run_effects IS
    'Durable effect ledger for agent runs. Each row is one tracked context '
    'mutation plus the payload needed to invert or compensate it from another '
    'process. See the migration header for the inside/compensable/barrier '
    'classification and why this is durable rather than in-memory.';
