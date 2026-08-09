/**
 * Server-side revision persistence for agent runs (2026-08-10).
 *
 * Root cause this exists for (confirmed live, CardPro logo revert,
 * 2026-08-09): the agent loop pushed correct files to the live preview but
 * NEVER wrote a revision -- durable persistence was delegated to the
 * browser's fire-and-forget saveWorkspaceToDb() (Editor.tsx), which can
 * silently fail client-side with no server-observable trace. When it does,
 * revisions/Storage still describe the PRE-run state, and every later
 * Editor-side preview sync (page reload, refresh, revision load) faithfully
 * pushes that stale state back over the agent's work. Verified: the 18:38
 * run's changes existed only in the preview; the latest revision (17:52)
 * still listed the deleted file and lacked the new one.
 *
 * This makes the run itself authoritative: at run-end the server writes a
 * revision in the exact same manifest-v1 + dedup format the frontend's
 * revisionService.createRevision produces (INSERT new row -> upload only
 * changed files to user-projects-free at projects/{projectId}/{revisionId}/
 * {path} -> store lean manifest), so every existing reader
 * (WorkspaceContext.loadFromDatabase, revisionService.getRevisionFiles)
 * works unchanged. The Editor's own save paths are deliberately left in
 * place -- they cover manual edits and restores; after this, their
 * post-agent-run save just dedups against an already-correct manifest.
 *
 * Failure mode is safe by ordering: the manifest write is LAST, so a crash
 * mid-upload leaves a revision row whose generated_files is null --
 * loadFromDatabase's format check skips it and falls back to the previous
 * good revision, never a half-written one.
 */
import { createHash } from 'node:crypto';
import { supabase } from '../config/database.js';

const STORAGE_BUCKET = 'user-projects-free';
const UPLOAD_BATCH_SIZE = 5;

interface ManifestEntry { path: string; hash: string; source_revision: string }

export async function persistAgentRevision(
  projectId: string,
  userId: string,
  files: Array<{ path: string; content: string }>,
  summary: string,
  prompt: string,
): Promise<{ ok: boolean; revisionId?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'no supabase client' };
  if (files.length === 0) return { ok: false, error: 'no files' };

  try {
    // 1. Previous latest revision's manifest (for dedup), before inserting ours.
    const { data: prevRevData } = await supabase
      .from('revisions')
      .select('id, generated_files')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1);
    const prevByPath = new Map<string, { hash: string; source_revision: string }>();
    const prevManifest = prevRevData?.[0]?.generated_files;
    if (prevManifest?.format === 'manifest-v1' && Array.isArray(prevManifest.files)) {
      for (const f of prevManifest.files) prevByPath.set(f.path, { hash: f.hash, source_revision: f.source_revision });
    }

    // 2. Insert the revision row (manifest set last -- see failure-mode note above).
    const { data: inserted, error: insertErr } = await supabase
      .from('revisions')
      .insert({
        project_id: projectId,
        user_id: userId,
        created_by: userId,
        prompt,
        generated_code: '',
        generated_files: null,
      })
      .select('id')
      .single();
    if (insertErr || !inserted) return { ok: false, error: insertErr?.message ?? 'revision insert failed' };
    const revisionId: string = inserted.id;

    // 3. Hash + dedup: upload only files whose content changed since the
    //    previous manifest; unchanged files keep their old source_revision
    //    pointer (identical semantics to revisionService.createRevision).
    //    Binary files arrive as BINARY_SENTINEL-prefixed base64 strings and
    //    are hashed/uploaded as those strings -- the same round-trip the
    //    browser-side save already does today, so readers are unaffected.
    const manifest: ManifestEntry[] = [];
    const toUpload: Array<{ path: string; content: string }> = [];
    for (const f of files) {
      const content = f.content ?? '';
      const hash = createHash('sha256').update(content, 'utf8').digest('hex');
      const prev = prevByPath.get(f.path);
      if (prev && prev.hash === hash) {
        manifest.push({ path: f.path, hash, source_revision: prev.source_revision });
      } else {
        toUpload.push({ path: f.path, content });
        manifest.push({ path: f.path, hash, source_revision: revisionId });
      }
    }

    const uploadErrors: string[] = [];
    for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH_SIZE) {
      const batch = toUpload.slice(i, i + UPLOAD_BATCH_SIZE);
      await Promise.all(batch.map(async (f) => {
        const storagePath = `projects/${projectId}/${revisionId}/${f.path}`;
        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, Buffer.from(f.content, 'utf8'), { contentType: 'text/plain', upsert: true });
        if (upErr) uploadErrors.push(`${f.path}: ${upErr.message}`);
      }));
    }
    if (uploadErrors.length > 0) {
      return { ok: false, revisionId, error: `uploads failed: ${uploadErrors.slice(0, 3).join('; ')}` };
    }

    // 4. Manifest last.
    const { error: manifestErr } = await supabase
      .from('revisions')
      .update({
        generated_files: { format: 'manifest-v1', files: manifest },
        file_count: manifest.length,
        summary,
      })
      .eq('id', revisionId);
    if (manifestErr) return { ok: false, revisionId, error: `manifest write failed: ${manifestErr.message}` };

    return { ok: true, revisionId };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
