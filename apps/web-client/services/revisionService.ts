import { supabase } from '@/integrations/supabase/client';
import type { Project as SharedProject, GeneratedFile as SharedGeneratedFile } from '@/types/shared';

// Re-export shared types for backward compatibility
export type Project = SharedProject;
export type GeneratedFile = SharedGeneratedFile;

/** Content-addressed manifest stored in generated_files JSONB (small metadata, no file content). */
export interface RevisionManifest {
  format: 'manifest-v1';
  files: Array<{
    path: string;
    hash: string;
    /** The revision whose storage folder actually holds this file's content. */
    source_revision: string;
  }>;
}

async function sha256Hex(content: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface GeneratedFiles {
  files: GeneratedFile[];
  summary?: string;
}

export interface Revision {
  id: string;
  project_id: string;
  revision_number: number;
  prompt: string;
  summary?: string;
  // Not selected by getRevisions() (can be tens of MB per row)   fetch via
  // getRevisionFiles()/getLegacyGeneratedCode() for one specific revision.
  generated_code?: string;
  generated_files?: GeneratedFiles;
  preview_url?: string;
  preview_status?: 'pending' | 'building' | 'ready' | 'failed';
  file_attachments?: any;
  git_commit_hash?: string;
  git_branch?: string;
  is_published: boolean;
  created_at: string;
  user_id?: string;
}

export interface PublishedVersion {
  id: string;
  project_id: string;
  revision_id: string;
  version_tag: string;
  git_tag?: string;
  git_commit_hash?: string;
  deployment_url?: string;
  deployed_by?: string;
  status: string;
  published_at: string;
  revision_number?: number;
  prompt?: string;
}

/** True when a checked save was rejected because the head moved (M1). */
export function isStaleParentError(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err ?? '');
  return msg.includes('stale_parent');
}

// Binary-safe storage download. Most writers store binaries as
// '__ECOMGEAR_BIN64__' + base64 TEXT (safe through every JSON/utf8 hop),
// but some revisions hold RAW binary bytes (confirmed live 2026-08-18: a
// rollback revision stored a raw PNG; blob.text() then UTF-8-mangled it,
// every reload full-synced the mangled soup to the preview, and the user's
// logo corrupted on every project load -- the "disappearing logo" loop).
// Reading raw binaries as bytes and sentinel-wrapping them HERE makes the
// client immune to whatever format storage holds.
const BINARY_DOWNLOAD_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip)$/i;
const DOWNLOAD_BINARY_SENTINEL = '__ECOMGEAR_BIN64__';
async function blobToSyncContent(filePath: string, blob: Blob): Promise<string> {
  if (!BINARY_DOWNLOAD_EXT_RE.test(filePath)) return blob.text();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const prefix = new TextDecoder().decode(bytes.subarray(0, DOWNLOAD_BINARY_SENTINEL.length));
  if (prefix === DOWNLOAD_BINARY_SENTINEL) return new TextDecoder().decode(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return DOWNLOAD_BINARY_SENTINEL + btoa(bin);
}

// Build/dependency artifacts that regenerate on their own -- comparing these
// would make an unchanged project look "changed" on every publish check.
const NON_SOURCE_PATH = /(^|\/)(node_modules|dist|build|\.git|\.cache)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)$/;

/**
 * Deterministic content hash over a file set (path + per-file SHA-256, same
 * primitive the revision manifest uses), skipping non-source paths. Used to
 * gate republish: if this matches the hash stored at the last publish,
 * nothing that would actually change the live site has changed.
 */
export async function computePublishFilesHash(files: { path: string; content: string }[]): Promise<string> {
  const perFile = await Promise.all(
    files
      .filter((f) => !NON_SOURCE_PATH.test(f.path))
      .map(async (f) => `${f.path}:${await sha256Hex(f.content ?? '')}`)
  );
  perFile.sort();
  return sha256Hex(perFile.join('\n'));
}

export const revisionService = {
  async createProject(name: string, userId: string, organizationId?: string): Promise<Project> {
    // Validate userId
    const isValidUUID = (id: string | null | undefined) => {
      if (!id) return false
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    }
    if (!isValidUUID(userId)) throw new Error('Invalid userId')

    const { data, error } = await supabase
      .from('projects')
      .insert({ name, user_id: userId, created_by: userId, organization_id: organizationId ?? null })
      .select('*')
      .maybeSingle();

    if (error || !data) throw new Error(error?.message || 'Failed to create project');

    // Initialize project folder structure in storage
    const { projectLifecycleService } = await import('./projectLifecycleService');
    await projectLifecycleService.initializeProject(data.id, userId);

    return data as Project;
  },

  async getProjects(userId: string): Promise<Project[]> {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        revisions(count)
      `)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message);

    return (data || []).map(p => ({
      ...p,
      revision_count: p.revisions?.[0]?.count || 0
    }));
  },

  async createRevision(params: {
    project_id: string;
    prompt: string;
    generated_code: string;
    generated_files?: GeneratedFiles; // Temporary - will be cleaned after upload
    file_attachments?: any;
    git_commit_hash?: string;
    git_branch?: string;
    user_id?: string;
    /**
     * Lazy-editor support: paths whose content was never downloaded this
     * session. Their previous-manifest entries (path + hash + source_revision)
     * are carried into the new manifest VERBATIM -- no fetch, no re-hash, no
     * re-upload. Only pass paths the user did NOT touch (an unloaded file the
     * user deleted must be excluded by the caller, or it would resurrect).
     */
    carry_paths?: Set<string>;
    /**
     * M1 optimistic concurrency: the revision id this save is based on
     * (null = caller believes the project has no revisions yet). When set,
     * the insert goes through the create_revision_checked RPC, which rejects
     * the save with a 'stale_parent' error if the head has moved -- the fix
     * for a stale tab republishing old content over newer work (2026-08-16
     * clobber incident). Callers catch isStaleParentError(), refresh their
     * base, and retry. Omitted (undefined) keeps the legacy unchecked insert
     * for callers that intentionally append to whatever head exists (e.g.
     * revision restore).
     */
    expected_parent_id?: string | null;
  }): Promise<string> {
    console.log('[RevisionService] Creating revision for project:', params.project_id);

    const generatedFiles = params.generated_files ?? params.file_attachments ?? null; // Temporary

    // Auto-generate summary if not provided
    let summary: string | undefined;
    if (params.generated_files?.files) {
      const files = params.generated_files.files;
      const fileNames = files.map(f => f.path.split('/').pop()).join(', ');
      const operation = files.some(f => f.operation === 'create') ? 'Created' : 'Updated';
      summary = `${operation} ${files.length} file${files.length === 1 ? '' : 's'}: ${fileNames}`;
    }

    let data: { id: string } | null;
    let error: { message?: string } | null;

    if (params.expected_parent_id !== undefined) {
      const rpc = await supabase.rpc('create_revision_checked', {
        p_project_id: params.project_id,
        p_expected_parent: params.expected_parent_id,
        p_prompt: params.prompt,
        p_generated_code: params.generated_code,
        p_generated_files: generatedFiles,
        p_summary: summary ?? null,
        p_user_id: params.user_id ?? null,
      });
      data = rpc.data as { id: string } | null;
      error = rpc.error;
    } else {
      const insertData: any = {
        project_id: params.project_id,
        prompt: params.prompt,
        generated_code: params.generated_code,
        generated_files: generatedFiles,
      };
      if (summary) insertData.summary = summary;
      if (params.user_id) {
        insertData.user_id = params.user_id;
        insertData.created_by = params.user_id;
      }
      const ins = await supabase.from('revisions').insert(insertData).select().single();
      data = ins.data;
      error = ins.error;
    }

    if (error || !data) {
      console.error('[RevisionService] Error creating revision:', error);
      throw error ?? new Error('Revision insert returned no row');
    }

    console.log('[RevisionService] Revision created:', data.id);

    // ── Dedup-aware file upload ───────────────────────────────────────────────
    // Only upload files whose content changed since the previous revision.
    // Unchanged files point to the previous revision's storage entry in the manifest.
    if (params.generated_files?.files && params.generated_files.files.length > 0) {
      const newFiles = params.generated_files.files;

      // Fetch previous revision manifest (if any)
      let prevManifest: RevisionManifest | null = null;
      const { data: prevRevData } = await supabase
        .from('revisions')
        .select('id, generated_files')
        .eq('project_id', params.project_id)
        .neq('id', data.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (prevRevData?.[0]?.generated_files?.format === 'manifest-v1') {
        prevManifest = prevRevData[0].generated_files as RevisionManifest;
      }

      // Build a hash → source_revision map from the previous manifest
      const prevByPath = new Map<string, { hash: string; source_revision: string }>();
      if (prevManifest) {
        for (const f of prevManifest.files) {
          prevByPath.set(f.path, { hash: f.hash, source_revision: f.source_revision });
        }
      }

      // Compute hashes and decide which files to upload
      const manifest: RevisionManifest = { format: 'manifest-v1', files: [] };
      const toUpload: { path: string; content: string }[] = [];

      await Promise.all(
        newFiles.map(async (file) => {
          const hash = await sha256Hex(file.content ?? '');
          const prev = prevByPath.get(file.path);
          if (prev && prev.hash === hash) {
            // Identical content   point at the previous source revision
            manifest.files.push({ path: file.path, hash, source_revision: prev.source_revision });
          } else {
            // Changed or new   upload to this revision
            toUpload.push({ path: file.path, content: file.content ?? '' });
            manifest.files.push({ path: file.path, hash, source_revision: data.id });
          }
        })
      );

      // Manifest-carry: never-downloaded files keep their previous entry
      // verbatim. Guard against double-entry when a carried path was somehow
      // also provided with content (provided content wins).
      if (params.carry_paths && params.carry_paths.size > 0) {
        const providedPaths = new Set(newFiles.map((f) => f.path));
        let carried = 0;
        for (const carryPath of params.carry_paths) {
          if (providedPaths.has(carryPath)) continue;
          const prev = prevByPath.get(carryPath);
          if (prev) {
            manifest.files.push({ path: carryPath, hash: prev.hash, source_revision: prev.source_revision });
            carried++;
          } else {
            console.warn(`[RevisionService] carry path "${carryPath}" missing from previous manifest -- dropped from new revision`);
          }
        }
        if (carried > 0) console.log(`[RevisionService] Carried ${carried} unloaded file entries from previous manifest`);
      }

      if (toUpload.length > 0) {
        console.log(`[RevisionService] Uploading ${toUpload.length}/${newFiles.length} changed files (${newFiles.length - toUpload.length} deduplicated)`);
        const { storageService } = await import('./storageService');
        const uploadResult = await storageService.saveProjectFiles(params.project_id, data.id, toUpload);
        if (!uploadResult.success) {
          console.error('[RevisionService] Failed to upload files to storage:', uploadResult.error);
          throw new Error('Failed to save files to storage');
        }
        console.log('[RevisionService] ✓ Changed files uploaded');
      } else {
        console.log('[RevisionService] ✓ All files deduplicated   no upload needed');
      }

      // Store the manifest (small metadata only, no file content). Files are
      // already safely uploaded to Storage above   only this row-level
      // "swap to lean format" step can still fail, so retry once for
      // transient blips. This used to warn-and-forget on failure, which is
      // why 100% of production revisions were still storing full inline
      // content: every single manifest write had been silently failing with
      // nothing ever surfacing it (found 2026-07-22, 130/130 revisions never
      // converted, 16 rows over 1MB, one over 40MB served whole on every load).
      let manifestError = (await supabase
        .from('revisions')
        .update({ generated_files: manifest as any, file_count: manifest.files.length })
        .eq('id', data.id)).error;

      if (manifestError) {
        console.warn('[RevisionService] Manifest write failed, retrying once:', manifestError.message);
        manifestError = (await supabase
          .from('revisions')
          .update({ generated_files: manifest as any, file_count: manifest.files.length })
          .eq('id', data.id)).error;
      }

      if (manifestError) {
        // Not thrown: the row already holds valid (if bloated) content from the
        // initial insert, so the revision itself is still usable   this failure
        // only means it stays in the slow/large legacy format. Loud and specific
        // so it's actually greppable instead of vanishing into a console.warn.
        console.error(
          `[RevisionService] MANIFEST WRITE FAILED after retry for revision ${data.id} (project ${params.project_id}): ` +
          `${manifestError.message} ${manifestError.details ?? ''} ${manifestError.hint ?? ''}   ` +
          `this revision will keep serving its full inline content on every load until repaired.`
        );
      } else {
        console.log('[RevisionService] ✓ Manifest stored');
      }
    }

    return data.id;
  },

  /**
   * Load all files for a specific revision.
   * Resolves the manifest (manifest-v1) to reconstruct the full file set,
   * fetching only the unique blobs needed (dedup-aware).
   * Falls back to direct storage listing for legacy revisions without a manifest.
   */
  /**
   * Fetch ONLY the manifest (paths + hashes, tens of KB) for a revision.
   * Returns null for legacy revisions without a manifest -- callers fall back
   * to the full getRevisionFiles() path.
   */
  /**
   * Latest revision id + created_at for a project. created_at is the DB
   * clock, which is what preview baseSeq comparisons must use -- never the
   * browser clock (a client minutes ahead would poison the preview's
   * fast-forward guard and 409 legitimate agent pushes).
   */
  async getHeadRevisionMeta(projectId: string): Promise<{ id: string; created_at: string } | null> {
    const { data } = await supabase
      .from('revisions')
      .select('id, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1);
    return data?.[0] ?? null;
  },

  async getRevisionManifest(revisionId: string): Promise<RevisionManifest | null> {
    const { data, error } = await supabase
      .from('revisions')
      .select('generated_files')
      .eq('id', revisionId)
      .single();
    if (error || !data) return null;
    if ((data.generated_files as any)?.format === 'manifest-v1') {
      return data.generated_files as unknown as RevisionManifest;
    }
    return null;
  },

  /**
   * Fetch ONE file's content via the per-file storage layout
   * (projects/{projectId}/{source_revision}/{path}). No new backend endpoint:
   * this is the same authenticated download getRevisionFiles() already does
   * per file, just for a single path.
   */
  async getRevisionFile(projectId: string, manifest: RevisionManifest, filePath: string): Promise<string | null> {
    const entry = manifest.files.find((f) => f.path === filePath);
    if (!entry) return null;
    const storagePath = `projects/${projectId}/${entry.source_revision}/${filePath}`;
    const { data: blob, error } = await supabase.storage
      .from('user-projects-free')
      .download(storagePath);
    if (error || !blob) {
      console.warn(`[RevisionService] Single-file download failed for ${storagePath}:`, error?.message);
      return null;
    }
    return blobToSyncContent(filePath, blob);
  },

  async getRevisionFiles(projectId: string, revisionId: string): Promise<{ path: string; content: string }[]> {
    // Only fetch generated_files   generated_code is pulled separately by
    // getLegacyGeneratedCode() as an absolute last-resort fallback, so we
    // never need both columns in one request.  Fetching both here was pulling
    // 35MB+ payloads for revisions with large inline JSONB content.
    const { data, error } = await supabase
      .from('revisions')
      .select('generated_files')
      .eq('id', revisionId)
      .single();

    if (error || !data) return [];

    // ── manifest-v1: resolve files from their source revisions ────────────────
    if ((data.generated_files as any)?.format === 'manifest-v1') {
      const manifest = data.generated_files as unknown as RevisionManifest;
      const STORAGE_BUCKET = 'user-projects-free';

      // Flatten to (path, storagePath) pairs, then download in bounded
      // batches with one retry pass. The old code fired EVERY file's
      // download concurrently (188+ parallel requests on a real project)
      // and SILENTLY SKIPPED any that failed -- storage throttling made the
      // largest files (base64 images) the likeliest casualties, and the
      // Editor then pushed the incomplete set as a fullSync, whose prune
      // DELETED the missing files from the live preview. That is the
      // "my logo disappears when I reload" bug.
      const targets = manifest.files.map((f) => ({
        path: f.path,
        storagePath: `projects/${projectId}/${f.source_revision}/${f.path}`,
      }));

      const files: { path: string; content: string }[] = [];
      const downloadOne = async (t: { path: string; storagePath: string }): Promise<boolean> => {
        const { data: blob, error: dlErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .download(t.storagePath);
        if (dlErr || !blob) return false;
        files.push({ path: t.path, content: await blobToSyncContent(t.path, blob) });
        return true;
      };

      const BATCH = 12;
      let failed: Array<{ path: string; storagePath: string }> = [];
      for (let i = 0; i < targets.length; i += BATCH) {
        const results = await Promise.all(targets.slice(i, i + BATCH).map(downloadOne));
        results.forEach((ok, j) => { if (!ok) failed.push(targets[i + j]); });
      }
      if (failed.length > 0) {
        const retryResults = await Promise.all(failed.map(downloadOne));
        failed = failed.filter((_, j) => !retryResults[j]);
      }
      if (failed.length > 0) {
        console.warn(
          `[RevisionService] ${failed.length}/${targets.length} file(s) failed to download after retry:`,
          failed.slice(0, 5).map((t) => t.path),
        );
      }
      return files;
    }

    // ── Legacy JSONB format (content stored inline) ───────────────────────────
    if ((data.generated_files as any)?.files?.length > 0) {
      return (data.generated_files as any).files as { path: string; content: string }[];
    }

    // ── Oldest fallback: raw storage listing ─────────────────────────────────
    const { storageService } = await import('./storageService');
    const result = await storageService.loadProjectFiles(projectId, revisionId);
    return result.files;
  },

  /**
   * Same as getRevisionFiles(), but binary assets (images, fonts, etc.) are
   * read as base64 instead of .text()   .text() mangles binary bytes via
   * UTF-8 decoding, which is fine for the in-editor code view (nothing tries
   * to render those files as text there) but corrupts the file for any export
   * path that needs the original bytes back, like pushing to GitHub.
   */
  async getRevisionFilesForExport(
    projectId: string,
    revisionId: string
  ): Promise<{ path: string; content: string; encoding?: 'base64' }[]> {
    const BINARY_EXTENSIONS = new Set([
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
      'woff', 'woff2', 'ttf', 'eot', 'otf',
      'mp4', 'webm', 'mp3', 'wav', 'ogg',
      'pdf', 'zip',
    ]);
    const isBinary = (p: string) => BINARY_EXTENSIONS.has(p.split('.').pop()?.toLowerCase() ?? '');

    const { data, error } = await supabase
      .from('revisions')
      .select('generated_files')
      .eq('id', revisionId)
      .single();
    if (error || !data) return [];

    if ((data.generated_files as any)?.format === 'manifest-v1') {
      const manifest = data.generated_files as unknown as RevisionManifest;
      const STORAGE_BUCKET = 'user-projects-free';
      const byRevision = new Map<string, string[]>();
      for (const f of manifest.files) {
        const list = byRevision.get(f.source_revision) ?? [];
        list.push(f.path);
        byRevision.set(f.source_revision, list);
      }

      const files: { path: string; content: string; encoding?: 'base64' }[] = [];
      await Promise.all(
        Array.from(byRevision.entries()).map(([srcRevId, paths]) =>
          Promise.all(
            paths.map(async (filePath) => {
              const storagePath = `projects/${projectId}/${srcRevId}/${filePath}`;
              const { data: blob, error: dlErr } = await supabase.storage
                .from(STORAGE_BUCKET)
                .download(storagePath);
              if (dlErr || !blob) {
                console.warn(`[RevisionService] Could not download ${storagePath}:`, dlErr?.message);
                return;
              }
              if (isBinary(filePath)) {
                const buf = new Uint8Array(await blob.arrayBuffer());
                let binary = '';
                for (const byte of buf) binary += String.fromCharCode(byte);
                files.push({ path: filePath, content: btoa(binary), encoding: 'base64' });
              } else {
                files.push({ path: filePath, content: await blob.text() });
              }
            })
          )
        )
      );
      return files;
    }

    if ((data.generated_files as any)?.files?.length > 0) {
      return (data.generated_files as any).files as { path: string; content: string }[];
    }

    const { storageService } = await import('./storageService');
    const result = await storageService.loadProjectFiles(projectId, revisionId);
    return result.files;
  },

  /**
   * List revisions for the history panel / "latest revision" lookups.
   * Deliberately excludes generated_code/generated_files/file_attachments  
   * those can be tens of MB per row, and every list caller only needs
   * metadata + preview status. Callers that need actual file content must
   * fetch it per-revision via getRevisionFiles()/getLegacyGeneratedCode().
   */
  async getRevisions(projectId: string, limit = 50, offset = 0): Promise<Revision[]> {
    console.log('[RevisionService] Fetching revisions for project:', projectId, 'limit:', limit, 'offset:', offset);

    const { data, error } = await supabase
      .from('revisions')
      .select(`
        id,
        project_id,
        revision_number,
        prompt,
        summary,
        is_published,
        created_at,
        user_id,
        git_commit_hash,
        git_branch,
        revision_preview (
          preview_url,
          cloudflare_url,
          preview_status
        )
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[RevisionService] Error fetching revisions:', error);
      throw error;
    }

    console.log('[RevisionService] Fetched revisions:', data?.length || 0);

    // Flatten the preview data into the revision object, prefer cloudflare_url over preview_url
    return (data || []).map(rev => ({
      ...rev,
      preview_url: (rev.revision_preview as any)?.cloudflare_url || (rev.revision_preview as any)?.preview_url,
      preview_status: (rev.revision_preview as any)?.preview_status || 'pending',
    })) as unknown as Revision[];
  },

  /** Fetch the legacy `generated_code` string for one revision (rare fallback path). */
  async getLegacyGeneratedCode(revisionId: string): Promise<string> {
    const { data, error } = await supabase
      .from('revisions')
      .select('generated_code')
      .eq('id', revisionId)
      .single();
    if (error || !data) return '';
    return data.generated_code ?? '';
  },

  /**
   * Wait for build to complete by polling revision_preview table
   * Returns the preview URL when ready or throws on failure/timeout
   */
  async waitForBuildCompletion(revisionId: string, maxWaitMs = 120000): Promise<string | null> {
    console.log('[RevisionService] Waiting for build completion:', revisionId);
    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const { data, error } = await supabase
        .from('revision_preview')
        .select('preview_status, cloudflare_url, preview_url, build_error')
        .eq('revision_id', revisionId)
        .single();

      if (error) {
        console.error('[RevisionService] Failed to check build status:', error);
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      if (!data) {
        console.log('[RevisionService] No preview data yet, waiting...');
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      console.log('[RevisionService] Build status:', data.preview_status);

      if (data.preview_status === 'ready') {
        const previewUrl = data.cloudflare_url || data.preview_url;
        console.log('[RevisionService] Build complete! URL:', previewUrl);
        return previewUrl;
      }

      if (data.preview_status === 'failed') {
        const errorMsg = data.build_error || 'Build failed';
        console.error('[RevisionService] Build failed:', errorMsg);
        throw new Error(errorMsg);
      }

      // Still building, wait before next check
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error('Build timeout - exceeded 2 minutes');
  },

  async publishVersion(params: {
    project_id: string;
    revision_id: string;
    version_tag: string;
    git_tag?: string;
    git_commit_hash?: string;
    deployment_url?: string;
    deployed_by?: string;
  }): Promise<PublishedVersion> {
    const { data, error } = await supabase
      .from('published_versions')
      .insert({
        project_id: params.project_id,
        revision_id: params.revision_id,
        version_tag: params.version_tag,
        git_tag: params.git_tag,
        git_commit_hash: params.git_commit_hash,
        deployment_url: params.deployment_url,
        deployment_status: 'active',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  },

  async getPublishedVersions(projectId: string): Promise<PublishedVersion[]> {
    const { data, error } = await supabase
      .from('published_versions')
      .select(`
        *,
        revisions(revision_number, prompt)
      `)
      .eq('project_id', projectId)
      .order('published_at', { ascending: false });

    if (error) throw new Error(error.message);

    return (data || []).map(pv => ({
      ...pv,
      revision_number: pv.revisions?.[0]?.revision_number,
      prompt: pv.revisions?.[0]?.prompt
    }));
  },

  async deleteRevision(revisionId: string, userId: string, projectId: string, revisionNumber: number): Promise<void> {
    console.log('[RevisionService] Deleting revision:', revisionId);

    // Delete from database
    const { error } = await supabase
      .from('revisions')
      .delete()
      .eq('id', revisionId);

    if (error) {
      console.error('[RevisionService] Error deleting revision:', error);
      throw error;
    }

    console.log('[RevisionService] Revision deleted successfully');
  },

  async deleteProject(projectId: string, userId: string): Promise<void> {
    console.log('[RevisionService] Soft-deleting project:', projectId);

    // Soft-delete: move files to trash with 1-hour recovery window
    const { projectLifecycleService } = await import('./projectLifecycleService');
    const result = await projectLifecycleService.softDeleteProject(projectId);

    if (!result.success) {
      throw new Error(result.error || 'Failed to soft-delete project files');
    }

    console.log(`[RevisionService] Project moved to trash. Recovery deadline: ${result.recoveryDeadline}`);

    // Mark project as deleted in database (soft delete)
    const { error } = await supabase
      .from('projects')
      .update({
        status: 'deleted',
        updated_at: new Date().toISOString()
      })
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) throw error;
    console.log('[RevisionService] Project marked as deleted');
  },

  /**
   * Recover a deleted project (within 1-hour window)
   */
  async recoverProject(projectId: string, userId: string): Promise<void> {
    console.log('[RevisionService] Recovering project:', projectId);

    const { projectLifecycleService } = await import('./projectLifecycleService');
    const result = await projectLifecycleService.recoverProject(projectId);

    if (!result.success) {
      throw new Error(result.error || 'Failed to recover project');
    }

    // Restore project status in database
    const { error } = await supabase
      .from('projects')
      .update({
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) throw error;
    console.log('[RevisionService] Project recovered successfully');
  },

  /**
   * Permanently delete a project (no recovery)
   * Cleans up ALL related data: storage files, revisions, messages, previews, etc.
   */
  async permanentlyDeleteProject(projectId: string, userId: string): Promise<void> {
    console.log('[RevisionService] Permanently deleting project:', projectId);

    // 1. Delete storage files (from both trash and active locations)
    const { projectLifecycleService } = await import('./projectLifecycleService');
    await projectLifecycleService.permanentlyDeleteProject(projectId, true); // from trash
    await projectLifecycleService.permanentlyDeleteProject(projectId, false); // from active
    console.log('[RevisionService] ✓ Storage files deleted');

    // 2. Delete revision_preview records (may not CASCADE)
    const { error: previewError } = await supabase
      .from('revision_preview')
      .delete()
      .eq('project_id', projectId);
    if (previewError) {
      console.warn('[RevisionService] Failed to delete revision_preview:', previewError);
    } else {
      console.log('[RevisionService] ✓ Revision previews deleted');
    }

    // 3. Delete published_versions
    const { error: pubError } = await supabase
      .from('published_versions')
      .delete()
      .eq('project_id', projectId);
    if (pubError) {
      console.warn('[RevisionService] Failed to delete published_versions:', pubError);
    } else {
      console.log('[RevisionService] ✓ Published versions deleted');
    }

    // 4. Delete revisions
    const { error: revError } = await supabase
      .from('revisions')
      .delete()
      .eq('project_id', projectId);
    if (revError) {
      console.warn('[RevisionService] Failed to delete revisions:', revError);
    } else {
      console.log('[RevisionService] ✓ Revisions deleted');
    }

    // 5. Delete messages
    const { error: msgError } = await supabase
      .from('messages')
      .delete()
      .eq('project_id', projectId);
    if (msgError) {
      console.warn('[RevisionService] Failed to delete messages:', msgError);
    } else {
      console.log('[RevisionService] ✓ Messages deleted');
    }

    // 6. Delete project_settings, project_member_access, project_members, etc.
    const relatedTables = [
      'project_settings',
      'project_member_access',
      'project_members',
      'project_custom_domains',
      'project_subdomains',
      'project_billing',
      'project_add_ons',
      'ai_generations',
      'file_history',
      'build_logs',
      'preview_sessions',
      'agent_task_logs',
      'ai_agents',
    ];

    for (const table of relatedTables) {
      try {
        const { error } = await supabase
          .from(table)
          .delete()
          .eq('project_id', projectId);
        if (error) {
          console.warn(`[RevisionService] Failed to delete from ${table}:`, error.message);
        }
      } catch (e) {
        // Table might not exist, ignore
      }
    }
    console.log('[RevisionService] ✓ Related tables cleaned');

    // 7. Finally delete the project itself
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) throw error;
    console.log('[RevisionService] ✓ Project permanently deleted');
  },

  async getLatestPreviewUrl(projectId: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('get_latest_preview_url', { p_project_id: projectId });
    if (error || !data) return null;
    return data;
  },
};
