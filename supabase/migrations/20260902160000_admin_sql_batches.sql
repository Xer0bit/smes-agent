-- Staged admin SQL is executed as an ordered batch (one transaction, the
-- order the agent staged it) instead of one row at a time from a newest-first
-- list, which is how "relation does not exist" happened: the CREATE TABLE sat
-- below the INSERT that needed it. batch_id groups the rows of one agent run
-- so the chat can show them inline under the reply that staged them.
ALTER TABLE public.admin_sql_pending_changes ADD COLUMN IF NOT EXISTS batch_id text;
CREATE INDEX IF NOT EXISTS admin_sql_pending_changes_batch_idx
  ON public.admin_sql_pending_changes (project_id, batch_id, created_at);
