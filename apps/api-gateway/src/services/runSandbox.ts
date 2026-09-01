/**
 * Per-run isolated sandbox — Reconstruction 1 (file source of truth).
 * See docs/design/reconstruct-1-file-source-of-truth.md.
 *
 * The agent-runner disk used to be persistent and shared across every run of a
 * project, and the post-run collectDiskFiles() sweep turned it into a
 * contamination reservoir: one bad run's foreign files got re-collected and
 * re-persisted forever. This replaces that shared disk with a fresh, ephemeral
 * directory per run, materialized from the authoritative HEAD revision and
 * torn down at the end. There is no reservoir to sweep, so cross-project bleed
 * is structurally impossible rather than merely guarded against.
 *
 * The single source of truth is the latest Storage revision (manifest-v1).
 * A run: openSandbox (HEAD → fresh dir) → agent writes only in the dir →
 * commitSandbox (dir → new revision = new HEAD) → discardSandbox (always).
 * Rollback is a pointer, not a copy: a new revision whose manifest is the
 * target's manifest verbatim (content already in the bucket, zero re-upload).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { persistAgentRevision } from './agentRevisionPersist.service.js';

const STORAGE_BUCKET = 'user-projects-free';
// ponytail: sentinel is duplicated across ~7 files today (each redefines it);
// matching the prevailing pattern rather than introducing a shared export in
// this increment. Unify when the reconstruction touches the wire format.
const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';
const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', '.vite-cache', 'dist', 'build', '.tmp', 'coverage', '.cache']);
const SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production']);
const MAX_TEXT_FILE_SIZE = 512 * 1024;
const MAX_FILES = 5000;

/** Ephemeral runs root. Sibling of the projects dir on the runner, tmp locally. */
const RUNS_BASE_DIR = process.env.ECOMGEAR_RUNS_DIR
  || (process.env.ECOMGEAR_PROJECTS_DIR ? path.join(path.dirname(process.env.ECOMGEAR_PROJECTS_DIR), 'runs') : path.join(os.tmpdir(), 'ecomgear-runs'));

export interface Sandbox {
  sandboxPath: string;
  runId: string;
  headRevisionId: string | null;
  headPaths: ReadonlySet<string>;
}

export interface SandboxFile {
  path: string;
  content: string;
}

interface ManifestEntry {
  path?: unknown;
  hash?: unknown;
  source_revision?: unknown;
}

/** Latest revision's manifest = HEAD. Null when the project has no revision yet. */
async function fetchHeadManifest(
  projectId: string,
): Promise<{ revisionId: string; files: ManifestEntry[] } | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('revisions')
    .select('id, generated_files')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const gf = data?.generated_files as { format?: string; files?: ManifestEntry[] } | null;
  if (!data || gf?.format !== 'manifest-v1' || !Array.isArray(gf.files)) return null;
  return { revisionId: data.id, files: gf.files };
}

const SCAFFOLD_SKIP = new Set(['node_modules', '.git', '.vite', '.vite-cache', 'dist', 'build', '.tmp', '.cache', 'coverage']);

/** Symlink the run's node_modules to the persistent project dir's warm copy. */
function linkNodeModules(projectDir: string | undefined, sandboxPath: string, projectId: string): void {
  if (!projectDir) return;
  const src = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(src)) return;
  try {
    fs.symlinkSync(src, path.join(sandboxPath, 'node_modules'), 'dir');
  } catch (e) {
    logger.warn('[runSandbox] node_modules symlink failed (build tooling may be slow this run)', { projectId, error: (e as Error)?.message });
  }
}

/** Seed a brand-new project's sandbox from the pristine template scaffold on projectDir. */
function copyScaffoldSource(projectDir: string, sandboxPath: string): void {
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(projectDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SCAFFOLD_SKIP.has(e.name)) continue;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const to = path.join(sandboxPath, childRel);
      if (e.isDirectory()) { try { fs.mkdirSync(to, { recursive: true }); } catch { /* ok */ } walk(childRel); }
      else { try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(projectDir, childRel), to); } catch { /* skip */ } }
    }
  };
  walk('');
}

/**
 * Create a fresh per-run sandbox and populate its SOURCE.
 *
 * node_modules is symlinked to the persistent project dir's warm copy (builds
 * resolve; `npm install <pkg>` persists across runs; no ~480-package copy per
 * run). Source is the authoritative HEAD revision; a project with no HEAD yet
 * (brand new) is seeded from the pristine template scaffold the caller wrote to
 * projectDir. An EXISTING project NEVER reads projectDir's source -- that stale
 * shared disk is exactly the contamination reservoir this design removes.
 * Fail-open: any link/download error leaves a usable dir and the run proceeds.
 */
export async function openSandbox(projectId: string, projectDir?: string): Promise<Sandbox> {
  const runId = randomUUID();
  const sandboxPath = path.join(RUNS_BASE_DIR, projectId, runId);
  fs.mkdirSync(sandboxPath, { recursive: true });
  linkNodeModules(projectDir, sandboxPath, projectId);

  const head = await fetchHeadManifest(projectId);
  if (!head || !supabase) {
    if (projectDir) copyScaffoldSource(projectDir, sandboxPath);
    return { sandboxPath, runId, headRevisionId: null, headPaths: new Set() };
  }

  const headPaths = new Set<string>();
  let wrote = 0;
  let failed = 0;
  const BATCH = 12;
  for (let i = 0; i < head.files.length; i += BATCH) {
    await Promise.all(head.files.slice(i, i + BATCH).map(async (entry) => {
      const p = typeof entry.path === 'string' ? entry.path : '';
      const srcRev = typeof entry.source_revision === 'string' ? entry.source_revision : '';
      if (!p || !srcRev) return;
      headPaths.add(p);
      const { data: blob, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(`projects/${projectId}/${srcRev}/${p}`);
      if (error || !blob) { failed++; return; }
      const fp = path.join(sandboxPath, p);
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        if (BINARY_EXT_RE.test(p)) fs.writeFileSync(fp, Buffer.from(await blob.arrayBuffer()));
        else fs.writeFileSync(fp, await blob.text());
        wrote++;
      } catch { failed++; }
    }));
  }
  logger.info('[runSandbox] opened', { projectId, runId, headRevisionId: head.revisionId, wrote, failed, headFiles: headPaths.size });
  return { sandboxPath, runId, headRevisionId: head.revisionId, headPaths };
}

/**
 * The run's output file set: everything in the sandbox (HEAD ∪ this run's
 * writes), scoped by construction — the dir is a clean per-run copy, so there
 * is nothing foreign to exclude. Binaries travel as BINARY_SENTINEL+base64,
 * the same wire format persistAgentRevision and the preview push expect.
 */
export function collectSandboxFiles(sandboxPath: string): SandboxFile[] {
  const out: SandboxFile[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fp); continue; }
      const rel = path.relative(sandboxPath, fp);
      try {
        if (BINARY_EXT_RE.test(entry.name)) {
          out.push({ path: rel, content: `${BINARY_SENTINEL}${fs.readFileSync(fp).toString('base64')}` });
        } else {
          if (fs.statSync(fp).size > MAX_TEXT_FILE_SIZE) continue;
          out.push({ path: rel, content: fs.readFileSync(fp, 'utf8') });
        }
      } catch { /* unreadable file, skip */ }
    }
  };
  walk(sandboxPath);
  return out;
}

/** Commit the sandbox's file set as a new revision = new HEAD. */
export async function commitSandbox(
  sandbox: Sandbox,
  opts: { projectId: string; userId: string; summary: string; prompt: string },
): Promise<{ ok: boolean; revisionId?: string; files: SandboxFile[]; error?: string }> {
  const files = collectSandboxFiles(sandbox.sandboxPath);
  if (files.length === 0) return { ok: false, files, error: 'sandbox empty — nothing to commit' };
  const res = await persistAgentRevision(opts.projectId, opts.userId, files, opts.summary, opts.prompt);
  return { ok: res.ok, revisionId: res.revisionId, files, error: res.error };
}

/**
 * Roll back to a prior revision by pointer, not copy: write a NEW revision
 * whose manifest is the target's manifest verbatim. The content each entry
 * points at already lives in the bucket (source_revision is unchanged), so no
 * upload happens and history stays immutable and append-only — a stale FS
 * snapshot can never be re-injected. Returns the new HEAD's files so the
 * caller can push them to preview.
 */
export async function rollbackToRevision(
  projectId: string,
  userId: string,
  targetRevisionId: string,
): Promise<{ ok: boolean; revisionId?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'no supabase client' };
  const { data: target, error: fetchErr } = await supabase
    .from('revisions')
    .select('generated_files')
    .eq('id', targetRevisionId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (fetchErr || !target) return { ok: false, error: fetchErr?.message ?? 'target revision not found' };
  const gf = target.generated_files as { format?: string; files?: ManifestEntry[] } | null;
  if (gf?.format !== 'manifest-v1' || !Array.isArray(gf.files) || gf.files.length === 0) {
    return { ok: false, error: 'target revision has no usable manifest' };
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('revisions')
    .insert({
      project_id: projectId,
      user_id: userId,
      created_by: userId,
      prompt: `Rollback to revision ${targetRevisionId}`,
      generated_code: '',
      generated_files: { format: 'manifest-v1', files: gf.files },
      file_count: gf.files.length,
      summary: `Rolled back to revision ${targetRevisionId}`,
    })
    .select('id')
    .single();
  if (insertErr || !inserted) return { ok: false, error: insertErr?.message ?? 'rollback insert failed' };
  logger.info('[runSandbox] rolled back (pointer)', { projectId, targetRevisionId, newRevisionId: inserted.id, files: gf.files.length });
  return { ok: true, revisionId: inserted.id };
}

/** Tear down a sandbox. Best-effort — a failed cleanup never breaks a run. */
export function discardSandbox(sandboxPath: string): void {
  try { fs.rmSync(sandboxPath, { recursive: true, force: true }); }
  catch (err) { logger.debug('[runSandbox] discard failed (non-fatal)', { sandboxPath, error: (err as Error)?.message }); }
}

export interface SandboxDir {
  projectId: string;
  runId: string;
  sandboxPath: string;
  mtimeMs: number;
}

/**
 * Every run sandbox currently on disk.
 *
 * A sandbox is removed in the route's `finally`, which a killed worker never
 * reaches -- so each crash or deploy strands a full source tree under the runs
 * root with nothing that would ever remove it. This exposes them so a caller
 * that can judge liveness (the watchdog, which reads the same lock state the
 * route does) can clean up. Deliberately only reports: the deletion decision
 * needs liveness, and liveness needs the DB, which does not belong in here.
 */
export function listSandboxDirs(): SandboxDir[] {
  const out: SandboxDir[] = [];
  let projects: string[];
  try { projects = fs.readdirSync(RUNS_BASE_DIR); }
  catch { return out; } // no runs root yet is the normal cold state, not an error
  for (const projectId of projects) {
    const projectRuns = path.join(RUNS_BASE_DIR, projectId);
    let runIds: string[];
    try {
      if (!fs.statSync(projectRuns).isDirectory()) continue;
      runIds = fs.readdirSync(projectRuns);
    } catch { continue; }
    for (const runId of runIds) {
      const sandboxPath = path.join(projectRuns, runId);
      try {
        const st = fs.statSync(sandboxPath);
        if (!st.isDirectory()) continue;
        out.push({ projectId, runId, sandboxPath, mtimeMs: st.mtimeMs });
      } catch { /* vanished mid-scan: it is gone, which is the goal anyway */ }
    }
  }
  return out;
}

/**
 * Which sandboxes are safe to delete.
 *
 * Two independent conditions must both hold, because the cost of being wrong is
 * deleting a live run's working tree. A project with a live lock is excluded
 * outright, and on top of that the directory must be untouched for `minAgeMs` --
 * so even if lock state were somehow read wrong, a sandbox being actively
 * written to is still not a candidate.
 *
 * Nothing here tries to salvage a stranded sandbox's contents. A worker killed
 * mid-write leaves a tree of unknown consistency, and committing that as a
 * revision is precisely how a corrupt snapshot gets published: the run's own
 * completed writes are already in a revision, and anything after them is not
 * worth the risk of publishing a half-written file.
 */
export function selectOrphanedSandboxes(
  dirs: readonly SandboxDir[],
  liveProjectIds: ReadonlySet<string>,
  now: number,
  minAgeMs: number,
): SandboxDir[] {
  return dirs.filter((d) => !liveProjectIds.has(d.projectId) && now - d.mtimeMs > minAgeMs);
}

/** path -> sha256 from the HEAD revision manifest, for diffing a run's output. */
export async function fetchHeadHashes(projectId: string): Promise<Map<string, string>> {
  const head = await fetchHeadManifest(projectId);
  const map = new Map<string, string>();
  if (!head) return map;
  for (const e of head.files) {
    if (typeof e.path === 'string' && typeof e.hash === 'string') map.set(e.path, e.hash);
  }
  return map;
}

export interface FileDiff {
  added: SandboxFile[];
  changed: SandboxFile[];
  deleted: string[];
  unchanged: number;
}

/**
 * The run's REAL changeset: hash every produced file and compare against HEAD's
 * manifest hashes. Replaces "the whole tree is the output" -- without this a run
 * cannot tell what the agent actually changed from untouched cruft, and every
 * preview push ships the entire project.
 *
 * Hashing matches persistAgentRevision exactly (sha256 over the utf8 content),
 * so a file whose hash equals HEAD's is genuinely unchanged. Pure: no IO, so the
 * classification is unit-testable.
 */
export function diffFilesAgainstHead(
  files: SandboxFile[],
  headHashes: ReadonlyMap<string, string>,
): FileDiff {
  const added: SandboxFile[] = [];
  const changed: SandboxFile[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.path);
    const prev = headHashes.get(f.path);
    const hash = createHash('sha256').update(f.content ?? '', 'utf8').digest('hex');
    if (prev === undefined) added.push(f);
    else if (prev !== hash) changed.push(f);
    else unchanged++;
  }
  const deleted: string[] = [];
  for (const p of headHashes.keys()) if (!seen.has(p)) deleted.push(p);
  return { added, changed, deleted, unchanged };
}
