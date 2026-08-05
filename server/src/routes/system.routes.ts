import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import os from 'os';
import { logger } from '../utils/logger.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import {
    addLlmModel,
    getLlmStatusPayload,
    removeLlmModel,
    updateLlmControlState,
} from '../services/llm-control.service.js';
import { getEmbeddingStatus, resetProviderCache, probeEmbeddingProvider } from '../knowledgebase/index.js';
import { getTierConfig, saveTierConfig } from '../services/tier-config.service.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Whitelist of allowed commands for security
// We allow npm install and basic safe commands
const ALLOWED_COMMAND_PREFIXES = [
    'npm install',
    'npm i',
    'npm uninstall',
    'npm run',
    'echo',
    'ls'
];

export const requireAdmin = async (req: AuthenticatedRequest, res: Response): Promise<boolean> => {
    if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }

    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', req.user.id)
        .in('role', ['super_admin', 'admin'])
        .maybeSingle();

    if (error || !data) {
        res.status(403).json({ error: 'Admin access required' });
        return false;
    }

    return true;
};

router.get('/llm/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const payload = await getLlmStatusPayload();
        res.json({ success: true, data: payload });
    } catch (error) {
        logger.error('Failed to read LLM status', error);
        res.status(500).json({ success: false, error: 'Failed to read LLM status' });
    }
});

router.put('/llm/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const next = await updateLlmControlState(req.body || {});
        res.json({ success: true, data: next });
    } catch (error) {
        logger.error('Failed to update LLM status', error);
        res.status(500).json({ success: false, error: 'Failed to update LLM status' });
    }
});

router.post('/llm/models', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const id = String(req.body?.id || '').trim().replace(/[}\],;]+$/g, '');
        const provider = req.body?.provider;
        if (!id || (provider !== 'anthropic' && provider !== 'deepseek' && provider !== 'gemini')) {
            res.status(400).json({ success: false, error: 'id and provider are required (provider must be anthropic, deepseek, or gemini)' });
            return;
        }
        if (!MODEL_ID_RE.test(id)) {
            res.status(400).json({ success: false, error: 'Invalid model id format' });
            return;
        }

        const next = await addLlmModel({ id, provider });
        res.json({ success: true, data: next });
    } catch (error) {
        logger.error('Failed to add LLM model', error);
        res.status(500).json({ success: false, error: 'Failed to add LLM model' });
    }
});

router.delete('/llm/models/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const modelId = String(req.params.id || '').trim();
        if (!modelId) {
            res.status(400).json({ success: false, error: 'model id is required' });
            return;
        }

        const next = await removeLlmModel(modelId);
        res.json({ success: true, data: next });
    } catch (error) {
        logger.error('Failed to remove LLM model', error);
        res.status(500).json({ success: false, error: 'Failed to remove LLM model' });
    }
});

// ── Tier Config ──────────────────────────────────────────────────────────────

router.get('/tier-config', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const config = await getTierConfig();
        res.json({ success: true, data: config });
    } catch (error) {
        logger.error('Failed to read tier config', error);
        res.status(500).json({ success: false, error: 'Failed to read tier config' });
    }
});

router.put('/tier-config', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const config = await saveTierConfig(req.body || {});
        res.json({ success: true, data: config });
    } catch (error) {
        logger.error('Failed to save tier config', error);
        res.status(500).json({ success: false, error: 'Failed to save tier config' });
    }
});

router.post('/exec', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;

        if (process.env.SYSTEM_EXEC_ENABLED !== 'true') {
            res.status(403).json({ error: 'System command execution is disabled' });
            return;
        }

        const { command, cwd } = req.body;

        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }

        // Block shell metacharacters that enable command chaining / injection
        if (/[;&|`$(){}]/.test(command) || /rm\s+-(r|f|rf|fr)/.test(command)) {
            logger.warn(`Blocked dangerous command: ${command}`);
            return res.status(403).json({ error: 'Command contains disallowed shell metacharacters' });
        }

        // Whitelist enforcement
        const isAllowed = ALLOWED_COMMAND_PREFIXES.some(prefix => command.trim().startsWith(prefix));

        if (!isAllowed) {
            logger.warn(`Blocked command execution attempt: ${command}`);
            return res.status(403).json({ error: 'Command not allowed via auto-exec' });
        }

        logger.info(`Executing system command: ${command}`);

        exec(command, { cwd: cwd || process.cwd() }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Command failed: ${error.message}`);
                return res.status(500).json({
                    success: false,
                    error: error.message,
                    stderr,
                    stdout
                });
            }

            res.json({
                success: true,
                stdout,
                stderr
            });
        });

    } catch (error) {
        logger.error('System execution error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Platform / Server Status ──────────────────────────────────────────────────

router.get('/server-status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;

        const mem = process.memoryUsage();
        const cpus = os.cpus();

        res.json({
            success: true,
            data: {
                nodeVersion: process.version,
                platform: process.platform,
                uptimeSeconds: Math.floor(process.uptime()),
                memory: {
                    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                    rssMB: Math.round(mem.rss / 1024 / 1024),
                    freeMB: Math.round(os.freemem() / 1024 / 1024),
                    totalMB: Math.round(os.totalmem() / 1024 / 1024),
                },
                cpu: {
                    model: cpus[0]?.model || 'unknown',
                    cores: cpus.length,
                    loadAvg: os.loadavg(),
                },
                pid: process.pid,
                env: process.env.NODE_ENV || 'unknown',
            },
        });
    } catch (error) {
        logger.error('Failed to get server status', error);
        res.status(500).json({ success: false, error: 'Failed to get server status' });
    }
});

// KB embedding diagnostics   admin only
router.get('/kb/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        const status = getEmbeddingStatus();
        const { data: countRow } = await supabase
            .from('project_file_embeddings')
            .select('project_id, updated_at', { count: 'exact', head: false })
            .order('updated_at', { ascending: false })
            .limit(1);
        res.json({
            success: true,
            provider: status.provider,
            googleCircuitOpen: status.googleCircuitOpen,
            openaiCircuitOpen: status.openaiCircuitOpen,
            googleCircuitResetsAt: status.googleCircuitResetsAt
                ? new Date(status.googleCircuitResetsAt).toISOString() : null,
            googleKeySet: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
            openaiKeySet: !!process.env.OPENAI_API_KEY,
            lastIndexed: (countRow as any)?.[0]?.updated_at ?? null,
        });
    } catch (error) {
        logger.error('Failed to get KB status', error);
        res.status(500).json({ success: false, error: safeErrorMessage(error) });
    }
});

// Force re-probe embedding provider (useful after updating API keys)
router.post('/kb/reprobe', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!await requireAdmin(req, res)) return;
        resetProviderCache();
        await probeEmbeddingProvider();
        const status = getEmbeddingStatus();
        res.json({ success: true, provider: status.provider, googleCircuitOpen: status.googleCircuitOpen });
    } catch (error) {
        res.status(500).json({ success: false, error: safeErrorMessage(error) });
    }
});

export default router;
