import { useEffect, useState } from 'react';
import * as React from 'react';
import { useNavigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator } from '@/components/ui/select';
import {
  Loader2,
  LogOut,
  FolderKanban,
  Building2,
  Home,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Bot,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import ecomgearLogo from '@/assets/ecomgear-logo.png';
import { useOrganization } from '@/contexts/OrganizationContext';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { CreateWorkspaceDialog } from '@/components/dashboard/CreateWorkspaceDialog';

const CREATE_WORKSPACE_VALUE = '__create_workspace__';

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
  onCreateWorkspace: () => void;
}

const DashboardSidebar = ({
  user,
  currentOrganizationId,
  currentOrganization,
  organizations,
  loadingOrganizations,
  setCurrentOrganizationId,
  handleLogout,
  collapsed: collapsedPref,
  onToggleCollapse,
  onCreateWorkspace,
}: DashboardSidebarProps) => {
  const { t } = useTranslation();
  // Hovering a collapsed sidebar temporarily expands it; the saved preference
  // is untouched, so it collapses again on mouse-out. The workspace Select
  // renders its menu in a portal OUTSIDE the aside, so moving the mouse into
  // it fires mouseleave and would collapse the sidebar mid-interaction,
  // unmounting the open Select ({!collapsed && ...}) -- hold the sidebar open
  // while the Select is open.
  const [hoverOpen, setHoverOpen] = useState(false);
  const [orgSelectOpen, setOrgSelectOpen] = useState(false);
  const collapsed = collapsedPref && !hoverOpen && !orgSelectOpen;

  const menuItems = [
    { title: t('dashboard.home'), url: '/dashboard', icon: Home, end: true },
    { title: 'Workspace Settings', url: '/dashboard/organizations', icon: Building2 },
    { title: t('dashboard.projects'), url: '/dashboard/projects', icon: FolderKanban },
    { title: 'Templates', url: '/dashboard/designs', icon: Sparkles },
    { title: t('dashboard.settings'), url: '/dashboard/settings', icon: Settings },
  ];

  const ecgAgentItems = [
    { title: 'eCG Agents', url: '/dashboard/ecg-agents', icon: Bot },
  ];

  const renderNavItem = (item: { title: string; url: string; icon: typeof Home; end?: boolean }) => (
    <NavLink
      key={item.title}
      to={item.url}
      end={item.end}
      title={collapsed ? item.title : undefined}
      className={({ isActive }) =>
        `group relative flex min-w-fit items-center rounded-lg text-sm transition-colors duration-150 md:min-w-0 ${
          collapsed ? 'justify-center p-2 gap-0' : 'gap-3 px-3 py-2'
        } ${
          isActive
            ? 'text-primary'
            : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="sidebar-nav-active"
              className="absolute inset-0 rounded-lg bg-primary/10"
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
          )}
          <item.icon className="relative z-[1] h-4 w-4 shrink-0" />
          <span
            className={`relative z-[1] overflow-hidden whitespace-nowrap transition-all duration-200 ${
              collapsed ? 'max-w-0 opacity-0' : 'max-w-[160px] opacity-100 delay-100'
            }`}
          >
            {item.title}
          </span>
        </>
      )}
    </NavLink>
  );

  const userInitial = (user?.user_metadata?.full_name || user?.email || '?').charAt(0).toUpperCase();

  return (
    <aside
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
      className={`border-b border-border/60 bg-card md:fixed md:left-0 md:top-0 md:z-20 md:h-screen md:border-b-0 md:border-r md:overflow-hidden transition-[width] duration-300 ease-in-out ${collapsed ? 'md:w-[60px]' : 'md:w-64'}`}
    >
      <div className="flex h-full flex-col">
        <div className={`border-b border-border/60 px-3 py-3 ${collapsed ? 'flex justify-center' : ''}`}>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-background/60"
            title={collapsedPref ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <img src={ecomgearLogo} alt="eCOMGear logo" className="h-5 w-auto object-contain" />
          </button>

          {!collapsed && (
            <Select
              value={currentOrganizationId || undefined}
              onOpenChange={setOrgSelectOpen}
              onValueChange={(value) => {
                if (value === CREATE_WORKSPACE_VALUE) onCreateWorkspace();
                else setCurrentOrganizationId(value);
              }}
              disabled={loadingOrganizations}
            >
              <SelectTrigger className="mt-2.5 h-10 rounded-full border-border/60 bg-background/60 pl-1.5 pr-2.5 text-xs text-foreground focus:ring-0 [&>span]:flex [&>span]:min-w-0 [&>span]:flex-1">
                <SelectValue placeholder={loadingOrganizations ? 'Loading…' : 'No workspace'} className="truncate" />
              </SelectTrigger>
              <SelectContent className="min-w-[15rem] rounded-xl border-border/60 bg-card p-1.5 text-foreground shadow-[var(--elev-2)]">
                {organizations.map((organization) => (
                  <SelectItem
                    key={organization.id}
                    value={organization.id}
                    className="rounded-lg py-2 pl-8 pr-2 focus:bg-primary/10 focus:text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      {organization.avatar_url ? (
                        <img src={organization.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold bg-primary/15 text-primary">
                          {organization.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="truncate">{organization.name}</span>
                    </span>
                  </SelectItem>
                ))}
                <SelectSeparator className="bg-border/60" />
                <SelectItem
                  value={CREATE_WORKSPACE_VALUE}
                  className="rounded-lg py-2 pl-8 pr-2 text-primary focus:bg-primary/10 focus:text-primary"
                >
                  <span className="flex items-center gap-2">
                    <Plus className="h-3.5 w-3.5" />
                    Create workspace
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex-1 space-y-4 px-2 py-4 overflow-hidden">
          <div>
            <p
              className={`mb-2 hidden px-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground md:block overflow-hidden transition-all duration-200 ${
                collapsed ? 'max-h-0 opacity-0 mb-0' : 'max-h-4 opacity-100 delay-100'
              }`}
            >
              Navigation
            </p>
            <nav className="flex gap-1.5 overflow-x-auto pb-1 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
              {menuItems.map((item) => renderNavItem(item))}
            </nav>
          </div>

          <div>
            <p
              className={`mb-2 hidden px-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground md:block overflow-hidden transition-all duration-200 ${
                collapsed ? 'max-h-0 opacity-0 mb-0' : 'max-h-4 opacity-100 delay-100'
              }`}
            >
              eCG Agents
            </p>
            <nav className="flex gap-1.5 overflow-x-auto pb-1 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
              {ecgAgentItems.map((item) => renderNavItem(item))}
            </nav>
          </div>
        </div>

        <div className="border-t border-border/60 px-2 py-3">
          <div
            className={`overflow-hidden transition-all duration-200 ${
              collapsed ? 'max-h-0 opacity-0' : 'mb-3 max-h-10 opacity-100 delay-100'
            }`}
          >
            <div className="flex items-center gap-2.5 px-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {userInitial}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                  {user?.user_metadata?.full_name || user?.email}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {currentOrganization?.slug ? `@${currentOrganization.slug}` : 'No workspace'}
                </p>
              </div>
              <NotificationBell />
            </div>
          </div>
          {collapsed && (
            <div className="mb-3 flex justify-center">
              <NotificationBell />
            </div>
          )}
          <div className={`flex gap-1.5 ${collapsed ? 'flex-col items-center' : ''}`}>
            <Button
              onClick={handleLogout}
              variant="outline"
              size="sm"
              className={`rounded-full border-border/60 bg-background/60 text-muted-foreground hover:bg-card hover:text-foreground ${collapsed ? 'h-9 w-9 justify-center p-0' : 'flex-1 justify-center'}`}
              title={t('dashboard.logout')}
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && <span className="ml-2">{t('dashboard.logout')}</span>}
            </Button>
            <Button
              onClick={onToggleCollapse}
              variant="outline"
              size="sm"
              className={`hidden rounded-full border-border/60 bg-background/60 text-muted-foreground hover:bg-card hover:text-foreground md:flex ${collapsed ? 'h-9 w-9 justify-center p-0' : 'justify-center px-3'}`}
              title={collapsedPref ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {/* Icon reflects the PINNED preference, not the temporary hover-expanded
                  view   otherwise clicking while hover-expanded would pin it open. */}
              {collapsedPref ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
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
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
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
    // Block admins from the user panel   redirect them to the admin panel
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-5 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Preparing your workspace</p>
            <p className="text-xs text-muted-foreground mt-0.5">Checking access…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background">
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
        onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
      />

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onUpgradeRequired={() => navigate('/dashboard/organizations')}
      />

      <div className={`flex min-h-screen flex-1 flex-col transition-[margin] duration-300 ease-in-out ${sidebarCollapsed ? 'md:ml-[60px]' : 'md:ml-64'}`}>
        <main className="flex-1 pb-12">
          <div className="mx-auto min-h-full max-w-[1400px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={children ? 'static' : location.pathname}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {children ?? <Outlet />}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
