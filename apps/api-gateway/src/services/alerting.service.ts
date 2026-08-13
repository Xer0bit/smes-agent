/**
 * Alerting Service
 *
 * Dispatches structured alerts (e.g. a provider auto-disable) to an
 * operator-configured sink. No sink is wired up by default; set
 * ALERT_WEBHOOK_URL to receive a JSON POST per alert. Unset is a true
 * no-op -- no network call, no thrown error -- so this can be called
 * unconditionally from hot paths (the hourly LLM health check) without
 * risking that path on a misconfigured or unreachable sink.
 */

import { logger } from '../utils/logger.js';

export type AlertSeverity = 'warning' | 'critical';

export type ProviderAlert = {
  provider: string;
  reason: string;
  severity: AlertSeverity;
};

function isConfigured(): boolean {
  return Boolean(process.env.ALERT_WEBHOOK_URL);
}

async function dispatch(alert: ProviderAlert): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    logger.debug(`[Alerting] No sink configured, skipping alert for ${alert.provider}`);
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...alert, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn(`[Alerting] Sink returned ${res.status} for ${alert.provider} alert`);
    }
  } catch (err: unknown) {
    // The sink being slow, unreachable, or misconfigured must never take
    // down the caller (the LLM health check's own job -- disabling a
    // broken provider -- has to complete regardless of alert delivery).
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[Alerting] Failed to dispatch alert for ${alert.provider}: ${message}`);
  }
}

export const AlertingService = { dispatch, isConfigured };
