/**
 * Verifies the CP2 provider-disable alert hook added to
 * testAndAutoDisableProviders(): fires AlertingService.dispatch exactly on
 * an ok->not-ok transition (including the null-baseline first run), never
 * on a repeat of an already-failing provider, and never lets a sink failure
 * escape or block the health check itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../llm-control.service.js', () => ({
  getLlmControlState: vi.fn(async () => ({
    apiKeys: {
      anthropic: 'test-anthropic-key',
      deepseek: 'test-deepseek-key',
      gemini: 'test-gemini-key',
      zai: 'test-zai-key',
    },
  })),
  updateLlmControlState: vi.fn(async () => ({})),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function anthropicResponse(status: number) {
  return { status, json: async () => ({}) };
}

// deepseek/gemini/zai stay healthy throughout every test -- kept out of
// `failing` so they never generate alert noise, isolating each test's
// assertions to anthropic's transitions.
const OTHER_PROVIDER_HOSTS = ['deepseek.com', 'googleapis.com', 'z.ai'];
function isOtherProviderUrl(url: string): boolean {
  return OTHER_PROVIDER_HOSTS.some((host) => url.includes(host));
}

describe('llm-health provider-disable alert (CP2)', () => {
  const originalFetch = global.fetch;
  const originalAlertUrl = process.env.ALERT_WEBHOOK_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = originalAlertUrl;
  });

  it('alerts once on the first-ever check when the baseline provider is already failing (null lastResults)', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://sink.example.com/alert';
    const webhookFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('anthropic.com')) return anthropicResponse(401) as any;
      if (typeof url === 'string' && isOtherProviderUrl(url)) return { status: 200, json: async () => ({}) } as any;
      return webhookFetch(url) as any;
    }) as any;

    const { testAndAutoDisableProviders } = await import('../llm-health.service.js');
    const { AlertingService } = await import('../alerting.service.js');
    const dispatchSpy = vi.spyOn(AlertingService, 'dispatch');

    await testAndAutoDisableProviders();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', severity: 'critical' }),
    );
  });

  it('alerts on ok->not-ok transition, then does NOT re-alert on repeat failure', async () => {
    delete process.env.ALERT_WEBHOOK_URL; // no sink; only asserting dispatch call count
    let anthropicStatus = 200;
    global.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('anthropic.com')) return anthropicResponse(anthropicStatus) as any;
      return { ok: true, status: 200 } as any;
    }) as any;

    const { testAndAutoDisableProviders } = await import('../llm-health.service.js');
    const { AlertingService } = await import('../alerting.service.js');
    const dispatchSpy = vi.spyOn(AlertingService, 'dispatch');

    // Run 1: healthy baseline -- no alert (nothing failing).
    await testAndAutoDisableProviders();
    expect(dispatchSpy).not.toHaveBeenCalled();

    // Run 2: transitions to failing -- alert fires once.
    anthropicStatus = 401;
    await testAndAutoDisableProviders();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // Run 3: still failing (repeat) -- no additional alert.
    await testAndAutoDisableProviders();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws out of testAndAutoDisableProviders when the alert sink itself fails', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://sink.example.com/alert';
    global.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('anthropic.com')) return anthropicResponse(401) as any;
      if (typeof url === 'string' && isOtherProviderUrl(url)) return { status: 200, json: async () => ({}) } as any;
      throw new Error('ECONNREFUSED: sink unreachable');
    }) as any;

    const { testAndAutoDisableProviders } = await import('../llm-health.service.js');

    await expect(testAndAutoDisableProviders()).resolves.toBeDefined();
  });

  it('AlertingService.dispatch is a true no-op (no network call) when ALERT_WEBHOOK_URL is unset', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = fetchSpy as any;

    const { AlertingService } = await import('../alerting.service.js');
    expect(AlertingService.isConfigured()).toBe(false);

    await expect(
      AlertingService.dispatch({ provider: 'anthropic', reason: 'test', severity: 'critical' }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
