import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPreviewNavigationUrl, normalizePreviewRoute } from '../previewNavigation';

const BASE = 'https://preview.SMEsAgent.app/project-abc';

describe('normalizePreviewRoute', () => {
  it('plain route   returned as-is', () => {
    expect(normalizePreviewRoute('/post-gig')).toBe('/post-gig');
  });

  it('root   returned as "/"', () => {
    expect(normalizePreviewRoute('/')).toBe('/');
  });

  it('empty string   returns "/"', () => {
    expect(normalizePreviewRoute('')).toBe('/');
  });

  it('old sendNav format: full pathname+hash   extracts hash route', () => {
    const raw = '/preview/7398011a-2d58-4fae-9666-1bb5ca964ec5/?t=123#/post-gig';
    expect(normalizePreviewRoute(raw)).toBe('/post-gig');
  });

  it('old sendNav format: full pathname without hash   strips /preview/{id}/ prefix', () => {
    const raw = '/preview/7398011a-2d58-4fae-9666-1bb5ca964ec5/shop';
    expect(normalizePreviewRoute(raw)).toBe('/shop');
  });

  it('hash-only fragment   strips leading #', () => {
    expect(normalizePreviewRoute('#/checkout')).toBe('/checkout');
  });

  it('hash points to root   returns "/"', () => {
    expect(normalizePreviewRoute('#/')).toBe('/');
  });
});

describe('buildPreviewNavigationUrl', () => {
  it('root route   no hash fragment appended', () => {
    const url = buildPreviewNavigationUrl(BASE, '/');
    expect(url).not.toContain('#');
    expect(url).toBe(`${BASE}/`);
  });

  it('non-root route   appends hash fragment', () => {
    const url = buildPreviewNavigationUrl(BASE, '/explore');
    expect(url).toContain('/#/explore');
  });

  it('cacheBust=true   adds ?t= query param', () => {
    const url = buildPreviewNavigationUrl(BASE, '/', true);
    expect(url).toMatch(/\?t=\d+/);
  });

  it('cacheBust=true with non-root route   ?t= before hash', () => {
    const url = buildPreviewNavigationUrl(BASE, '/shop', true);
    const tIndex = url.indexOf('?t=');
    const hashIndex = url.indexOf('#');
    expect(tIndex).toBeGreaterThan(-1);
    expect(tIndex).toBeLessThan(hashIndex);
  });

  it('baseUrl already has a hash   old hash is stripped', () => {
    const urlWithHash = `${BASE}/#/old-route`;
    const url = buildPreviewNavigationUrl(urlWithHash, '/new-route');
    expect(url).not.toContain('/old-route');
    expect(url).toContain('/#/new-route');
  });

  it('baseUrl with existing query param   uses & not ? for cacheBust', () => {
    const urlWithQuery = `${BASE}?token=xyz`;
    const url = buildPreviewNavigationUrl(urlWithQuery, '/', true);
    expect(url).toContain('&t=');
    expect(url).not.toMatch(/\?t=/);
  });

  it('route without leading slash   normalized to /route', () => {
    const url = buildPreviewNavigationUrl(BASE, 'about');
    expect(url).toContain('/#/about');
  });

  it('empty route string   treated as no route (no hash appended)', () => {
    const url = buildPreviewNavigationUrl(BASE, '');
    expect(url).not.toContain('#');
    expect(url).toBe(`${BASE}/`);
  });

  // A/B: old behaviour (no route argument) vs new behaviour (route preserved)
  it('AB old   calling without route gives clean base URL', () => {
    // Simulates legacy call where route was not passed
    const url = buildPreviewNavigationUrl(BASE, '/');
    expect(url).toBe(`${BASE}/`);
  });

  it('AB new   calling with a specific route preserves it in hash', () => {
    const url = buildPreviewNavigationUrl(BASE, '/checkout/success');
    expect(url).toBe(`${BASE}/#/checkout/success`);
  });

  it('baseUrl with trailing slash   trailing slash removed before route', () => {
    const url = buildPreviewNavigationUrl(`${BASE}/`, '/products');
    expect(url).toContain('/#/products');
    // no double slash before #
    expect(url).not.toMatch(/\/\/#/);
  });
});
