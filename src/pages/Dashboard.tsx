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
    <aside className={`border-b border-white/10 bg-[linear-gradient(180deg,rgba(9,20,33,0.98),rgba(9,20,33,0.92))] md:fixed md:left-0 md:top-0 md:z-20 md:h-screen md:border-b-0 md:border-r transition-[width] duration-300 ease-in-out ${collapsed ? 'md:w-[68px]' : 'md:w-64'}`}>
      <div className="flex h-full flex-col">
        <div className="border-b border-white/10 px-4 py-4 md:px-3 md:py-5">
          <Link to="/" className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center   shadow-[0_18px_40px_rgba(0,0,0,0.22)]">
              <img 
                src={ecomgearLogo} 
                alt="eCOMGear logo" 
                className="h-7 w-auto object-contain"
              />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.26em] text-primary/80">eComGear</p>
                <p className="truncate text-sm font-medium text-foreground">
                  {currentOrganization?.name || 'Workspace'}
                </p>
              </div>
            )}
          </Link>

          {!collapsed && (
            <div className="mt-4 space-y-2">
              <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Switch Workspace</p>
              <Select
                value={currentOrganizationId || undefined}
                onValueChange={(value) => setCurrentOrganizationId(value)}
                disabled={loadingOrganizations || organizations.length === 0}
              >
                <SelectTrigger className="rounded-none border-white/12 bg-white/[0.03] text-sm">
                  <SelectValue placeholder={loadingOrganizations ? 'Loading workspaces...' : 'No workspace available'} />
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

        <div className="flex-1 px-3 py-3 md:px-2 md:py-5 overflow-hidden">
          {!collapsed && (
            <div className="mb-3 hidden px-3 text-[10px] uppercase tracking-[0.24em] text-muted-foreground md:block">
              Navigation
            </div>
          )}
          <nav className="flex gap-2 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0">
            {menuItems.map((item) => (
              <NavLink
                key={item.title}
                to={item.url}
                end={item.end}
                title={collapsed ? item.title : undefined}
                className={({ isActive }) =>
                  `group flex min-w-fit items-center border text-sm transition-all md:min-w-0 ${
                    collapsed ? 'justify-center px-0 py-2.5 gap-0' : 'gap-3 px-3 py-2.5'
                  } ${
                    isActive
                      ? 'border-primary/35 bg-primary/12 text-foreground shadow-[0_10px_26px_rgba(0,209,178,0.08)]'
                      : 'border-transparent bg-white/[0.02] text-muted-foreground hover:border-white/10 hover:bg-white/[0.05] hover:text-foreground'
                  }`
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.title}</span>}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="border-t border-white/10 px-2 py-3 md:py-4">
          {!collapsed && (
            <div className="mb-3 px-3">
              <p className="truncate text-sm font-medium text-foreground">
                {user?.user_metadata?.full_name || user?.email}
              </p>
              <p className="text-xs text-muted-foreground">
                {currentOrganization?.slug ? `@${currentOrganization.slug}` : 'No workspace selected'}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Button onClick={handleLogout} variant="neutral" size="sm" className={`w-full rounded-none ${collapsed ? 'justify-center px-0' : 'justify-start'}`} title={collapsed ? t('dashboard.logout') : undefined}>
              <LogOut className={collapsed ? 'h-4 w-4' : 'mr-2 h-4 w-4'} />
              {!collapsed && t('dashboard.logout')}
            </Button>
            <Button onClick={onToggleCollapse} variant="ghost" size="sm" className={`hidden md:flex w-full rounded-none text-muted-foreground hover:text-foreground ${collapsed ? 'justify-center px-0' : 'justify-start'}`}>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,hsl(var(--background)),hsl(215_34%_10%))]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary))/0.14,transparent_28%),radial-gradient(circle_at_90%_0%,hsl(var(--accent))/0.12,transparent_24%)]" />
        <div className="relative flex items-center gap-3 border border-white/10 bg-card/80 px-5 py-4 shadow-[0_24px_80px_rgba(3,12,27,0.45)] backdrop-blur-xl">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Preparing your workspace</p>
            <p className="text-xs text-muted-foreground">Checking access and loading your dashboard.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[linear-gradient(180deg,hsl(var(--background)),hsl(215_34%_10%))]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary))/0.12,transparent_24%),radial-gradient(circle_at_85%_15%,hsl(var(--accent))/0.10,transparent_22%)]" />
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

      <div className={`relative flex min-h-screen flex-1 flex-col transition-[margin] duration-300 ease-in-out ${sidebarCollapsed ? 'md:ml-[68px]' : 'md:ml-64'}`}>
        <header className="sticky top-0 z-10 border-b border-white/10 bg-[rgba(8,16,27,0.72)] backdrop-blur-xl">
          <div className="flex flex-col gap-2 px-4 py-4 sm:px-6 md:h-20 md:justify-center md:py-0">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h1 className="text-sm font-semibold text-foreground sm:text-base">
                  {user?.user_metadata?.full_name || user?.email}
                </h1>
                <p className="text-xs text-muted-foreground">
                  {currentOrganization ? currentOrganization.name : 'Select workspace'}
                </p>
              </div>
              <NotificationBell />
            </div>
          </div>
        </header>

        <main className="relative flex-1 px-0 pb-10">
          <div className="mx-auto min-h-full max-w-[1600px]">
            {children ?? <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
}
