import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

interface ValidationSchemas {
    body?: ZodSchema;
    query?: ZodSchema;
    params?: ZodSchema;
}

export function validateRequest(schemas: ValidationSchemas) {
    return (req: Request, res: Response, next: NextFunction): void => {
        try {
            if (schemas.body) {
                req.body = schemas.body.parse(req.body);
            }

            if (schemas.query) {
                req.query = schemas.query.parse(req.query);
            }

            if (schemas.params) {
                req.params = schemas.params.parse(req.params);
            }

            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({
                    error: 'Validation failed',
                    details: error.errors.map(e => ({
                        field: e.path.join('.'),
                        message: e.message
                    }))
                });
                return;
            }

            next(error);
        }
    };
}

// Common validation schemas
export const schemas = {
    uuid: z.string().uuid('Invalid UUID format'),

    pagination: z.object({
        limit: z.coerce.number().min(1).max(100).optional().default(50),
        offset: z.coerce.number().min(0).optional().default(0)
    }),

    project: {
        create: z.object({
            name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
            description: z.string().max(500, 'Description too long').optional(),
            template: z.enum(['vite-react-ts', 'vite-react-js', 'nextjs-ts']).optional()
        }),
        update: z.object({
            name: z.string().min(1).max(100).optional(),
            description: z.string().max(500).optional()
        })
    },

    file: {
        upsert: z.object({
            path: z.string().min(1, 'Path is required').max(255, 'Path too long'),
            content: z.string().max(10 * 1024 * 1024, 'File too large'),
            createDirectories: z.boolean().optional()
        })
    },

    ai: {
        generate: z.object({
            projectId: z.string().uuid('Invalid project ID'),
            prompt: z.string().min(1, 'Prompt is required').max(10000, 'Prompt too long'),
            context: z.any().optional()
        })
    }
};

export default validateRequest;
