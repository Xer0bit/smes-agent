import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export interface AppError extends Error {
    statusCode?: number;
    isOperational?: boolean;
    // 2026-08 audit: prior log shape (error/stack/url/method/statusCode) had
    // no userId/projectId, forcing SSH+grep to trace which project an
    // incident belonged to. projectId is optional -- most routes have one,
    // a few (platform-level auth) genuinely don't.
    projectId?: string;
}

export function errorHandler(
    error: AppError,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    const statusCode = error.statusCode || 500;
    const isProduction = process.env.NODE_ENV === 'production';

    // Log error
    logger.error('Application error', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        statusCode,
        projectId: error.projectId,
    });

    // Response
    if (isProduction && statusCode === 500) {
        res.status(500).json({
            error: 'Internal server error',
            requestId: req.headers['x-request-id'] || undefined
        });
    } else {
        res.status(statusCode).json({
            error: error.message,
            ...(isProduction ? {} : { stack: error.stack })
        });
    }
}

// Helper to create app errors
export function createError(message: string, statusCode: number = 500, projectId?: string): AppError {
    const error = new Error(message) as AppError;
    error.statusCode = statusCode;
    error.isOperational = true;
    if (projectId) error.projectId = projectId;
    return error;
}

export default errorHandler;
