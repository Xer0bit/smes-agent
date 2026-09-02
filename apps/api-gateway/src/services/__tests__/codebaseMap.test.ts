import { describe, it, expect } from 'vitest';
import { buildCodebaseMap, extractRoutes } from '../codebaseMap.js';

const APP = `
import { Routes, Route } from 'react-router-dom';
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route path="products" element={<AdminProducts />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}`;

describe('extractRoutes', () => {
  it('pairs each route with its element', () => {
    expect(extractRoutes(APP)).toEqual(['/ -> Home', '/admin -> AdminLayout', 'products -> AdminProducts', '* -> NotFound']);
  });
});

describe('buildCodebaseMap', () => {
  it('describes structure by area, ignores the ui kit and node_modules, and lists edge functions', () => {
    const map = buildCodebaseMap([
      { path: 'src/App.tsx', content: APP },
      { path: 'src/pages/Home.tsx' }, { path: 'src/pages/admin/AdminProducts.tsx' },
      { path: 'src/components/Header.tsx' }, { path: 'src/components/ui/button.tsx' },
      { path: 'src/contexts/CartContext.tsx' }, { path: 'src/hooks/useCart.ts' },
      { path: 'src/services/orders.ts' }, { path: 'src/index.css' },
      { path: '__edge_functions__/auth_login.js' },
    ], { tables: ['products', 'orders'] });
    expect(map).toContain('Routes (4): / -> Home, /admin -> AdminLayout');
    expect(map).toContain('Pages (2): Home, AdminProducts');
    expect(map).toContain('Components (1): Header');
    expect(map).toContain('plus 1 ui-kit components');
    expect(map).toContain('State / contexts (1): CartContext');
    expect(map).toContain('Hooks (1): useCart');
    expect(map).toContain('Services / lib (1): services/orders.ts');
    expect(map).toContain('Edge functions (1): auth_login');
    expect(map).toContain('Database tables (2): products, orders');
  });

  it('says so when the project is only a scaffold', () => {
    expect(buildCodebaseMap([{ path: 'src/main.tsx' }, { path: 'src/index.css' }])).toContain('scaffold');
  });
});
