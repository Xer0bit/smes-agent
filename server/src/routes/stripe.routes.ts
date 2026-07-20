import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';

const router = Router();
router.use(authMiddleware);

// ── POST /api/v1/stripe/:projectId/test ──────────────────────────────────────
// Verifies the project's stored Stripe secret key actually works, by calling
// Stripe's own /v1/account endpoint   the standard lightweight way to check a
// key without side effects. Never returns the key itself, only what Stripe
// reports about the account it belongs to.
router.post('/:projectId/test', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    await projectService.getProject(projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }

  const { data: row } = await supabase
    .from('project_secrets')
    .select('key_value')
    .eq('project_id', projectId)
    .eq('key_name', 'STRIPE_SECRET_KEY')
    .maybeSingle();

  const secretKey = row?.key_value;
  if (!secretKey) { res.status(400).json({ error: 'No Stripe Secret Key saved yet.' }); return; }

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await stripeRes.json() as { id?: string; business_profile?: { name?: string }; email?: string; error?: { message?: string } };
    if (!stripeRes.ok) {
      res.status(400).json({ connected: false, error: body.error?.message ?? `Stripe rejected the key (${stripeRes.status})` });
      return;
    }
    res.json({
      connected: true,
      accountId: body.id,
      accountName: body.business_profile?.name || body.email || body.id,
      mode: secretKey.startsWith('sk_live_') ? 'live' : 'test',
    });
  } catch (err) {
    res.status(502).json({ connected: false, error: (err as Error).message ?? 'Could not reach Stripe' });
  }
});

export default router;
