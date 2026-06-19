import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validateRequest, schemas } from '../middleware/validation.middleware.js';
import { projectService } from '../services/project.service.js';

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
