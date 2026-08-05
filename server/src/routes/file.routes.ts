import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();

router.use(authMiddleware);

// Get all files in project
router.get('/project/:projectId', async (req: AuthenticatedRequest, res: Response) => {
    try {
        // Verify access
        await projectService.getProject(req.params.projectId, req.user!.id);

        // Get latest revision with files
        const { data, error } = await supabase
            .from('revisions')
            .select('generated_files')
            .eq('project_id', req.params.projectId)
            .order('revision_number', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw new Error(error.message);
        }

        res.json({
            files: data?.generated_files?.files || []
        });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

// Get single file
router.get('/project/:projectId/file', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { path } = req.query;
        if (!path || typeof path !== 'string') {
            res.status(400).json({ error: 'Path parameter required' });
            return;
        }

        // Verify access
        await projectService.getProject(req.params.projectId, req.user!.id);

        // Get latest revision
        const { data } = await supabase
            .from('revisions')
            .select('generated_files')
            .eq('project_id', req.params.projectId)
            .order('revision_number', { ascending: false })
            .limit(1)
            .single();

        const files = data?.generated_files?.files || [];
        const file = files.find((f: { path: string }) => f.path === path);

        if (!file) {
            res.status(404).json({ error: 'File not found' });
            return;
        }

        res.json({ file });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

// Get file history
router.get('/project/:projectId/file/history', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { path } = req.query;
        if (!path || typeof path !== 'string') {
            res.status(400).json({ error: 'Path parameter required' });
            return;
        }

        // Verify access
        await projectService.getProject(req.params.projectId, req.user!.id);

        const { data, error } = await supabase
            .from('file_history')
            .select('*')
            .eq('project_id', req.params.projectId)
            .eq('file_path', path)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(error.message);
        }

        res.json({ history: data || [] });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

export default router;
