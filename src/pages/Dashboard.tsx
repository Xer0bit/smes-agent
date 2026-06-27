import { useEffect, useState } from 'react';
import * as React from 'react';
import { useNavigate, NavLink, Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  User as UserIcon,
  Loader2,
  LogOut,
  FolderKanban,
  Building2,
  Home,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import ecomgearLogo from '@/assets/ecomgear-logo.png';
import { useOrganization } from '@/contexts/OrganizationContext';
import { NotificationBell } from '@/components/dashboard/NotificationBell';

interface DashboardSidebarProps {
  user: User | null;
  currentOrganizationId: string | null;
  currentOrganization: { id: string; name: string; slug: string } | null;
  organizations: Array<{ id: string; name: string; slug: string }>;
  loadingOrganizations: boolean;
  setCurrentOrganizationId: (id: string | null) => void;
  handleLogout: () => Promise<void>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const DashboardSidebar = ({
  user,
  currentOrganizationId,
  currentOrganization,
  organizations,
  loadingOrganizations,
  setCurrentOrganizationId,
  handleLogout,
  collapsed,
  onToggleCollapse,
}: DashboardSidebarProps) => {
  const { t } = useTranslation();

  const menuItems = [
    { title: t('dashboard.home'), url: '/dashboard', icon: Home, end: true },
    { title: t('dashboard.organizations'), url: '/dashboard/organizations', icon: Building2 },
    { title: t('dashboard.projects'), url: '/dashboard/projects', icon: FolderKanban },
    { title: t('dashboard.profile'), url: '/dashboard/profile', icon: UserIcon },
    { title: 'Team Access', url: '/dashboard/team', icon: ShieldCheck },
    { title: t('dashboard.settings'), url: '/dashboard/settings', icon: Settings },
  ];

  return (
    <aside className={`border-b border-white/[0.06] bg-[#0e0e10] md:fixed md:left-0 md:top-0 md:z-20 md:h-screen md:border-b-0 md:border-r transition-[width] duration-300 ease-in-out ${collapsed ? 'md:w-[60px]' : 'md:w-60'}`}>
      <div className="flex h-full flex-col">
        <div className="border-b border-white/[0.06] px-4 py-4 md:px-3 md:py-5">
          <Link to="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center">
              <img
                src={ecomgearLogo}
                alt="eCOMGear logo"
                className="h-6 w-auto object-contain"
              />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/60">eComGear</p>
                <p className="truncate text-sm font-medium text-white">
                  {currentOrganization?.name || 'Workspace'}
                </p>
              </div>
            )}
          </Link>

          {!collapsed && (
            <div className="mt-4 space-y-1.5">
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/50">Workspace</p>
              <Select
                value={currentOrganizationId || undefined}
                onValueChange={(value) => setCurrentOrganizationId(value)}
                disabled={loadingOrganizations || organizations.length === 0}
              >
                <SelectTrigger className="h-8 rounded-md border-white/[0.08] bg-white/[0.04] text-xs text-white/80 focus:ring-0">
                  <SelectValue placeholder={loadingOrganizations ? 'Loading…' : 'No workspace'} />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex-1 px-2 py-4 overflow-hidden">
          {!collapsed && (
            <p className="mb-2 hidden px-2 text-[10px] uppercase tracking-[0.2em] text-white/50 md:block">
              Navigation
            </p>
          )}
          <nav className="flex gap-1.5 overflow-x-auto pb-1 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
            {menuItems.map((item) => (
              <NavLink
                key={item.title}
                to={item.url}
                end={item.end}
                title={collapsed ? item.title : undefined}
                className={({ isActive }) =>
                  `group flex min-w-fit items-center rounded-md text-sm transition-all duration-150 md:min-w-0 ${
                    collapsed ? 'justify-center p-2 gap-0' : 'gap-3 px-3 py-2'
                  } ${
                    isActive
                      ? 'bg-white/[0.08] text-white'
                      : 'text-white/40 hover:bg-white/[0.04] hover:text-white'
                  }`
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.title}</span>}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="border-t border-white/[0.06] px-2 py-3">
          {!collapsed && (
            <div className="mb-2 px-2">
              <p className="truncate text-xs font-medium text-white/80">
                {user?.user_metadata?.full_name || user?.email}
              </p>
              <p className="text-[11px] text-white/50 mt-0.5">
                {currentOrganization?.slug ? `@${currentOrganization.slug}` : 'No workspace'}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <Button onClick={handleLogout} variant="ghost" size="sm" className={`w-full rounded-md text-white/40 hover:bg-white/[0.04] hover:text-white ${collapsed ? 'justify-center px-0' : 'justify-start'}`} title={collapsed ? t('dashboard.logout') : undefined}>
              <LogOut className={collapsed ? 'h-4 w-4' : 'mr-2 h-4 w-4'} />
              {!collapsed && t('dashboard.logout')}
            </Button>
            <Button onClick={onToggleCollapse} variant="ghost" size="sm" className={`hidden md:flex w-full rounded-md text-white/50 hover:bg-white/[0.04] hover:text-white/80 ${collapsed ? 'justify-center px-0' : 'justify-start'}`}>
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="mr-2 h-4 w-4" />Collapse</>}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
};

export function DashboardLayout({ children }: { children?: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    currentOrganizationId,
    currentOrganization,
    organizations,
    loadingOrganizations,
    refreshOrganization,
    setCurrentOrganizationId,
  } = useOrganization();

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      navigate('/auth');
      return;
    }
    // Block admins from the user panel — redirect them to the admin panel
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', session.user.id)
      .in('role', ['super_admin', 'admin'])
      .maybeSingle();
    if (roleData) {
      navigate('/admin/dashboard');
      return;
    }
    setUser(session.user);
    await refreshOrganization(session.user);
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#09090b]">
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-[#0e0e10] px-5 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-white/40" />
          <div>
            <p className="text-sm font-medium text-white/80">Preparing your workspace</p>
            <p className="text-xs text-white/30 mt-0.5">Checking access…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[#09090b]">
      <DashboardSidebar
        user={user}
        currentOrganizationId={currentOrganizationId}
        currentOrganization={currentOrganization}
        organizations={organizations}
        loadingOrganizations={loadingOrganizations}
        setCurrentOrganizationId={setCurrentOrganizationId}
        handleLogout={handleLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className={`flex min-h-screen flex-1 flex-col transition-[margin] duration-300 ease-in-out ${sidebarCollapsed ? 'md:ml-[60px]' : 'md:ml-60'}`}>
        <header className="sticky top-0 z-10 border-b border-white/[0.04] bg-[#131315]/80 backdrop-blur-xl">
          <div className="flex h-14 items-center justify-between px-5 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  {user?.user_metadata?.full_name || user?.email}
                </p>
                <p className="text-xs text-white/30">
                  {currentOrganization ? currentOrganization.name : 'Select workspace'}
                </p>
              </div>
            </div>
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 pb-12">
          <div className="mx-auto min-h-full max-w-[1400px]">
            {children ?? <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
}
