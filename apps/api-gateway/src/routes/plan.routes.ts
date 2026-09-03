/**
 * Plan: what an organization has bought (units) and what it uses.
 *
 *   GET   /                          ?org_id   catalog + entitlements + usage + estimate
 *   PATCH /                          {org_id, apps?, users?, agents?, databases?}   owner adjusts quantities
 *   GET   /admin/catalog             the price list
 *   PATCH /admin/catalog             edit prices / included quantities / eco allowance
 *   GET   /admin/entitlements/:orgId
 *   PATCH /admin/entitlements/:orgId {apps?, users?, agents?, databases?, eco_per_app?}
 *
 * Owners can only raise quantities above what is in use and never below the
 * included minimum. Payment collection is not wired (no Stripe on prod), so
 * a PATCH takes effect immediately with source 'manual'.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { safeErrorMessage } from '../utils/sendError.js';
import {
  UNITS, Unit, getCatalog, getEntitlements, getUsage, estimateMonthly, overCapacity, includedQuantity,
} from '../services/entitlements.service.js';
import { stripeEnabled, createPlanCheckout, confirmCheckout, createPortalSession, constructWebhookEvent, handleWebhookEvent } from '../services/stripePlan.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

/** Public: the landing page's estimator reads the same price list the app enforces. */
router.get('/catalog', async (_req, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ catalog: await getCatalog() });
});


const unitSchema = z.number().int().min(0).max(1000);
const quantitiesSchema = z.object({
  apps: unitSchema.optional(), users: unitSchema.optional(), agents: unitSchema.optional(), databases: unitSchema.optional(),
});

async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  const { data } = await supabase.from('org_members').select('org_id').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  return Boolean(data);
}

async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase.from('user_roles').select('role').eq('user_id', userId).in('role', ['super_admin', 'admin']).limit(1);
  return Boolean(data && data.length > 0);
}

async function planSnapshot(orgId: string) {
  const catalog = await getCatalog();
  const [entitlements, usage] = await Promise.all([getEntitlements(orgId, catalog), getUsage(orgId)]);
  return {
    catalog, entitlements, usage, estimate: estimateMonthly(catalog, entitlements), over: overCapacity(entitlements, usage),
    payments: { stripe: stripeEnabled() },
  };
}

// ── Stripe (webhook is mounted BEFORE auth: Stripe has no session) ──────────

router.post('/webhook', async (req, res: Response) => {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Missing signature or raw body' });
  try {
    const event = constructWebhookEvent(req.body, signature);
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    logger.warn('[stripe-plan] webhook rejected', { error: safeErrorMessage(error) });
    res.status(400).json({ error: safeErrorMessage(error) });
  }
});

router.use(authMiddleware);

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const orgId = typeof req.query.org_id === 'string' ? req.query.org_id : '';
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  if (!(await isOrgMember(req.user!.id, orgId))) return res.status(403).json({ error: 'Not a member of this organization' });
  try {
    res.json(await planSnapshot(orgId));
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

router.patch('/', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = quantitiesSchema.extend({ org_id: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const { org_id: orgId, ...wanted } = parsed.data;
  if (!(await isOrgMember(req.user!.id, orgId))) return res.status(403).json({ error: 'Not a member of this organization' });
  try {
    const catalog = await getCatalog();
    const [current, usage] = await Promise.all([getEntitlements(orgId, catalog), getUsage(orgId)]);
    const next: Record<Unit, number> = { apps: current.apps, users: current.users, agents: current.agents, databases: current.databases };
    for (const unit of UNITS) {
      const q = wanted[unit];
      if (q === undefined) continue;
      const floor = Math.max(includedQuantity(catalog, unit), usage[unit]);
      if (q < floor) {
        return res.status(422).json({ error: `${unit} cannot go below ${floor}: ${usage[unit]} in use, ${includedQuantity(catalog, unit)} included in the base plan.` });
      }
      next[unit] = q;
    }
    const { error } = await supabase.from('org_entitlements').upsert({
      org_id: orgId, plan_id: catalog.id, ...next, source: 'manual', updated_at: new Date().toISOString(), updated_by: req.user!.id,
    });
    if (error) throw new Error(error.message);
    res.json(await planSnapshot(orgId));
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

/**
 * Start a Stripe Checkout for the wanted quantities. The plan changes only
 * when Stripe reports the subscription (webhook or the confirm call below).
 */
router.post('/checkout', async (req: AuthenticatedRequest, res: Response) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  const parsed = quantitiesSchema.extend({ org_id: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const { org_id: orgId, ...wanted } = parsed.data;
  if (!(await isOrgMember(req.user!.id, orgId))) return res.status(403).json({ error: 'Not a member of this organization' });
  try {
    const catalog = await getCatalog();
    const [current, usage] = await Promise.all([getEntitlements(orgId, catalog), getUsage(orgId)]);
    const quantities: Record<Unit, number> = { apps: current.apps, users: current.users, agents: current.agents, databases: current.databases };
    for (const unit of UNITS) {
      const q = wanted[unit];
      if (q === undefined) continue;
      const floor = Math.max(includedQuantity(catalog, unit), usage[unit]);
      if (q < floor) return res.status(422).json({ error: `${unit} cannot go below ${floor}: ${usage[unit]} in use, ${includedQuantity(catalog, unit)} included in the base plan.` });
      quantities[unit] = q;
    }
    const email = (req.user as { email?: string } | undefined)?.email ?? null;
    res.json(await createPlanCheckout(orgId, req.user!.id, email, quantities));
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

/** Back from Checkout: apply the subscription if it exists and say what happened. */
router.post('/checkout/confirm', async (req: AuthenticatedRequest, res: Response) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  const parsed = z.object({ org_id: z.string().uuid(), session_id: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'org_id and session_id are required' });
  if (!(await isOrgMember(req.user!.id, parsed.data.org_id))) return res.status(403).json({ error: 'Not a member of this organization' });
  try {
    const outcome = await confirmCheckout(parsed.data.session_id, parsed.data.org_id);
    res.json({ ...outcome, plan: await planSnapshot(parsed.data.org_id) });
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

/** Stripe billing portal: invoices, card, cancel. */
router.post('/portal', async (req: AuthenticatedRequest, res: Response) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  const parsed = z.object({ org_id: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'org_id is required' });
  if (!(await isOrgMember(req.user!.id, parsed.data.org_id))) return res.status(403).json({ error: 'Not a member of this organization' });
  try {
    res.json({ url: await createPortalSession(parsed.data.org_id) });
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// ── Admin ───────────────────────────────────────────────────────────────────

router.use('/admin', async (req: AuthenticatedRequest, res: Response, next) => {
  if (!(await isAdmin(req.user!.id))) return res.status(403).json({ error: 'Admin access required' });
  next();
});

router.get('/admin/catalog', async (_req, res: Response) => {
  res.json({ catalog: await getCatalog() });
});

const catalogPatchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  base_price_cents: z.number().int().min(0).optional(),
  app_price_cents: z.number().int().min(0).optional(),
  user_price_cents: z.number().int().min(0).optional(),
  agent_price_cents: z.number().int().min(0).optional(),
  database_price_cents: z.number().int().min(0).optional(),
  included_apps: z.number().int().min(0).optional(),
  included_users: z.number().int().min(0).optional(),
  included_agents: z.number().int().min(0).optional(),
  included_databases: z.number().int().min(0).optional(),
  included_eco_per_app: z.number().int().min(0).optional(),
  overage_policy: z.enum(['stop', 'allow']).optional(),
  includes: z.array(z.string().min(1).max(40)).max(10).optional(),
});

router.patch('/admin/catalog', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = catalogPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const { error } = await supabase.from('billing_catalog')
    .update({ ...parsed.data, updated_at: new Date().toISOString(), updated_by: req.user!.id })
    .eq('id', 'single');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ catalog: await getCatalog() });
});

router.get('/admin/entitlements/:orgId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await planSnapshot(req.params.orgId));
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

router.patch('/admin/entitlements/:orgId', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = quantitiesSchema.extend({ eco_per_app: z.number().int().min(0).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
  const orgId = req.params.orgId;
  try {
    const catalog = await getCatalog();
    const current = await getEntitlements(orgId, catalog);
    const { error } = await supabase.from('org_entitlements').upsert({
      org_id: orgId, plan_id: catalog.id,
      apps: parsed.data.apps ?? current.apps, users: parsed.data.users ?? current.users,
      agents: parsed.data.agents ?? current.agents, databases: parsed.data.databases ?? current.databases,
      eco_per_app: parsed.data.eco_per_app === undefined ? current.eco_per_app : parsed.data.eco_per_app,
      source: 'admin', updated_at: new Date().toISOString(), updated_by: req.user!.id,
    });
    if (error) throw new Error(error.message);
    res.json(await planSnapshot(orgId));
  } catch (error) {
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

export default router;
