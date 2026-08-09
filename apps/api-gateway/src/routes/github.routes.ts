import { Router, Response } from 'express';
import { optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { exportToGithub, pushFilesToGithub } from '../services/github.service.js';
import { logger } from '../utils/logger.js';

export { pushFilesToGithub };

const router = Router();

/**
 * POST /api/v1/github/export/:projectId
 * Programmatically exports sandboxed project files to a newly created GitHub repository.
 */
router.post('/export/:projectId', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { projectId } = req.params;
  const userId = req.user?.id;
  const { githubToken, repoName, isPrivate = true } = req.body || {};

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!projectId) {
    res.status(400).json({ error: 'projectId parameter is required' });
    return;
  }

  if (!githubToken || typeof githubToken !== 'string' || !githubToken.trim()) {
    res.status(400).json({ error: 'GitHub Personal Access Token (githubToken) is required' });
    return;
  }

  if (!repoName || typeof repoName !== 'string' || !repoName.trim()) {
    res.status(400).json({ error: 'Repository name (repoName) is required' });
    return;
  }

  try {
    logger.info(`[githubRoutes] Processing GitHub export request for project=${projectId} (repo=${repoName})`);

    const result = await exportToGithub(projectId, userId, githubToken, repoName, isPrivate);

    res.status(200).json({
      success: true,
      repoUrl: result.repoUrl,
    });
  } catch (error: any) {
    const errorMessage = error?.message || 'Failed to export repository to GitHub';
    logger.error(`[githubRoutes] Error exporting project ${projectId} to GitHub: ${errorMessage}`);

    if (errorMessage.includes('already exists')) {
      res.status(422).json({ error: errorMessage });
      return;
    }

    if (errorMessage.includes('Invalid or expired')) {
      res.status(401).json({ error: errorMessage });
      return;
    }

    if (errorMessage.includes('No code generated yet')) {
      res.status(400).json({ error: errorMessage });
      return;
    }

    if (errorMessage.includes('Unauthorized access') || errorMessage.includes('Project not found')) {
      res.status(403).json({ error: errorMessage });
      return;
    }

    res.status(500).json({
      error: `GitHub export error: ${errorMessage}`,
    });
  }
});

export default router;
