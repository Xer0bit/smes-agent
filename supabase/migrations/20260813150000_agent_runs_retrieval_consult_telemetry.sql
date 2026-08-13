-- Retrieval-consult telemetry (Checkpoint 4a of the agent-orchestration-
-- stability effort, measurement only -- no gate/nudge yet, see
-- docs/spec/agent-orchestration-stability.md). Records, per run, how many
-- write_file calls targeted a path that didn't exist on disk yet (net-new
-- writes) and how many of those happened before the agent had consulted a
-- retrieval tool (search_codebase/grep/glob_files) this run. The ratio of
-- these two columns aggregated across agent_runs is the retrieval skip rate
-- a later checkpoint (CP4b) uses to decide whether enforcement is justified.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS net_new_write_count integer DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS net_new_write_without_retrieval_count integer DEFAULT 0;
