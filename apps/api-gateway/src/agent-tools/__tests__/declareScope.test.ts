/**
 * Increment-2 scope matching. The gate is opt-in and soft, so its ONE piece of
 * real logic is pathMatchesScope: does a write target fall within a declared
 * file or directory prefix. The trailing-slash / leading-slash normalization is
 * the bug-prone part -- a declared "src/pages/checkout/" that failed to match
 * "src/pages/checkout/Cart.tsx" would silently block every legitimate write
 * under it, which is exactly the false-positive this test exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { normalizeScopePath, pathMatchesScope } from '../declare_scope.js';

describe('normalizeScopePath', () => {
  it('strips leading/trailing slashes and backslashes to one convention', () => {
    expect(normalizeScopePath('/src/App.tsx')).toBe('src/App.tsx');
    expect(normalizeScopePath('src/pages/checkout/')).toBe('src/pages/checkout');
    expect(normalizeScopePath('src\\components\\Nav.tsx')).toBe('src/components/Nav.tsx');
  });
});

describe('pathMatchesScope', () => {
  it('matches an exact declared file', () => {
    expect(pathMatchesScope('src/App.tsx', new Set(['src/App.tsx']))).toBe(true);
  });

  it('matches any file under a declared directory prefix, slash or no slash', () => {
    expect(pathMatchesScope('src/pages/checkout/Cart.tsx', new Set(['src/pages/checkout']))).toBe(true);
    expect(pathMatchesScope('src/pages/checkout/Cart.tsx', new Set(['src/pages/checkout/']))).toBe(true);
    expect(pathMatchesScope('/src/pages/checkout/Cart.tsx', new Set(['src/pages/checkout']))).toBe(true);
  });

  it('does NOT match a sibling that merely shares a name prefix', () => {
    // "src/pages/checkout2" must not be treated as inside "src/pages/checkout".
    expect(pathMatchesScope('src/pages/checkout2/Cart.tsx', new Set(['src/pages/checkout']))).toBe(false);
  });

  it('does NOT match a file outside every declared path', () => {
    expect(pathMatchesScope('src/pages/admin/Users.tsx', new Set(['src/pages/checkout', 'src/App.tsx']))).toBe(false);
  });
});
