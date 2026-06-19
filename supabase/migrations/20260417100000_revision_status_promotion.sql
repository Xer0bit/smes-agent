-- Revision-promotion model: track candidate → validated → promoted → failed lifecycle
-- This enables "build-before-promote" so users always see a working preview.

-- Add revision_status column (default 'promoted' for backward compat with existing rows)
ALTER TABLE revisions
  ADD COLUMN IF NOT EXISTS revision_status text NOT NULL DEFAULT 'promoted';

-- Add build_check_output for storing validation/build diagnostics
ALTER TABLE revisions
  ADD COLUMN IF NOT EXISTS build_check_output text;

-- Add promoted_at timestamp
ALTER TABLE revisions
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

-- Index for querying latest promoted revision per project
CREATE INDEX IF NOT EXISTS idx_revisions_project_status
  ON revisions (project_id, revision_status, created_at DESC);

-- Update agent_runs to track promotion result
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS preview_promoted boolean DEFAULT false;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS preview_errors text;

-- Comment
COMMENT ON COLUMN revisions.revision_status IS 'Lifecycle: candidate → validated → promoted | failed';
COMMENT ON COLUMN revisions.build_check_output IS 'Validation/build error output when revision_status = failed';
COMMENT ON COLUMN revisions.promoted_at IS 'Timestamp when revision was promoted to live preview';
