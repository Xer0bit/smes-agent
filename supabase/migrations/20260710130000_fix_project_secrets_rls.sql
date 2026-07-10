-- Fix: project_secrets RLS policies were hand-rolled against a `project_members`
-- table (role = 'editor') that is NOT the app's real access model. Every other
-- project-scoped table uses has_project_access() (owner, any org member, or an
-- explicit project_member_access grant). Result: for any org-owned project, the
-- browser's own RLS-scoped query returned zero rows even though the rows exist
-- (confirmed by the server's service-role sync endpoint reporting a nonzero
-- count) — the Secrets settings panel silently showed "No secrets yet".

drop policy if exists "project_secrets_select" on public.project_secrets;
drop policy if exists "project_secrets_insert" on public.project_secrets;
drop policy if exists "project_secrets_delete" on public.project_secrets;

create policy "project_secrets_select" on public.project_secrets
  for select using (public.has_project_access(project_id));

create policy "project_secrets_insert" on public.project_secrets
  for insert with check (public.has_project_access(project_id));

create policy "project_secrets_delete" on public.project_secrets
  for delete using (public.has_project_access(project_id));

-- There was never an UPDATE policy (server-side writes use the service role via
-- upsert; the browser UI does delete-then-insert). Add one for consistency now
-- that the check function is correct, so a future upsert-based UI change works.
create policy "project_secrets_update" on public.project_secrets
  for update using (public.has_project_access(project_id))
  with check (public.has_project_access(project_id));
