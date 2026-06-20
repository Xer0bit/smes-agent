-- Allow super_admin and admin roles to read all agent_runs for analytics
DROP POLICY IF EXISTS "Admins can read all agent_runs" ON agent_runs;
CREATE POLICY "Admins can read all agent_runs"
  ON agent_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role IN ('super_admin', 'admin')
    )
  );
