/**
 * Project knowledge management: what the owner sees in Settings → Knowledge.
 *
 * List, add a note, archive/restore, delete. Content is the owner's own
 * project history, so it is returned in full; nothing here touches source
 * files or the agent's prompts directly.
 */
import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { createError } from '../middleware/error.middleware.js';
import { listKnowledge, recordKnowledge, estimateTokens } from '../services/knowledge.service.js';

const router = Router();

function getProjectId(req: AuthenticatedRequest): string | undefined {
  const fromQuery = req.query.project_id;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const fromBody = (req.body as { project_id?: unknown } | undefined)?.project_id;
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
}

async function requireProjectAccess(userId: string, projectId: string, res: Response): Promise<boolean> {
  try {
    await projectService.getProject(projectId, userId);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// ── GET /api/v1/knowledge?project_id= ────────────────────────────────────────
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    // How much of the code the agent's retrieval index covers, for the
    // "how the agent sees your code" line in Settings.
    const [chunks, indexed] = await Promise.all([
      listKnowledge(projectId),
      supabase.from('project_file_embeddings').select('updated_at', { count: 'exact', head: false })
        .eq('project_id', projectId).order('updated_at', { ascending: false }).limit(1),
    ]);
    res.json({
      chunks,
      codebase: { indexedFiles: indexed.count ?? 0, lastIndexedAt: indexed.data?.[0]?.updated_at ?? null },
    });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── POST /api/v1/knowledge  { project_id, heading, content } ─────────────────
// An owner-written note. Recorded like any other chunk, keyed by a fresh id.
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  const { heading, content } = (req.body ?? {}) as { heading?: unknown; content?: unknown };
  if (typeof heading !== 'string' || !heading.trim() || typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'heading and content are required.' });
    return;
  }
  try {
    const source_ref = `note-${Date.now().toString(36)}`;
    await recordKnowledge(projectId, [{ source: 'note', source_ref, heading, content }]);
    res.status(201).json({ ok: true, tokens: estimateTokens(content) });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── PATCH /api/v1/knowledge/:id  { project_id, archived } ────────────────────
router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  const { archived } = (req.body ?? {}) as { archived?: unknown };
  if (typeof archived !== 'boolean') { res.status(400).json({ error: 'archived (boolean) is required.' }); return; }
  try {
    const { error, count } = await supabase
      .from('project_knowledge')
      .update({ archived, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('project_id', projectId)
      .eq('id', req.params.id);
    if (error) throw new Error(error.message);
    if (!count) { res.status(404).json({ error: 'Chunk not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── DELETE /api/v1/knowledge/:id?project_id= ─────────────────────────────────
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { error, count } = await supabase
      .from('project_knowledge')
      .delete({ count: 'exact' })
      .eq('project_id', projectId)
      .eq('id', req.params.id);
    if (error) throw new Error(error.message);
    if (!count) { res.status(404).json({ error: 'Chunk not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

export default router;
