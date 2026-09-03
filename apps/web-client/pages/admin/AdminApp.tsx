import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { cn } from '@/lib/utils';
import logo from '@/assets/ecg-logo.png';

import AdminDashboard from './Dashboard';
import AdminUsers from './Users';
import AdminOrganizations from './Organizations';
import AdminProjects from './Projects';
import AdminInvitations from './Invitations';
import AdminSubscriptions from './Subscriptions';
import AdminRolesPermissions from './RolesPermissions';
import AdminDelivery from './Delivery';
import AdminUsage from './Usage';
import AdminAIMetrics from './AIMetrics';
import AdminEcgAgents from './EcgAgents';
import AdminServers from './Servers';
import AdminHosting from './Hosting';
import AdminDatabaseHosting from './DatabaseHosting';
import AdminSettings from './Settings';

const NAV: Array<{ label: string; path: string }> = [
  { label: 'Overview', path: '/admin/dashboard' },
  { label: 'Users', path: '/admin/users' },
  { label: 'Organizations', path: '/admin/organizations' },
  { label: 'Projects', path: '/admin/projects' },
  { label: 'Invitations', path: '/admin/invitations' },
  { label: 'Billing', path: '/admin/subscriptions' },
  { label: 'Roles', path: '/admin/roles' },
  { label: 'Runs', path: '/admin/delivery' },
  { label: 'Usage', path: '/admin/usage' },
  { label: 'AI cost', path: '/admin/ai-metrics' },
  { label: 'Agents', path: '/admin/ecg-agents' },
  { label: 'Servers', path: '/admin/servers' },
  { label: 'Hosting', path: '/admin/hosting' },
  { label: 'Databases', path: '/admin/database-hosting' },
  { label: 'LLM', path: '/admin/llm-settings' },
];

export default function AdminApp() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { navigate('/admin/login'); return; }
      const { data } = await supabase.from('user_roles').select('role').eq('user_id', session.user.id).in('role', ['super_admin', 'admin']).maybeSingle();
      if (!data) { navigate('/admin/login'); return; }
      setEmail(session.user.email ?? '');
      setReady(true);
    })();
  }, [navigate]);

  const logout = async () => { await supabase.auth.signOut(); navigate('/admin/login'); };
  const title = NAV.find((n) => location.pathname.startsWith(n.path))?.label ?? 'Admin';

  if (!ready) return <div className="min-h-screen bg-[#0b0c10]" />;

  return (
    <div className="min-h-screen flex bg-[#0b0c10] text-gray-200">
      <aside className="w-[200px] shrink-0 border-r border-white/10 flex flex-col sticky top-0 h-screen">
        <div className="h-12 flex items-center gap-2 px-4 border-b border-white/10">
          <img src={logo} alt="" className="h-4 w-auto" />
          <span className="text-xs font-semibold text-white tracking-wide">Admin</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {NAV.map((n) => (
            <NavLink key={n.path} to={n.path} className={({ isActive }) => cn('block mx-2 px-2 h-8 leading-8 rounded text-[13px]', isActive ? 'bg-white/[0.07] text-white' : 'text-gray-400 hover:text-white hover:bg-white/[0.04]')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-[11px] text-gray-500 flex items-center justify-between gap-2">
          <span className="truncate" title={email}>{email}</span>
          <button onClick={logout} className="text-gray-400 hover:text-white shrink-0">Log out</button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="h-12 flex items-center px-6 border-b border-white/10 text-xs text-gray-500">{title}</div>
        <div className="p-6 max-w-[1400px]">
          <Routes>
            <Route index element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="dashboard" element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="organizations" element={<AdminOrganizations />} />
            <Route path="projects" element={<AdminProjects />} />
            <Route path="invitations" element={<AdminInvitations />} />
            <Route path="subscriptions" element={<AdminSubscriptions />} />
            <Route path="roles" element={<AdminRolesPermissions />} />
            <Route path="delivery" element={<AdminDelivery />} />
            <Route path="usage" element={<AdminUsage />} />
            <Route path="ai-metrics" element={<AdminAIMetrics />} />
            <Route path="ecg-agents" element={<AdminEcgAgents />} />
            <Route path="servers" element={<AdminServers />} />
            <Route path="hosting" element={<AdminHosting />} />
            <Route path="database-hosting" element={<AdminDatabaseHosting />} />
            <Route path="llm-settings" element={<AdminSettings />} />
            <Route path="settings" element={<Navigate to="/admin/llm-settings" replace />} />
            <Route path="system-status" element={<Navigate to="/admin/servers" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
