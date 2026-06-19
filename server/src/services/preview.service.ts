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
        logger.info(`Starting preview for project: ${projectId}`);

        try {
            // Check if preview already running
            const { data: existingSession } = await supabase
                .from('preview_sessions')
                .select('*')
                .eq('project_id', projectId)
                .eq('status', 'running')
                .single();

            if (existingSession) {
                logger.info(`Preview already running for project: ${projectId}`);
                return existingSession as PreviewSession;
            }

            // Find available port
            const port = this.findAvailablePort();
            const previewUrl = `${this.previewBaseUrl}/preview/${projectId}`;

            // Create session
            const { data: session, error } = await supabase
                .from('preview_sessions')
                .insert({
                    project_id: projectId,
                    user_id: userId,
                    port,
                    preview_url: previewUrl,
                    status: 'running',
                    auto_stop_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
                })
                .select()
                .single();

            if (error) {
                throw new Error(`Failed to create preview session: ${error.message}`);
            }

            // Update project
            await supabase
                .from('projects')
                .update({
                    preview_port: port,
                    preview_url: previewUrl,
                    last_accessed_at: new Date().toISOString()
                })
                .eq('id', projectId);

            this.usedPorts.add(port);
            logger.info(`Preview started: ${projectId} on port ${port}`);

            return session as PreviewSession;
        } catch (error) {
            logger.error(`Failed to start preview: ${error}`);
            throw error;
        }
    }

    async stopPreview(projectId: string, userId: string): Promise<void> {
        logger.info(`Stopping preview for project: ${projectId}`);

        const { data: session } = await supabase
            .from('preview_sessions')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'running')
            .single();

        if (!session) {
            logger.info(`No active preview for project: ${projectId}`);
            return;
        }

        // Update session
        await supabase
            .from('preview_sessions')
            .update({
                status: 'stopped',
                stopped_at: new Date().toISOString()
            })
            .eq('id', session.id);

        // Update project
        await supabase
            .from('projects')
            .update({
                preview_port: null,
                preview_url: null
            })
            .eq('id', projectId);

        this.usedPorts.delete(session.port);
        logger.info(`Preview stopped: ${projectId}`);
    }

    async getPreviewStatus(projectId: string, userId: string): Promise<{
        isRunning: boolean;
        previewUrl?: string;
        port?: number;
        startedAt?: string;
    }> {
        const { data: session } = await supabase
            .from('preview_sessions')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'running')
            .single();

        return {
            isRunning: !!session,
            previewUrl: session?.preview_url,
            port: session?.port,
            startedAt: session?.started_at
        };
    }

    async updateActivity(projectId: string): Promise<void> {
        await supabase
            .from('preview_sessions')
            .update({
                last_activity_at: new Date().toISOString(),
                auto_stop_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
            })
            .eq('project_id', projectId)
            .eq('status', 'running');
    }

    private findAvailablePort(): number {
        for (let port = this.portRange.min; port <= this.portRange.max; port++) {
            if (!this.usedPorts.has(port)) {
                return port;
            }
        }
        throw new Error('No available ports for preview');
    }
}

export const previewService = new PreviewService();
export default previewService;
