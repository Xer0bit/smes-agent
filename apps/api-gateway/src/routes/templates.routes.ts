/**
 * Community templates.
 *
 *   GET   /                      gallery: projects their owners shared (?q=&category=)
 *   GET   /:id/settings          this project's template settings (editors)
 *   PATCH /:id/settings          share / unshare, category, tags (editors)
 *   POST  /:id/remix             new project in the caller's workspace seeded with
 *                                the template's latest revision files
 *
 * A remix is a real fork: the template's manifest revision is read file by
 * file and persisted as the first revision of the new project, so the copy is
 * exactly the template's files and nothing else.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { projectService } from '../services/project.service.js';
import { checkCapacity } from '../services/entitlements.service.js';
import { fetchRevisionFiles } from '../services/runSandbox.js';
import { persistAgentRevision } from '../services/agentRevisionPersist.service.js';
import { logger } from '../utils/logger.js';
import { recordKnowledge } from '../services/knowledge.service.js';
import { BLUEPRINTS, findBlueprint, blueprintKnowledge } from '../templates/blueprints.js';

const router = Router();
router.use(authMiddleware);

const TEMPLATE_COLUMNS = 'id, name, description, thumbnail_url, published_url, preview_url, template_category, template_tags, remix_count, template_published_at, user_id, organization_id, template_type, status, is_template';

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  let query = supabase
    .from('projects')
    .select(`${TEMPLATE_COLUMNS}, organizations(name)`)
    .eq('is_template', true)
    .eq('status', 'active')
    .order('remix_count', { ascending: false })
    .order('template_published_at', { ascending: false })
    .limit(200);
  if (category) query = query.eq('template_category', category);
  if (q) query = query.or(`name.ilike.%${q.replace(/[%,]/g, '')}%,description.ilike.%${q.replace(/[%,]/g, '')}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const templates = (data ?? []).map((row) => {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    return {
      id: row.id, name: row.name, description: row.description, thumbnail_url: row.thumbnail_url,
      preview_url: row.published_url ?? row.preview_url ?? null,
      template_category: row.template_category, template_tags: row.template_tags ?? [], remix_count: row.remix_count ?? 0,
      template_published_at: row.template_published_at, author: org?.name ?? null, is_mine: row.user_id === req.user!.id,
    };
  });
  res.json({ templates });
});

// ── Starter blueprints (curated) ─────────────────────────────────────────────

router.get('/blueprints', (_req, res: Response) => {
  res.json({ blueprints: BLUEPRINTS.map(({ id, name, category, tagline, description, accent, stack, pages }) => ({ id, name, category, tagline, description, accent, stack, pages })) });
});

const startSchema = z.object({
  organization_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(80).optional(),
});

/**
 * Start a project from a blueprint: create it, write the rules as its first
 * knowledge note (read on every run, editable in Settings → Knowledge), and
 * hand back the starter prompt for the chat.
 */
router.post('/blueprints/:id/start', async (req: AuthenticatedRequest, res: Response) => {
  const blueprint = findBlueprint(req.params.id);
  if (!blueprint) return res.status(404).json({ error: 'Blueprint not found' });
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const orgId = parsed.data.organization_id ?? null;
  try {
    if (orgId) {
      const capacity = await checkCapacity(orgId, 'apps');
      if (!('ok' in capacity)) return res.status(capacity.status).json(capacity);
    }
    const project = await projectService.createProject(req.user!.id, { name: parsed.data.name ?? blueprint.name, organizationId: orgId ?? undefined });
    const note = blueprintKnowledge(blueprint);
    await recordKnowledge(project.id, [{ source: 'note', source_ref: `blueprint:${blueprint.id}`, heading: note.heading, content: note.content }]);
    await supabase.from('projects').update({ description: blueprint.description, template_category: blueprint.category }).eq('id', project.id);
    res.status(201).json({ project: { id: project.id, name: project.name }, starter_prompt: blueprint.starterPrompt });
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

function pickSettings(row: { is_template: boolean; template_category: string | null; template_tags: string[] | null; remix_count: number | null; template_published_at: string | null }) {
  return {
    is_template: Boolean(row.is_template), template_category: row.template_category ?? null,
    template_tags: row.template_tags ?? [], remix_count: row.remix_count ?? 0, template_published_at: row.template_published_at ?? null,
  };
}

router.get('/:id/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await projectService.getProject(req.params.id, req.user!.id);
    const { data, error } = await supabase.from('projects').select('is_template, template_category, template_tags, remix_count, template_published_at').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Project not found' });
    res.json(pickSettings(data));
  } catch (error) {
    res.status(403).json({ error: safeErrorMessage(error) });
  }
});

const settingsSchema = z.object({
  is_template: z.boolean().optional(),
  template_category: z.string().max(40).nullable().optional(),
  template_tags: z.array(z.string().min(1).max(24)).max(8).optional(),
});

router.patch('/:id/settings', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  try {
    await projectService.assertCanEditProject(req.params.id, req.user!.id);
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.is_template === true) patch.template_published_at = new Date().toISOString();
    if (parsed.data.is_template === false) patch.template_published_at = null;
    const { data, error } = await supabase.from('projects').update(patch).eq('id', req.params.id)
      .select('is_template, template_category, template_tags, remix_count, template_published_at').single();
    if (error || !data) return res.status(500).json({ error: error?.message ?? 'Update failed' });
    res.json(pickSettings(data));
  } catch (error) {
    res.status(403).json({ error: safeErrorMessage(error) });
  }
});

const remixSchema = z.object({
  organization_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(80).optional(),
});

router.post('/:id/remix', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = remixSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const userId = req.user!.id;
  try {
    const { data: source } = await supabase.from('projects').select(TEMPLATE_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (!source || source.status !== 'active') return res.status(404).json({ error: 'Template not found' });
    if (!source.is_template && source.user_id !== userId) return res.status(403).json({ error: 'This project is not shared as a template' });

    const orgId = parsed.data.organization_id ?? null;
    if (orgId) {
      const capacity = await checkCapacity(orgId, 'apps');
      if (!('ok' in capacity)) return res.status(capacity.status).json(capacity);
    }

    // Latest manifest revision of the template.
    const { data: revisions } = await supabase
      .from('revisions').select('id, generated_files').eq('project_id', source.id)
      .order('created_at', { ascending: false }).limit(10);
    const manifestRev = (revisions ?? []).find((r) => r.generated_files?.format === 'manifest-v1' && Array.isArray(r.generated_files?.files) && r.generated_files.files.length > 0);
    const files = manifestRev ? await fetchRevisionFiles(source.id, manifestRev.id) : null;
    if (!files || files.length === 0) return res.status(409).json({ error: 'This template has no files to copy yet' });

    const project = await projectService.createProject(userId, {
      name: parsed.data.name ?? `${source.name} (remix)`,
      organizationId: orgId ?? undefined,
      template: source.template_type ?? undefined,
    });
    const persisted = await persistAgentRevision(project.id, userId, files, `Remixed from ${source.name}`, `Remix of ${source.name}`);
    if (!persisted.ok) {
      logger.error('[templates] remix persist failed', { template: source.id, project: project.id, error: persisted.error });
      return res.status(500).json({ error: persisted.error ?? 'Could not copy the template files' });
    }
    await supabase.from('projects').update({ template_source_id: source.id, description: source.description }).eq('id', project.id);
    await supabase.rpc('increment_remix_count', { p_project_id: source.id });
    res.status(201).json({ project: { id: project.id, name: project.name }, files: files.length });
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

export default router;
