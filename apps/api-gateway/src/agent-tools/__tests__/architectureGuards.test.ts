import { describe, it, expect } from 'vitest';
import { findClientSideAdminToggle, isStructuralFile } from '../architectureGuards.js';

/**
 * The "admin page" that was a button on the user page (2026-09-02). These pin
 * the shapes that must be refused and, as importantly, the legitimate shapes
 * that must not be.
 */
describe('findClientSideAdminToggle', () => {
  it('catches a click-driven admin flag', () => {
    expect(findClientSideAdminToggle(`<button onClick={() => setIsAdmin(!isAdmin)}>Admin</button>`)).toContain('setIsAdmin(!isAdmin)');
    expect(findClientSideAdminToggle(`setAdminMode(true)`)).toContain('setAdminMode(true)');
    expect(findClientSideAdminToggle(`setIsAdmin(prev => !prev)`)).toContain('setIsAdmin(prev => !prev)');
  });

  it('catches a role kept in browser storage and a hardcoded password', () => {
    expect(findClientSideAdminToggle(`const role = localStorage.getItem('role');`)).toContain("localStorage.getItem('role')");
    expect(findClientSideAdminToggle(`if (password === 'admin123') setUser(admin)`)).toContain("password === 'admin123'");
  });

  it('leaves a role that comes from the session alone', () => {
    const legit = `
      const { data: session } = useSession();
      const isAdmin = session?.role === 'admin';
      if (!isAdmin) return <Navigate to="/" />;
      setIsAdmin(session.role === 'admin');
      localStorage.setItem('theme', 'dark');
    `;
    expect(findClientSideAdminToggle(legit)).toBeNull();
  });
});

describe('isStructuralFile', () => {
  it('names pages and the route table, not components or libs', () => {
    expect(isStructuralFile('src/pages/AdminDashboard.tsx')).toBe(true);
    expect(isStructuralFile('/src/App.tsx')).toBe(true);
    expect(isStructuralFile('src/components/Header.tsx')).toBe(false);
    expect(isStructuralFile('src/lib/api.ts')).toBe(false);
  });
});
