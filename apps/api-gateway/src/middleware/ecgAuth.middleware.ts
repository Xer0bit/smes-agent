/**
 * eCG Auth middleware   drop-in replacement for authMiddleware.
 *
 * Verifies Bearer tokens by first trying eCG Auth, then falling back to
 * Supabase Auth.  This way both eCG Auth sessions and legacy Supabase
 * sessions are accepted during the migration period.
 */

import { Request, Response, NextFunction } from 'express';
import { supabaseAuth } from '../config/database.js';
import { ecgVerifyToken, isEcgAuthConfigured } from '../services/ecgAuth.service.js';
import { logger } from '../utils/logger.js';

export interface EcgAuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

/**
 * Require authentication via eCG Auth (primary) or Supabase (fallback).
 */
export async function ecgAuthMiddleware(
  req: EcgAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7);

    // ── Try eCG Auth first ──────────────────────────────────────────────
    if (isEcgAuthConfigured()) {
      const ecgResult = await ecgVerifyToken(token);
      if (ecgResult.ok && ecgResult.data) {
        req.user = {
          id: ecgResult.data.user.id,
          email: ecgResult.data.user.email,
        };
        next();
        return;
      }
    }

    // ── Fallback to Supabase ────────────────────────────────────────────
    const authResult = await Promise.race([
      supabaseAuth.auth.getUser(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth verification timed out')), 10_000),
      ),
    ]);

    const { data, error } = authResult;
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = {
      id: data.user.id,
      email: data.user.email || '',
      role: data.user.role,
    };

    next();
  } catch (error) {
    logger.error('eCG Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export default ecgAuthMiddleware;
