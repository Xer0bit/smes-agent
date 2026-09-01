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
/**
 * Must match the `user-projects-free` bucket's `file_size_limit` (raised from
 * 10 to 25 MiB on 2026-09-02). Binaries are stored as BINARY_SENTINEL + base64
 * (the format every reader expects, set by the browser's own save) and base64
 * inflates by ~4/3, so the effective ceiling on a raw file is about three
 * quarters of this. Checking the ENCODED length here turns an oversized file
 * into a reported per-file skip instead of an upload the bucket bounces.
 *
 * Overridable so the two can be realigned without a deploy if the bucket
 * changes again; a value SMALLER than the bucket's only costs a needless skip,
 * a larger one just means the bucket rejects it and the same skip path runs.
 */
const MAX_OBJECT_BYTES = Number(process.env.STORAGE_MAX_OBJECT_BYTES) || 25 * 1024 * 1024;

interface ManifestEntry { path: string; hash: string; source_revision: string }


/**
 * Rebuild the manifest once some uploads have failed.
 *
 * A path whose upload failed must not stay in the manifest pointing at THIS
 * revision: that entry resolves to a 404 for every later reader, which is worse
 * than the file being absent. Where the previous revision has a copy, point at
 * that instead so the file survives; where it does not, drop the path and
 * report it so the caller can tell the user rather than losing it in silence.
 */
export function reconcileManifestAfterFailures(
  manifest: readonly ManifestEntry[],
  failedPaths: readonly string[],
  prevByPath: ReadonlyMap<string, { hash: string; source_revision: string }>,
): { manifest: ManifestEntry[]; skipped: string[] } {
  if (failedPaths.length === 0) return { manifest: [...manifest], skipped: [] };
  const failed = new Set(failedPaths);
  const out: ManifestEntry[] = [];
  const skipped: string[] = [];
  for (const entry of manifest) {
    if (!failed.has(entry.path)) { out.push(entry); continue; }
    const prev = prevByPath.get(entry.path);
    if (prev) out.push({ path: entry.path, hash: prev.hash, source_revision: prev.source_revision });
    else skipped.push(entry.path);
  }
  return { manifest: out, skipped };
}

/** Encoded size the bucket will see, so an oversized file is skipped rather than bounced. */
export function exceedsObjectLimit(content: string, limit: number = MAX_OBJECT_BYTES): boolean {
  return Buffer.byteLength(content, 'utf8') > limit;
}

export async function persistAgentRevision(
  projectId: string,
  userId: string,
  files: Array<{ path: string; content: string }>,
  summary: string,
  prompt: string,
): Promise<{
  ok: boolean;
  revisionId?: string;
  error?: string;
  /** Paths absent from the revision because they could not be uploaded and had no earlier copy. */
  skippedPaths?: string[];
  uploadWarnings?: string[];
}> {
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

    const failedPaths: string[] = [];
    const uploadErrors: string[] = [];
    const noteFailure = (path: string, message: string) => {
      failedPaths.push(path);
      uploadErrors.push(`${path}: ${message}`);
    };

    for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH_SIZE) {
      const batch = toUpload.slice(i, i + UPLOAD_BATCH_SIZE);
      await Promise.all(batch.map(async (f) => {
        const body = Buffer.from(f.content, 'utf8');
        if (exceedsObjectLimit(f.content)) {
          noteFailure(f.path, `exceeds the ${Math.round(MAX_OBJECT_BYTES / 1024 / 1024)}MB storage limit once encoded (${Math.round(body.byteLength / 1024 / 1024)}MB)`);
          return;
        }
        const storagePath = `projects/${projectId}/${revisionId}/${f.path}`;
        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, body, { contentType: 'text/plain', upsert: true });
        if (upErr) noteFailure(f.path, upErr.message);
      }));
    }

    // A file that could not be uploaded must not appear in the manifest pointing
    // at THIS revision -- that entry would resolve to a 404 for every later
    // reader. Carry the previous revision's copy forward where one exists;
    // otherwise drop the path entirely.
    //
    // The whole revision used to fail instead. One 8.2 MiB image on CardPro
    // meant no manifest was written at all from 2026-09-01 13:00 onward, which
    // in turn left the project with no manifest-v1 HEAD -- so the per-run
    // sandbox silently stopped materialising from HEAD and fell back to copying
    // the stale shared disk, and the changeset diff had nothing to diff against
    // so every push shipped all 199 files. Losing one oversized asset from a
    // revision is a far smaller failure than losing the revision.
    const reconciled = reconcileManifestAfterFailures(manifest, failedPaths, prevByPath);
    const skipped = reconciled.skipped;
    manifest.length = 0;
    manifest.push(...reconciled.manifest);

    // Every file failed and none could be carried: there is no revision worth
    // writing, and claiming success would publish an empty HEAD.
    if (manifest.length === 0) {
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

    return {
      ok: true,
      revisionId,
      // Surfaced so the caller can log/report it: the revision IS good, but
      // these paths are not in it and the user should know which.
      skippedPaths: skipped.length > 0 ? skipped : undefined,
      uploadWarnings: uploadErrors.length > 0 ? uploadErrors.slice(0, 5) : undefined,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
