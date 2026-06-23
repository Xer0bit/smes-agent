import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validateRequest, schemas } from '../middleware/validation.middleware.js';
import { projectService } from '../services/project.service.js';
import { captureThumbnail } from '../services/thumbnailService.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List projects
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const projects = await projectService.listProjects(req.user!.id);
        res.json({ projects });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Get project
router.get('/:projectId', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const project = await projectService.getProject(
            req.params.projectId,
            req.user!.id
        );
        res.json({ project });
    } catch (error) {
        const message = (error as Error).message;
        const status = message.includes('not found') ? 404 :
            message.includes('Unauthorized') ? 403 : 500;
        res.status(status).json({ error: message });
    }
});

// Create project
router.post(
    '/',
    validateRequest({ body: schemas.project.create }),
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const project = await projectService.createProject(req.user!.id, req.body);
            res.status(201).json({ project });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }
);

// Update project
router.patch(
    '/:projectId',
    validateRequest({ body: schemas.project.update }),
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const project = await projectService.updateProject(
                req.params.projectId,
                req.user!.id,
                req.body
            );
            res.json({ project });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }
);

// On-demand thumbnail capture
// previewUrl in body is optional — if omitted, the server looks it up from revisions
router.post('/:projectId/capture-thumbnail', async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    let { previewUrl } = req.body as { previewUrl?: string };

    const supaUrl = process.env.SUPABASE_URL || '';
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
    if (!supaUrl || !supaKey) {
        res.status(503).json({ error: 'Storage not configured' });
        return;
    }
    const supa = createClient(supaUrl, supaKey);

    // If caller didn't supply a URL, resolve it server-side from revision_preview → revisions → projects
    if (!previewUrl) {
        const { data } = await supa.rpc('get_latest_preview_url', { p_project_id: projectId });
        if (data) {
            previewUrl = data as string;
        } else {
            // Last-resort: check revisions.preview_url directly (older rows before revision_preview existed)
            const { data: rev } = await supa
                .from('revisions')
                .select('preview_url')
                .eq('project_id', projectId)
                .not('preview_url', 'is', null)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            previewUrl = (rev as any)?.preview_url ?? null;
        }
    }

    if (!previewUrl) {
        // No build exists yet — nothing to screenshot
        res.json({ status: 'skipped', reason: 'no_preview_url' });
        return;
    }

    // Fire and forget — respond immediately so the client isn't blocked
    res.json({ status: 'capturing' });
    captureThumbnail(projectId, previewUrl, supa);
});

// Delete project (permanently — removes DB row immediately, cleans up storage async)
router.delete('/:projectId', async (req: AuthenticatedRequest, res: Response) => {
    try {
        await projectService.permanentlyDeleteProject(req.params.projectId, req.user!.id);
        res.json({ success: true });
    } catch (error) {
        const message = (error as Error).message;
        const status = message.includes('not found') ? 404 :
            message.includes('Unauthorized') ? 403 : 500;
        res.status(status).json({ error: message });
    }
});

export default router;
