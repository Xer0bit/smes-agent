import { describe, it, expect } from 'vitest';
import { computeExtras, extrasHash } from '../deps';

describe('per-project dependency layer', () => {
  it('computeExtras keeps only packages the shared install lacks', () => {
    const extras = computeExtras({
      dependencies: { react: '^18.3.1', 'tiny-invariant': '^1.3.3', local: 'file:../x' },
      devDependencies: { vite: '^5', 'some-dev-only': '1.0.0' },
    });
    expect(extras.react).toBeUndefined();
    expect(extras.vite).toBeUndefined();
    expect(extras.local).toBeUndefined();
    expect(extras['tiny-invariant']).toBe('^1.3.3');
    expect(extras['some-dev-only']).toBe('1.0.0');
  });

  it('extrasHash is order-independent and version-sensitive', () => {
    expect(extrasHash({ a: '1', b: '2' })).toBe(extrasHash({ b: '2', a: '1' }));
    expect(extrasHash({ a: '1', b: '2' })).not.toBe(extrasHash({ a: '1', b: '3' }));
  });
});
