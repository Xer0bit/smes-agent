import { Router, Request, Response } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { supabase } from '../config/database.js';
import { issueDashboardAccessToken } from '../utils/dashboardAccessToken.js';

const router = Router();

// POST /api/v1/ecg-access?projectId=
// Anonymous   visitors to a deployed dashboard have no SMEsAgent account.
// Issues a short-lived token for ecg-proxy/ecg-chat. If the project has no
// password set, issues one unconditionally (dashboard is open by default).
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const projectId = req.query.projectId as string | undefined;
  if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }

  const { password } = req.body as { password?: string };

  const { data: rows } = await supabase
    .from('project_secrets')
    .select('key_name, key_value')
    .eq('project_id', projectId)
    .in('key_name', ['ECG_ACCESS_PASSWORD_HASH', 'ECG_ACCESS_PASSWORD_SALT']);

  const secrets = Object.fromEntries((rows ?? []).map(r => [r.key_name, r.key_value]));
  const storedHash = secrets['ECG_ACCESS_PASSWORD_HASH'];
  const salt = secrets['ECG_ACCESS_PASSWORD_SALT'];

  if (!storedHash || !salt) {
    // No password configured   open dashboard.
    res.json({ accessToken: issueDashboardAccessToken(projectId) });
    return;
  }

  if (!password) { res.status(401).json({ error: 'Password required' }); return; }

  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  res.json({ accessToken: issueDashboardAccessToken(projectId) });
});

export default router;
