import { Router, Response } from 'express';
import { optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { deployProject } from '../services/deployment.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * POST /api/v1/deploy/:projectId
 * Authenticates user and triggers one-click deployment to live Vercel URL.
 */
router.post('/:projectId', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { projectId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!projectId) {
    res.status(400).json({ error: 'projectId parameter is required' });
    return;
  }

  try {
    logger.info(`[deploymentRoute] Processing deployment request for project=${projectId} by user=${userId}`);

    const result = await deployProject(projectId, userId);

    res.status(200).json({
      success: true,
      deploymentUrl: result.deploymentUrl,
    });
  } catch (error: any) {
    const errorMessage = error?.message || 'Failed to deploy project';
    logger.error(`[deploymentRoute] Error deploying project ${projectId}: ${errorMessage}`);

    if (errorMessage.includes('No code generated yet')) {
      res.status(400).json({ error: 'No code generated yet' });
      return;
    }

    if (errorMessage.includes('Unauthorized access') || errorMessage.includes('Project not found')) {
      res.status(403).json({ error: errorMessage });
      return;
    }

    res.status(500).json({
      error: `Deployment error: ${errorMessage}`,
    });
  }
});

export default router;
