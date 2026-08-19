import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/environment.js';

interface PreviewSession {
    id: string;
    project_id: string;
    user_id: string;
    port: number;
    preview_url: string;
    status: string;
    started_at: string;
}

export class PreviewService {
    private readonly previewBaseUrl = config.previewBaseUrl;
    private usedPorts = new Set<number>();
    private readonly portRange = { min: 3001, max: 3100 };

    async startPreview(projectId: string, userId: string): Promise<PreviewSession> {
        const startedAtMs = Date.now();
        logger.info('startPreview: invoked', { projectId, userId, usedPortsCount: this.usedPorts.size });

        try {
            // Check if preview already running
            logger.debug('startPreview: checking for existing running session', { projectId });
            const { data: existingSession, error: existingLookupError } = await supabase
                .from('preview_sessions')
                .select('*')
                .eq('project_id', projectId)
                .eq('status', 'running')
                .single();

            if (existingLookupError) {
                logger.debug('startPreview: no existing running session found (or lookup error, non-fatal)', {
                    projectId, error: existingLookupError.message, code: existingLookupError.code,
                });
            }

            if (existingSession) {
                logger.info('startPreview: preview already running, returning existing session', {
                    projectId, userId, sessionId: existingSession.id, port: existingSession.port,
                    previewUrl: existingSession.preview_url, startedAt: existingSession.started_at,
                });
                return existingSession as PreviewSession;
            }

            // Find available port
            const port = this.findAvailablePort();
            const previewUrl = `${this.previewBaseUrl}/preview/${projectId}`;
            logger.debug('startPreview: allocated port', { projectId, port, portRange: this.portRange, previewUrl });

            // Create session
            const autoStopAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            logger.debug('startPreview: inserting preview_sessions row', { projectId, userId, port, previewUrl, autoStopAt });
            const { data: session, error } = await supabase
                .from('preview_sessions')
                .insert({
                    project_id: projectId,
                    user_id: userId,
                    port,
                    preview_url: previewUrl,
                    status: 'running',
                    auto_stop_at: autoStopAt
                })
                .select()
                .single();

            if (error) {
                logger.error('startPreview: failed to insert preview_sessions row', {
                    projectId, userId, port, error: error.message, code: error.code, details: error.details,
                });
                throw new Error(`Failed to create preview session: ${error.message}`);
            }
            logger.debug('startPreview: preview_sessions row created', { projectId, sessionId: session?.id, port });

            // Update project
            logger.debug('startPreview: updating projects row with preview port/url', { projectId, port, previewUrl });
            const { error: projectUpdateError } = await supabase
                .from('projects')
                .update({
                    preview_port: port,
                    preview_url: previewUrl,
                    last_accessed_at: new Date().toISOString()
                })
                .eq('id', projectId);

            if (projectUpdateError) {
                logger.warn('startPreview: failed to update projects row (session was still created)', {
                    projectId, port, error: projectUpdateError.message, code: projectUpdateError.code,
                });
            }

            this.usedPorts.add(port);
            const durationMs = Date.now() - startedAtMs;
            logger.info('startPreview: preview started successfully', {
                projectId, userId, port, previewUrl, sessionId: session?.id, durationMs, usedPortsCount: this.usedPorts.size,
            });

            return session as PreviewSession;
        } catch (error) {
            const durationMs = Date.now() - startedAtMs;
            logger.error('startPreview: failed', {
                projectId, userId, durationMs,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    }

    async stopPreview(projectId: string, userId: string): Promise<void> {
        const startedAtMs = Date.now();
        logger.info('stopPreview: invoked', { projectId, userId });

        logger.debug('stopPreview: looking up running session', { projectId });
        const { data: session, error: lookupError } = await supabase
            .from('preview_sessions')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'running')
            .single();

        if (lookupError) {
            logger.debug('stopPreview: session lookup returned error (treated as no active session)', {
                projectId, error: lookupError.message, code: lookupError.code,
            });
        }

        if (!session) {
            logger.info('stopPreview: no active preview found, nothing to stop', { projectId, userId });
            return;
        }
        logger.debug('stopPreview: found active session', { projectId, sessionId: session.id, port: session.port });

        // Update session
        const { error: sessionUpdateError } = await supabase
            .from('preview_sessions')
            .update({
                status: 'stopped',
                stopped_at: new Date().toISOString()
            })
            .eq('id', session.id);

        if (sessionUpdateError) {
            logger.warn('stopPreview: failed to mark preview_sessions row as stopped', {
                projectId, sessionId: session.id, error: sessionUpdateError.message,
            });
        } else {
            logger.debug('stopPreview: preview_sessions row marked stopped', { projectId, sessionId: session.id });
        }

        // Update project
        const { error: projectUpdateError } = await supabase
            .from('projects')
            .update({
                preview_port: null,
                preview_url: null
            })
            .eq('id', projectId);

        if (projectUpdateError) {
            logger.warn('stopPreview: failed to clear preview fields on projects row', {
                projectId, error: projectUpdateError.message,
            });
        }

        this.usedPorts.delete(session.port);
        const durationMs = Date.now() - startedAtMs;
        logger.info('stopPreview: preview stopped successfully', {
            projectId, userId, sessionId: session.id, port: session.port, durationMs, usedPortsCount: this.usedPorts.size,
        });
    }

    async getPreviewStatus(projectId: string, userId: string): Promise<{
        isRunning: boolean;
        previewUrl?: string;
        port?: number;
        startedAt?: string;
    }> {
        logger.debug('getPreviewStatus: invoked', { projectId, userId });
        const { data: session, error } = await supabase
            .from('preview_sessions')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'running')
            .single();

        if (error) {
            logger.debug('getPreviewStatus: lookup error (treated as not running)', {
                projectId, error: error.message, code: error.code,
            });
        }

        const result = {
            isRunning: !!session,
            previewUrl: session?.preview_url,
            port: session?.port,
            startedAt: session?.started_at
        };
        logger.debug('getPreviewStatus: result', { projectId, userId, ...result, sessionId: session?.id });

        return result;
    }

    async updateActivity(projectId: string): Promise<void> {
        logger.debug('updateActivity: refreshing last_activity_at/auto_stop_at', { projectId });
        const { error, count } = await supabase
            .from('preview_sessions')
            .update({
                last_activity_at: new Date().toISOString(),
                auto_stop_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
            })
            .eq('project_id', projectId)
            .eq('status', 'running');

        if (error) {
            logger.warn('updateActivity: failed to update activity timestamps', {
                projectId, error: error.message, code: error.code,
            });
        } else {
            logger.debug('updateActivity: activity timestamps updated', { projectId, rowsAffected: count ?? undefined });
        }
    }

    private findAvailablePort(): number {
        logger.debug('findAvailablePort: searching for a free port', {
            portRange: this.portRange, usedPortsCount: this.usedPorts.size,
        });
        for (let port = this.portRange.min; port <= this.portRange.max; port++) {
            if (!this.usedPorts.has(port)) {
                logger.debug('findAvailablePort: found free port', { port });
                return port;
            }
        }
        logger.error('findAvailablePort: no available ports in range', {
            portRange: this.portRange, usedPortsCount: this.usedPorts.size,
        });
        throw new Error('No available ports for preview');
    }
}

export const previewService = new PreviewService();
export default previewService;
