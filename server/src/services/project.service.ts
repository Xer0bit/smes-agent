import { randomUUID } from 'crypto';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { syncPlatformAuthSecrets } from './database.service.js';

export interface Project {
    id: string;
    name: string;
    description?: string;
    user_id: string;
    status: string;
    preview_url?: string;
    preview_port?: number;
    template_type: string;
    created_at: string;
    updated_at: string;
}

export interface CreateProjectParams {
    name: string;
    description?: string;
    template?: string;
    organizationId?: string;
}

export class ProjectService {
    async createProject(userId: string, params: CreateProjectParams): Promise<Project> {
        const projectId = randomUUID();
        const dirName = `user_${userId.substring(0, 8)}_project_${projectId.substring(0, 8)}`;
        const dockerPath = `/projects/${dirName}`;
        const serverPath = `/var/ecomgear/projects/${dirName}`;

        logger.info(`Creating project: ${params.name} for user: ${userId}`);

        const { data, error } = await supabase
            .from('projects')
            .insert({
                id: projectId,
                user_id: userId,
                created_by: userId,
                name: params.name,
                description: params.description,
                docker_path: dockerPath,
                server_path: serverPath,
                template_type: params.template || 'vite-react-ts',
                status: 'active',
                organization_id: params.organizationId ?? null
            })
            .select()
            .single();

        if (error) {
            logger.error(`Failed to create project: ${error.message}`);
            throw new Error(`Failed to create project: ${error.message}`);
        }

        logger.info(`Project created successfully: ${projectId}`);
        // Fire-and-forget   auth (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY) must work
        // from the very first build, not only after the owner visits Database settings.
        syncPlatformAuthSecrets(projectId).catch(() => {});
        return data as Project;
    }

    async getProject(projectId: string, userId: string): Promise<Project> {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .eq('id', projectId)
            .single();

        if (error || !data) {
            throw new Error('Project not found');
        }

        // Allow project owner
        if (data.user_id === userId || data.created_by === userId) {
            return data as Project;
        }

        // Allow org members (admin, member with project access, billing_admin)
        if (data.organization_id) {
            const { data: membership } = await supabase
                .from('org_members')
                .select('id, role')
                .eq('org_id', data.organization_id)
                .eq('user_id', userId)
                .maybeSingle();

            if (membership) {
                // billing_admin has no project access
                if (membership.role === 'billing_admin') {
                    throw new Error('Unauthorized access to project');
                }
                // admin sees all org projects; member needs explicit assignment
                if (membership.role === 'admin') {
                    return data as Project;
                }
                // member: check project_member_access
                const { data: pma } = await supabase
                    .from('project_member_access')
                    .select('id')
                    .eq('project_id', projectId)
                    .eq('user_id', userId)
                    .maybeSingle();
                if (pma) return data as Project;
            }
        }

        throw new Error('Unauthorized access to project');
    }

    // ── Role resolution ──────────────────────────────────────────────────────
    // getProject() above is a binary all-or-nothing gate   every accepted
    // collaborator got full access regardless of the Editor/Viewer/Client role
    // they were invited with, because nothing ever read project_member_access's
    // role column (which didn't even exist until this was added). Callers that
    // need to distinguish "can view" from "can actually change the project"
    // (agent generation, file writes, settings, deploys) should use this
    // instead of just calling getProject() and assuming write access.
    async getUserRole(projectId: string, userId: string): Promise<'owner' | 'admin' | 'editor' | 'viewer' | 'client'> {
        const { data } = await supabase
            .from('projects')
            .select('user_id, created_by, organization_id')
            .eq('id', projectId)
            .single();

        if (!data) throw new Error('Project not found');
        if (data.user_id === userId || data.created_by === userId) return 'owner';

        if (data.organization_id) {
            const { data: membership } = await supabase
                .from('org_members')
                .select('role')
                .eq('org_id', data.organization_id)
                .eq('user_id', userId)
                .maybeSingle();

            if (membership?.role === 'billing_admin') throw new Error('Unauthorized access to project');
            if (membership?.role === 'admin') return 'admin';
        }

        const { data: pma } = await supabase
            .from('project_member_access')
            .select('role')
            .eq('project_id', projectId)
            .eq('user_id', userId)
            .maybeSingle();

        if (pma) return (pma.role as 'editor' | 'viewer' | 'client') || 'editor';

        throw new Error('Unauthorized access to project');
    }

    // Write-gate for settings/deploy endpoints (SEO, header integrations, DB,
    // hosting/domains)   these previously only called getProject(), which is
    // the binary "has any access" check above, so a 'viewer' or 'client'
    // collaborator could inject scripts / edit DB / change domains same as an
    // owner. Throws the same generic 'Unauthorized' message getProject() uses,
    // so callers' existing catch-and-404 pattern doesn't need to change.
    async assertCanEditProject(projectId: string, userId: string): Promise<void> {
        const role = await this.getUserRole(projectId, userId);
        if (role === 'viewer' || role === 'client') {
            throw new Error('Unauthorized access to project');
        }
    }

    async listProjects(userId: string, limit = 50, offset = 0): Promise<Project[]> {
        // Owned projects
        const { data: owned, error } = await supabase
            .from('projects')
            .select('*')
            .eq('user_id', userId)
            .neq('status', 'deleted')
            .order('updated_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            logger.error(`Failed to list projects: ${error.message}`);
            throw new Error(`Failed to list projects: ${error.message}`);
        }

        // Shared projects (user is in project_members but not the owner)
        const { data: memberRows } = await supabase
            .from('project_members')
            .select('project_id')
            .eq('user_id', userId);

        const sharedIds = (memberRows || [])
            .map(r => r.project_id)
            .filter(id => !(owned || []).some(p => p.id === id));

        let shared: Project[] = [];
        if (sharedIds.length > 0) {
            const { data: sharedData } = await supabase
                .from('projects')
                .select('*')
                .in('id', sharedIds)
                .neq('status', 'deleted')
                .order('updated_at', { ascending: false });
            shared = (sharedData || []) as Project[];
        }

        return [...(owned || []), ...shared] as Project[];
    }

    async updateProject(projectId: string, userId: string, updates: Partial<Pick<Project, 'name' | 'description'>>): Promise<Project> {
        await this.getProject(projectId, userId); // Verify access

        const { data, error } = await supabase
            .from('projects')
            .update({
                ...updates,
                updated_at: new Date().toISOString()
            })
            .eq('id', projectId)
            .select()
            .single();

        if (error) {
            logger.error(`Failed to update project: ${error.message}`);
            throw new Error(`Failed to update project: ${error.message}`);
        }

        return data as Project;
    }

    async deleteProject(projectId: string, userId: string): Promise<void> {
        await this.getProject(projectId, userId); // Verify access

        // Soft delete
        const { error } = await supabase
            .from('projects')
            .update({
                status: 'deleted',
                updated_at: new Date().toISOString()
            })
            .eq('id', projectId);

        if (error) {
            logger.error(`Failed to delete project: ${error.message}`);
            throw new Error(`Failed to delete project: ${error.message}`);
        }

        logger.info(`Project deleted: ${projectId}`);
    }

    /**
     * Permanently deletes the project row immediately (so the API responds fast),
     * then cleans up all related records and storage files asynchronously.
     * Before deleting, writes an archive row to deleted_projects for support recovery.
     */
    async permanentlyDeleteProject(projectId: string, userId: string): Promise<void> {
        const project = await this.getProject(projectId, userId); // Verify ownership

        // 1. Snapshot project + settings into deleted_projects archive BEFORE any deletes.
        //    This gives support a 2-year recovery window.
        try {
            const { data: settings } = await supabase
                .from('project_settings')
                .select('setting_key, setting_value')
                .eq('project_id', projectId);

            await supabase.from('deleted_projects').insert({
                project_id:     projectId,
                project_name:   (project as any).name ?? 'unknown',
                project_slug:   (project as any).slug ?? null,
                owner_user_id:  (project as any).created_by ?? (project as any).user_id ?? userId,
                organization_id:(project as any).organization_id ?? null,
                deleted_by:     userId,
                metadata: {
                    project:  project,
                    settings: settings ?? [],
                    deleted_at: new Date().toISOString(),
                },
            });
        } catch (archiveErr) {
            // Archive failure must never block actual deletion
            logger.warn(`[deleteProject] Archive write failed for ${projectId}: ${(archiveErr as Error).message}`);
        }

        // 2. Delete everything via a single atomic SQL transaction.
        //    The delete_project_cascade() SECURITY DEFINER function handles all 41 FK tables
        //    in the correct order   non-CASCADE tables explicitly, CASCADE tables automatically.
        const { error } = await supabase.rpc('delete_project_cascade', { p_project_id: projectId });

        if (error) {
            logger.error(`Failed to delete project ${projectId}: ${error.message}`);
            throw new Error(`Failed to delete project: ${error.message}`);
        }

        logger.info(`Project ${projectId} deleted   archive saved, background cleanup started`);

        // 4. Fire-and-forget: clean up storage files
        setImmediate(() => { void this._cleanupProjectAsync(projectId); });
    }

    private async _cleanupProjectAsync(projectId: string): Promise<void> {
        const RELATED_TABLES = [
            'revision_preview',
            'published_versions',
            'revisions',
            'messages',
            'project_settings',
            'project_member_access',
            'project_members',
            'project_custom_domains',
            'project_subdomains',
            'project_billing',
            'project_add_ons',
            'ai_generations',
            'file_history',
            'build_logs',
            'preview_sessions',
            'agent_task_logs',
            'ai_agents',
        ];

        // Delete related table rows in parallel
        await Promise.allSettled(
            RELATED_TABLES.map((table) =>
                supabase.from(table).delete().eq('project_id', projectId)
            )
        );

        // Delete storage files
        try {
            const BUCKET = 'user-projects-free';
            const basePath = `projects/${projectId}`;

            const { data: fileList } = await supabase.storage.from(BUCKET).list(basePath);
            if (fileList && fileList.length > 0) {
                const paths = fileList.map((f) => `${basePath}/${f.name}`);
                await supabase.storage.from(BUCKET).remove(paths);
            }
        } catch (err) {
            logger.warn(`[cleanup] Storage deletion failed for project ${projectId}: ${(err as Error).message}`);
        }

        logger.info(`[cleanup] Project ${projectId} background cleanup complete`);
    }
}

export const projectService = new ProjectService();
export default projectService;
