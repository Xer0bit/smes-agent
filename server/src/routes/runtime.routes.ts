import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { runtimeService } from '../services/runtime.service.js';

const router = Router();

router.use(authMiddleware);

router.post('/:projectId/start', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const runtime = await runtimeService.startRuntime(req.params.projectId, req.user!.id);
    res.json({ success: true, runtime });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/:projectId/stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual_stop';
    const runtime = await runtimeService.stopRuntime(req.params.projectId, reason);
    res.json({ success: true, runtime });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/:projectId/activity', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await runtimeService.heartbeat(req.params.projectId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/:projectId/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const refresh = req.query.refresh === '1';
    const runtime = refresh
      ? await runtimeService.refreshFromControlPlane(req.params.projectId)
      : await runtimeService.getRuntimeStatus(req.params.projectId);

    res.json({ success: true, runtime });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
