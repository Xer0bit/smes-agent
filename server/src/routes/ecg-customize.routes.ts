import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService, getProjectServerPath } from '../services/project.service.js';
import { seedEcgTemplate } from '../services/ecg-template.js';
import { saveEcgRevision, syncEcgPreviewService } from './ecg-connect.routes.js';

const router = Router();
router.use(authMiddleware);

const ECOMGEAR_SERVER_URL = process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.ai';

interface EcgCustomizerRow {
  orgName: string;
  modules: string[];
  agentIds: string[];
  config: Record<string, unknown>;
}

async function loadCustomizerRow(projectId: string): Promise<EcgCustomizerRow | null> {
  const { data } = await supabase
    .from('project_settings')
    .select('setting_value')
    .eq('project_id', projectId)
    .eq('setting_key', 'ecg_customizer')
    .maybeSingle();
  return (data?.setting_value as EcgCustomizerRow) ?? null;
}

// GET /api/v1/ecg-connect/:projectId/customize
// Current design config, for the in-editor Customizer panel to pre-fill its form.
router.get('/:projectId/customize', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { projectId } = req.params;
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }

  const row = await loadCustomizerRow(projectId);
  if (!row) {
    res.status(404).json({ error: 'This project was not created via eCG Agent connect.' });
    return;
  }
  res.json({ config: row.config ?? {}, modules: row.modules ?? [] });
});

// POST /api/v1/ecg-connect/:projectId/customize
// Merges the posted partial design config into the stored one, re-runs
// seedEcgTemplate (same function the original connect handoff used) with the
// updated config, and pushes the result through the same revision + preview-
// service path   a real re-bake, not a one-time snapshot.
router.post('/:projectId/customize', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { projectId } = req.params;
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }

  const row = await loadCustomizerRow(projectId);
  if (!row) {
    res.status(404).json({ error: 'This project was not created via eCG Agent connect.' });
    return;
  }

  const patch = (req.body?.config ?? {}) as Record<string, unknown>;
  const mergedConfig = { ...row.config, ...patch };

  try {
    // Same local sandbox path ecg-connect.routes.ts computes at project
    // creation   keeps the agent's own file-read tools (which operate on this
    // path via ctx.appPath) in sync with the re-baked files, not just the
    // revision/preview copies.
    const serverPath = getProjectServerPath(req.user!.id, projectId);
    const files = seedEcgTemplate(serverPath, {
      orgName: row.orgName,
      modules: row.modules,
      agentIds: row.agentIds,
      config: mergedConfig,
      projectId,
      proxyUrl: ECOMGEAR_SERVER_URL,
    });
    const filesArray = Object.entries(files).map(([path, content]) => ({ path, content }));

    await saveEcgRevision(projectId, req.user!.id, filesArray, `eCG dashboard (customized)`);
    await syncEcgPreviewService(projectId, filesArray);

    await supabase.from('project_settings').update({
      setting_value: { ...row, config: mergedConfig },
      updated_at: new Date().toISOString(),
    }).eq('project_id', projectId).eq('setting_key', 'ecg_customizer');

    res.json({ success: true, config: mergedConfig });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Customize failed' });
  }
});

export default router;
