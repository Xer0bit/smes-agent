import { Request, Response, NextFunction } from 'express';
import { supabaseAuth } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        email: string;
        role?: string;
    };
}

export async function authMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        // Extract token from header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        const token = authHeader.substring(7);

        // Verify token with Supabase — bound to 10s so a Supabase outage
        // doesn't hang every request indefinitely.
        const authResult = await Promise.race([
            supabaseAuth.auth.getUser(token),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Auth verification timed out')), 10_000)
            ),
        ]);

        const { data, error } = authResult;

        if (error || !data.user) {
            logger.warn('Invalid token attempt', { error: error?.message });
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        // Attach user to request
        req.user = {
            id: data.user.id,
            email: data.user.email || '',
            role: data.user.role
        };

        next();
    } catch (error) {
        logger.error('Auth middleware error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// Optional auth - continues even if no token
export async function optionalAuthMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            next();
            return;
        }

        const token = authHeader.substring(7);
        const authResult = await Promise.race([
            supabaseAuth.auth.getUser(token),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Auth verification timed out')), 10_000)
            ),
        ]);
        const { data, error } = authResult;

        if (!error && data.user) {
            req.user = {
                id: data.user.id,
                email: data.user.email || '',
                role: data.user.role
            };
        }

        next();
    } catch (error) {
        // Continue without authentication
        next();
    }
}

export default authMiddleware;
