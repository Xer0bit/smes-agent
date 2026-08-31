/**
 * Make the persistent agent-runner disk (appPath) a materialized view of the
 * authoritative HEAD revision at run start (2026-08-31 incident).
 *
 * appPath (/var/ecomgear/projects/{id}) survives restarts and only ever gets
 * the generic template on init -- the project's real files just accumulate
 * across runs and are NEVER re-synced to the source of truth. A single
 * contaminated run (a bad semantic-cache hit) wrote another project's source
 * pages and a poisoned App.tsx onto that disk, and the post-run
 * collectDiskFiles() then swept them into EVERY subsequent run's output. No
 * amount of cleaning the revision/preview helped, because the run re-collected
 * the dirty disk. This is the "no single source of truth" fragility.
 *
 * Fix: before the agent runs, overwrite appPath with the HEAD revision's
 * content (authoritative -- fixes a poisoned App.tsx) and prune stray source
 * files HEAD does not have (removes the reservoir). Fail-open in every failure
 * mode: a new/empty project, a missing/tiny HEAD manifest, or any Storage/FS
 * error leaves the disk untouched and the run proceeds -- correctness of the
 * common path is never traded for this guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { computeStalePaths } from './agentFileReconcile.js';

const STORAGE_BUCKET = 'user-projects-free';
const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', '.vite-cache', 'dist', 'build', '.tmp']);

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/** All source-file paths currently on the disk (for prune comparison), src/ only. */
function listDiskSourcePaths(appPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else out.push(path.relative(appPath, fp));
    }
  };
  try { walk(path.join(appPath, 'src')); } catch { /* no src yet */ }
  return out;
}

export interface MaterializeResult {
  synced: boolean;
  wrote: number;
  pruned: number;
  reason?: string;
}

export async function materializeAgentDiskFromHead(projectId: string, appPath: string): Promise<MaterializeResult> {
  if (!supabase) return { synced: false, wrote: 0, pruned: 0, reason: 'no-supabase' };
  try {
    const { data: headRev } = await supabase
      .from('revisions')
      .select('generated_files')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const gf = headRev?.generated_files as { files?: Array<{ path?: unknown; source_revision?: unknown }> } | null;
    const manifest = Array.isArray(gf?.files) ? gf!.files : [];
    if (manifest.length === 0) return { synced: false, wrote: 0, pruned: 0, reason: 'no-head' };

    const headPaths = new Set(
      manifest.map((f) => (typeof f.path === 'string' ? f.path : '')).filter(Boolean),
    );

    // 1. Overwrite disk with authoritative HEAD content (fixes poisoned files).
    let wrote = 0;
    let failed = 0;
    const BATCH = 12;
    for (let i = 0; i < manifest.length; i += BATCH) {
      await Promise.all(manifest.slice(i, i + BATCH).map(async (entry) => {
        const p = typeof entry.path === 'string' ? entry.path : '';
        const srcRev = typeof entry.source_revision === 'string' ? entry.source_revision : '';
        if (!p || !srcRev) return;
        const { data: blob, error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .download(`projects/${projectId}/${srcRev}/${p}`);
        if (error || !blob) { failed++; return; }
        const fp = path.join(appPath, p);
        try {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          if (BINARY_EXT_RE.test(p)) fs.writeFileSync(fp, Buffer.from(await blob.arrayBuffer()));
          else fs.writeFileSync(fp, await blob.text());
          wrote++;
        } catch { failed++; }
      }));
    }
    // A large download-failure rate means we cannot trust the sync -- do NOT
    // prune (deleting against an incomplete baseline could remove real files).
    if (failed > manifest.length * 0.1) {
      logger.warn('[AgentDiskMaterialize] too many HEAD downloads failed; skipping prune', {
        projectId, wrote, failed, manifest: manifest.length,
      });
      return { synced: true, wrote, pruned: 0, reason: 'partial-download-no-prune' };
    }

    // 2. Prune stray source files HEAD does not have (the contamination reservoir).
    const stale = computeStalePaths(headPaths, listDiskSourcePaths(appPath));
    let pruned = 0;
    for (const rel of stale) {
      try { fs.unlinkSync(path.join(appPath, rel)); pruned++; } catch { /* already gone */ }
    }
    if (pruned > 0 || wrote > 0) {
      logger.info('[AgentDiskMaterialize] disk synced to HEAD revision', {
        projectId, wrote, pruned, staleSample: stale.slice(0, 8),
      });
    }
    return { synced: true, wrote, pruned };
  } catch (err: any) {
    logger.warn('[AgentDiskMaterialize] failed (non-fatal, run proceeds on existing disk)', {
      projectId, error: err?.message,
    });
    return { synced: false, wrote: 0, pruned: 0, reason: 'error' };
  }
}
