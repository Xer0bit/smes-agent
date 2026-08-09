import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAuth } from '../config/database.js';
import { createError } from '../middleware/error.middleware.js';

const router = Router();

// This file has no /login or /register -- platform sign-in goes client-side
// directly to Supabase, never through this server. /refresh is the only
// credential-adjacent endpoint here; IP-keyed limiter guards against
// refresh-token brute-forcing/abuse.
const refreshLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 20,
    keyGenerator: (req) => req.ip || 'unknown',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many refresh attempts   please wait a few minutes and try again' },
});

// Get current user
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
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
        next(createError('Authentication failed', 500));
    }
});

// Refresh token
router.post('/refresh', refreshLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
            // Raw message intentionally NOT sanitized: Supabase Auth's own
            // messages here ("Invalid Refresh Token", "Token has expired")
            // are designed to be user-facing auth feedback, not schema/system
            // detail.
            res.status(401).json({ error: error.message });
            return;
        }

        res.json({
            access_token: data.session?.access_token,
            refresh_token: data.session?.refresh_token,
            expires_at: data.session?.expires_at
        });
    } catch (error) {
        next(createError('Failed to refresh token', 500));
    }
});

export default router;
