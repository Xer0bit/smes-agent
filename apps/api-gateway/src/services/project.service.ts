import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { syncPlatformAuthSecrets, databaseService } from './database.service.js';
import { SNAPSHOTS_DIR } from './agentSnapshot.js';

// /var/ecomgear is the real, root-owned path on VPS1 in production. Locally
// the dev server runs as a normal user and can't mkdir under /var at all
// (confirmed live: EACCES on every agent write_file call, not just eCG's),
// so this is overridable   same pattern as BASE_TEMPLATE_DIR in
// baseTemplateService.ts. Set ECOMGEAR_PROJECTS_DIR in server/.env locally.
export const PROJECTS_BASE_DIR = process.env.ECOMGEAR_PROJECTS_DIR || '/var/ecomgear/projects';

export function getProjectDirName(userId: string, projectId: string): string {
    return `user_${userId.substring(0, 8)}_project_${projectId.substring(0, 8)}`;
}

export function getProjectServerPath(userId: string, projectId: string): string {
    return `${PROJECTS_BASE_DIR}/${getProjectDirName(userId, projectId)}`;
}

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
        const dirName = getProjectDirName(userId, projectId);
        const dockerPath = `/projects/${dirName}`;
        const serverPath = getProjectServerPath(userId, projectId);

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
            .select('id, name, status, created_at, updated_at, organization_id, slug, description, visibility, created_by, message_count, user_id, total_storage_bytes, revision_count, latest_revision_size, storage_warning_shown, org_id, docker_path, server_path, preview_port, template_type, node_version, package_manager, last_built_at, last_accessed_at, auto_save, preview_url, published_subdomain, published_url, published_at, website_name, website_description, meta_image_url, favicon_url, custom_system_prompt, context_notes, thumbnail_url')
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
            .select('id, name, status, created_at, updated_at, organization_id, slug, description, visibility, created_by, message_count, user_id, total_storage_bytes, revision_count, latest_revision_size, storage_warning_shown, org_id, docker_path, server_path, preview_port, template_type, node_version, package_manager, last_built_at, last_accessed_at, auto_save, preview_url, published_subdomain, published_url, published_at, website_name, website_description, meta_image_url, favicon_url, custom_system_prompt, context_notes, thumbnail_url')
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
                .select('id, name, status, created_at, updated_at, organization_id, slug, description, visibility, created_by, message_count, user_id, total_storage_bytes, revision_count, latest_revision_size, storage_warning_shown, org_id, docker_path, server_path, preview_port, template_type, node_version, package_manager, last_built_at, last_accessed_at, auto_save, preview_url, published_subdomain, published_url, published_at, website_name, website_description, meta_image_url, favicon_url, custom_system_prompt, context_notes, thumbnail_url')
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

        // 4. Fire-and-forget: clean up storage files + every other server this
        //    project's data ever touched (preview host, agent-runner files,
        //    tenant DB, hosted site + domain). Owner id (not necessarily the
        //    caller -- an admin can delete someone else's project) is needed
        //    for the eCG-routes' directory-naming convention below.
        const ownerId = (project as any).created_by ?? (project as any).user_id ?? userId;
        setImmediate(() => { void this._cleanupProjectAsync(projectId, ownerId); });
    }

    private async _cleanupProjectAsync(projectId: string, ownerId: string): Promise<void> {
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

        // Everything below runs independently (Promise.allSettled) -- a
        // failure on one server (e.g. VPS4 briefly unreachable) must not
        // block cleanup on the others. Each failure is logged with enough
        // context to retry by hand; none of them throw back to the caller.
        await Promise.allSettled([
            this._cleanupTenantDatabase(projectId),
            this._cleanupHostingAndDomains(projectId),
            this._cleanupPreviewService(projectId),
            this._cleanupLocalProjectFiles(projectId, ownerId),
        ]);

        logger.info(`[cleanup] Project ${projectId} background cleanup complete`);
    }

    // VPS5: archive (rename, don't drop) the tenant DB schema if one was
    // provisioned, and deactivate its edge functions. See
    // database.service.ts's archiveForProjectDeletion for why this is a
    // rename, not deprovision()'s immediate DROP SCHEMA CASCADE.
    private async _cleanupTenantDatabase(projectId: string): Promise<void> {
        try {
            await databaseService.archiveForProjectDeletion(projectId);
        } catch (err) {
            logger.warn(`[cleanup] Tenant DB archive failed for project ${projectId}: ${(err as Error).message}`);
        }
    }

    // VPS4: remove the published site's files and every custom domain
    // mapping for this project (Caddy config + registry), in one call --
    // DELETE /deploy/:projectId on hosting-service already cascades both.
    private async _cleanupHostingAndDomains(projectId: string): Promise<void> {
        const base = (process.env.VITE_HOSTING_SERVICE_URL || process.env.HOSTING_SERVICE_URL || '').replace(/\/$/, '');
        if (!base) return; // hosting service not configured -- nothing to clean up
        const secret = process.env.VITE_HOSTING_SERVICE_SECRET || process.env.HOSTING_SERVICE_SECRET || '';
        try {
            const res = await fetch(`${base}/deploy/${projectId}`, {
                method: 'DELETE',
                headers: secret ? { 'x-deploy-secret': secret } : {},
            });
            if (!res.ok && res.status !== 404) {
                logger.warn(`[cleanup] Hosting-service deploy/domain removal returned ${res.status} for project ${projectId}`);
            }
        } catch (err) {
            logger.warn(`[cleanup] Hosting-service cleanup failed for project ${projectId}: ${(err as Error).message}`);
        }
    }

    // VPS2: stop the running Vite dev-server process and clear every
    // in-memory map tracking it (the actual "free the memory" for this
    // project), then delete its files from the preview host's disk.
    private async _cleanupPreviewService(projectId: string): Promise<void> {
        const base = (process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app').replace(/\/$/, '');
        try {
            const res = await fetch(`${base}/control/project/${projectId}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) {
                logger.warn(`[cleanup] Preview-service teardown returned ${res.status} for project ${projectId}`);
            }
        } catch (err) {
            logger.warn(`[cleanup] Preview-service cleanup failed for project ${projectId}: ${(err as Error).message}`);
        }
    }

    // VPS3 (this process's own host): remove the project's local file copy
    // (both naming conventions in use across the codebase -- plain-UUID for
    // the main chat agent, user_/project_-prefixed for the eCG customize/
    // dev-agent routes), its agent-loop snapshots, and any staged chat
    // uploads. force:true makes each rm a no-op when that path was never
    // created for this project, so attempting all of them is safe.
    private async _cleanupLocalProjectFiles(projectId: string, ownerId: string): Promise<void> {
        const targets = [
            path.join(PROJECTS_BASE_DIR, projectId),
            path.join(PROJECTS_BASE_DIR, getProjectDirName(ownerId, projectId)),
            path.join(os.tmpdir(), 'ecomgear-chat-uploads', projectId),
        ];
        for (const dir of targets) {
            try {
                await fs.promises.rm(dir, { recursive: true, force: true });
            } catch (err) {
                logger.warn(`[cleanup] Local file removal failed for ${dir}: ${(err as Error).message}`);
            }
        }
        // Snapshots are named "<projectId>_<hash>" (see agentSnapshot.ts) --
        // not a single directory, so list and filter by prefix.
        try {
            const entries = await fs.promises.readdir(SNAPSHOTS_DIR).catch(() => [] as string[]);
            const matches = entries.filter((e) => e.startsWith(`${projectId}_`));
            await Promise.all(matches.map((e) =>
                fs.promises.rm(path.join(SNAPSHOTS_DIR, e), { recursive: true, force: true })
            ));
        } catch (err) {
            logger.warn(`[cleanup] Snapshot removal failed for project ${projectId}: ${(err as Error).message}`);
        }
    }
}

export const projectService = new ProjectService();
export default projectService;
