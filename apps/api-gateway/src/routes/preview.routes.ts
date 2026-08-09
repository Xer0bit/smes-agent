import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { previewService } from '../services/preview.service.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();

router.use(authMiddleware);

// Start preview
router.post('/:projectId/start', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const session = await previewService.startPreview(
            req.params.projectId,
            req.user!.id
        );
        res.json({
            success: true,
            previewUrl: session.preview_url,
            port: session.port,
            sessionId: session.id
        });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

// Stop preview
router.post('/:projectId/stop', async (req: AuthenticatedRequest, res: Response) => {
    try {
        await previewService.stopPreview(req.params.projectId, req.user!.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

// Get preview status
router.get('/:projectId/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const status = await previewService.getPreviewStatus(
            req.params.projectId,
            req.user!.id
        );
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

// Update activity (keep-alive)
router.post('/:projectId/activity', async (req: AuthenticatedRequest, res: Response) => {
    try {
        await previewService.updateActivity(req.params.projectId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: safeErrorMessage(error) });
    }
});

export default router;
