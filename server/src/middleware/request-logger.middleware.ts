import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { AuthenticatedRequest } from './auth.middleware.js';

export function requestLogger(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const user = (req as AuthenticatedRequest).user;

        logger.info('HTTP Request', {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: `${duration}ms`,
            userId: user?.id,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });

    next();
}

export default requestLogger;
