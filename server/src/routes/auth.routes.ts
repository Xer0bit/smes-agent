import { Router, Request, Response } from 'express';
import { supabaseAuth } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Get current user
router.get('/me', async (req: Request, res: Response) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        const token = authHeader.substring(7);
        const { data, error } = await supabaseAuth.auth.getUser(token);

        if (error || !data.user) {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        res.json({
            id: data.user.id,
            email: data.user.email,
            role: data.user.role,
            created_at: data.user.created_at
        });
    } catch (error) {
        logger.error('Auth error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Refresh token
router.post('/refresh', async (req: Request, res: Response) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            res.status(400).json({ error: 'Refresh token required' });
            return;
        }

        const { data, error } = await supabaseAuth.auth.refreshSession({
            refresh_token
        });

        if (error) {
            res.status(401).json({ error: error.message });
            return;
        }

        res.json({
            access_token: data.session?.access_token,
            refresh_token: data.session?.refresh_token,
            expires_at: data.session?.expires_at
        });
    } catch (error) {
        logger.error('Refresh token error:', error);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

export default router;
