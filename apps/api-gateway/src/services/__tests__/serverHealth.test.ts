import { describe, it, expect, vi } from 'vitest';
import { classifyProbe, summarizeBody } from '../serverHealth.js';
import { uptimePercent, healthUrl } from '../serverStatus.service.js';
vi.mock('../../config/database.js', () => ({ supabase: {}, supabaseAuth: {}, default: {} }));

describe('serverStatus', () => {
  it('uptime is the healthy share, one decimal', () => {
    expect(uptimePercent([])).toBeNull();
    expect(uptimePercent([{ status: 'healthy' }, { status: 'healthy' }, { status: 'degraded' }])).toBe(66.7);
    expect(uptimePercent([{ status: 'unreachable' }])).toBe(0);
  });
  it('joins base url and health path', () => {
    expect(healthUrl({ base_url: 'https://a.b/', health_path: 'health' })).toBe('https://a.b/health');
    expect(healthUrl({ base_url: 'https://a.b', health_path: '/' })).toBe('https://a.b/');
  });
});

describe('serverHealth', () => {
  it('classifies by http status then body status words', () => {
    expect(classifyProbe(200, { status: 'healthy' })).toBe('healthy');
    expect(classifyProbe(200, { status: 'ok' })).toBe('healthy');
    expect(classifyProbe(200, { ok: true })).toBe('healthy');
    expect(classifyProbe(200, 'not json')).toBe('healthy');
    expect(classifyProbe(200, { status: 'draining' })).toBe('degraded');
    expect(classifyProbe(200, { ok: false })).toBe('degraded');
    expect(classifyProbe(503, { status: 'ok' })).toBe('degraded');
    expect(classifyProbe(404, null)).toBe('degraded');
  });

  it('summarizes bodies to scalar fields', () => {
    const s = summarizeBody({ status: 'ok', uptime: 12, serves: { gen: true, api: false }, mountedRoutes: ['/a', '/b'], big: 'x'.repeat(200), nested: { deep: { a: 1 } } });
    expect(s).not.toHaveProperty('nested');
    expect(s).toMatchObject({ status: 'ok', uptime: 12, serves: { gen: true, api: false }, mountedRoutes: ['/a', '/b'] });
    expect((s!.big as string).length).toBeLessThan(130);
    expect(summarizeBody([1, 2])).toBeNull();
    expect(summarizeBody('x')).toBeNull();
  });
});
