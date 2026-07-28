import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings, LucideIcon, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { ECG } from '../ecg-config';
import { ecgApi, getActiveAgentId, setActiveAgentId } from '../lib/ecgClient';
import TopBar from './TopBar';

// Live count of posts awaiting review, shown as a badge on Planned Posts.
// One fetch per mount  cheap, and the badge is advisory, not real-time.
function usePendingCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!ECG.modules.includes('posts')) return;
    ecgApi.posts.list()
      .then((d: any) => {
        const posts = Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? []);
        setCount(posts.filter((p: any) => p.status === 'draft').length);
      })
      .catch(() => {});
  }, []);
  return count;
}

const ALL_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings,
};

const ALL_NAV = [
  { id: 'dashboard',  label: 'Home',              path: '/',              icon: 'LayoutDashboard', always: true },
  { id: 'chat',       label: 'Assistant',         path: '/assistant',     icon: 'MessageSquare',   always: true },
  { id: 'agents',     label: 'My Agents',         path: '/agents',        icon: 'Zap' },
  { id: 'schedulers', label: 'Schedulers',        path: '/schedulers',    icon: 'Calendar' },
  // Content Calendar (not the flat list) is the primary Content destination
  // -- a non-technical user reviewing what's going out reads better as a
  // visual calendar than a status table. The flat list stays one click away
  // (PostsCalendarPage's own back button), for anyone who wants it.
  { id: 'posts',      label: 'Content Calendar',  path: '/posts/calendar', icon: 'Calendar' },
  { id: 'connectors', label: 'Connected Accounts', path: '/connectors',    icon: 'Plug' },
  { id: 'runs',       label: 'Run History',       path: '/runs',          icon: 'History' },
  { id: 'knowledge',  label: 'Brand Voice & Docs', path: '/knowledge',    icon: 'BookOpen' },
  { id: 'settings',   label: 'Settings',          path: '/settings',      icon: 'Settings', always: true },
];

// Run History is an execution-log concept most users only care about when
// something's wrong -- reachable via AgentDetailPage's "View all" link
// rather than a permanent sidebar slot. Schedulers used to be hidden the
// same way, but that made it undiscoverable to anyone who didn't already
// know it existed; it's common enough (setting a posting cadence) to earn
// a real nav entry.
const HIDDEN_FROM_SIDEBAR = ['runs'];

// Assistant defaults to visible (moduleSettings.chat undefined) so every
// dashboard generated before this toggle existed keeps behaving exactly as
// before; only an explicit { enabled: false } (set from Settings ->
// Customizer, or the dashboard-builder's project settings) hides it. Not
// gated through ECG.modules like the other items -- that array is opt-in at
// creation time only, and disabling the assistant is meant to be something
// the dashboard owner can flip later without re-selecting every other module.
const chatDisabled = ECG.moduleSettings.chat?.enabled === false;

// Order follows ECG.modules (set by drag-and-drop reordering in Dashboard
// Creator), not ALL_NAV's fixed declaration order   the always-shown tabs
// (Home, Assistant first; Settings last) stay pinned regardless of module
// order. Previously this used ALL_NAV.find(n => n.always), which only ever
// returns the FIRST always-item   Settings silently never made it into the
// sidebar at all. filter() picks up every always-item instead.
const NAV = [
  ...ALL_NAV.filter(n => n.always && n.id !== 'settings' && !(n.id === 'chat' && chatDisabled)),
  ...ECG.modules
    .filter(id => !HIDDEN_FROM_SIDEBAR.includes(id))
    .map(id => ALL_NAV.find(n => n.id === id))
    .filter((n): n is typeof ALL_NAV[number] => Boolean(n)),
  ALL_NAV.find(n => n.id === 'settings')!,
];

// Only rendered when this dashboard manages more than one agent. Switching
// reloads the page -- simplest way to guarantee every already-fetched page
// (posts/schedulers/runs, all scoped by ecgClient's withActiveAgent()) picks
// up the new agent's data, with no global state store to thread through.
function AgentSwitcher({ compact }: { compact?: boolean }) {
  const [active, setActive] = useState(() => getActiveAgentId());
  if (ECG.agentIds.length <= 1) return null;
  return (
    <select
      value={active ?? ''}
      onChange={(e) => { setActiveAgentId(e.target.value); setActive(e.target.value); window.location.reload(); }}
      title="Switch active agent"
      className={`w-full border px-2 py-1.5 truncate ${compact ? 'mt-1' : 'mt-2'}`}
      style={{ background: 'var(--sidebar-hover)', borderColor: 'var(--border)', color: 'var(--sidebar-text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius-sm)' }}
    >
      {ECG.agentIds.map((id) => (
        <option key={id} value={id}>{ECG.agentNames[id] ?? id}</option>
      ))}
    </select>
  );
}

function BrandLogo({ className }: { className: string }) {
  if (ECG.logoUrl) {
    return <img src={ECG.logoUrl} alt="" className={`${className} object-contain`} style={{ borderRadius: 'var(--radius-sm)' }} />;
  }
  return (
    <div className={`${className} flex items-center justify-center`} style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-sm)' }}>
      <Zap className="w-1/2 h-1/2 text-white" />
    </div>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  if (ECG.layout === 'topnav') return <TopNav>{children}</TopNav>;
  if (ECG.layout === 'minimal') return <Minimal>{children}</Minimal>;
  return <Sidebar pathname={pathname}>{children}</Sidebar>;
}

// Section labels for the sidebar. Items keep NAV's order; a label renders
// above the first item of each group that actually has items.
const NAV_GROUPS: Record<string, string> = {
  dashboard: 'Overview', chat: 'Overview',
  agents: 'Content', schedulers: 'Content', posts: 'Content',
  connectors: 'System', runs: 'System', knowledge: 'System', settings: 'System',
};

const SIDEBAR_COLLAPSE_KEY = 'ecg_sidebar_collapsed';

function Sidebar({ children, pathname }: { children: ReactNode; pathname: string }) {
  const pendingCount = usePendingCount();
  // No saved preference yet -> default to the icon-only rail below the
  // mobile floor (768px) instead of squeezing the full 15rem sidebar into a
  // narrow viewport. A saved preference always wins once the user has toggled it.
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (saved !== null) return saved === '1';
    return typeof window !== 'undefined' && window.innerWidth < 768;
  });
  let lastGroup = '';

  function toggleCollapsed() {
    setCollapsed(prev => {
      localStorage.setItem(SIDEBAR_COLLAPSE_KEY, prev ? '0' : '1');
      return !prev;
    });
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <aside className="flex flex-col border-r shrink-0 transition-[width] duration-150"
        style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)', width: collapsed ? '4.25rem' : '15rem' }}>
        <div className="px-4 py-5 border-b flex items-center gap-2.5" style={{ borderColor: 'var(--border)' }}>
          <BrandLogo className="w-8 h-8 shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <p style={{ fontSize: 'var(--text-tiny)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', lineHeight: 1, color: 'var(--accent)' }}>eCG</p>
              <p className="truncate mt-1" style={{ fontSize: 'var(--text-small)', color: 'var(--sidebar-text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</p>
            </div>
          )}
        </div>
        {!collapsed && ECG.agentIds.length > 1 && (
          <div className="px-4 pt-3">
            <AgentSwitcher />
          </div>
        )}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto overflow-x-hidden">
          {NAV.map(({ id, label, path, icon }) => {
            const Icon = ALL_ICONS[icon] ?? Zap;
            const isActive = path === '/' ? pathname === '/' : pathname.startsWith(path);
            const group = NAV_GROUPS[id] ?? '';
            const showLabel = !collapsed && group !== lastGroup;
            if (group !== lastGroup) lastGroup = group;
            const showBadge = id === 'posts' && pendingCount > 0;
            return (
              <div key={path}>
                {showLabel && (
                  <p className="px-3 pt-3 pb-1" style={{ fontSize: 'var(--text-tiny)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', color: 'var(--sidebar-muted)', opacity: 0.7 }}>
                    {group}
                  </p>
                )}
                <NavLink to={path} title={collapsed ? label : undefined}
                  className="relative flex items-center gap-2.5 px-3 py-2 font-medium hover:bg-[var(--sidebar-hover)]"
                  style={{
                    fontSize: 'var(--text-small)',
                    borderRadius: 'var(--radius-sm)',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    transition: `background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out)`,
                    // --sidebar-hover (not --accent-bg): that variable is a light
                    // tint meant for content on the light body surface -- against
                    // a dark sidebar it was nearly invisible. --sidebar-hover is
                    // already shaded correctly relative to the sidebar's own
                    // color, dark or light.
                    ...(isActive
                      ? { background: 'var(--sidebar-hover)', color: 'var(--accent)' }
                      : { color: 'var(--sidebar-muted)' }),
                  }}>
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full" style={{ background: 'var(--accent)' }} />
                  )}
                  <Icon className="w-4 h-4 shrink-0" />
                  {!collapsed && <span className="flex-1">{label}</span>}
                  {showBadge && (
                    <span className="font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center text-white" style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent)' }}>
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--sidebar-hover)]"
            style={{ fontSize: 'var(--text-small)', color: 'var(--sidebar-muted)', justifyContent: collapsed ? 'center' : 'flex-start', transition: `background-color var(--duration-fast) var(--ease-out)` }}>
            {collapsed ? <ChevronsRight className="w-4 h-4 shrink-0" /> : <><ChevronsLeft className="w-4 h-4 shrink-0" /> Collapse</>}
          </button>
        </div>
      </aside>
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function TopNav({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <header className="border-b shrink-0" style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center gap-6">
          <div className="flex items-center gap-2 shrink-0">
            <BrandLogo className="w-7 h-7" />
            <span className="truncate" style={{ fontSize: 'var(--text-small)', color: 'var(--sidebar-text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</span>
          </div>
          {ECG.agentIds.length > 1 && <div className="w-40 shrink-0"><AgentSwitcher compact /></div>}
          <nav className="flex items-center gap-1">
            {NAV.map(({ label, path, icon }) => {
              const Icon = ALL_ICONS[icon] ?? Zap;
              return (
                <NavLink key={path} to={path}
                  className="flex items-center gap-1.5 px-3 py-1.5 font-medium hover:bg-[var(--sidebar-hover)]"
                  style={({ isActive }) => ({
                    fontSize: 'var(--text-tiny)',
                    borderRadius: 'var(--radius-sm)',
                    transition: `background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out)`,
                    ...(isActive
                      ? { background: 'var(--sidebar-hover)', color: 'var(--accent)' }
                      : { color: 'var(--sidebar-muted)' }),
                  })}>
                  <Icon className="w-3.5 h-3.5" />{label}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </header>
      <TopBar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function Minimal({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <div className="max-w-4xl mx-auto w-full px-6 pt-6 pb-4 flex items-center justify-between shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <BrandLogo className="w-6 h-6 shrink-0" />
          <span className="truncate" style={{ fontSize: 'var(--text-small)', color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</span>
          {ECG.agentIds.length > 1 && <div className="w-36 shrink-0"><AgentSwitcher compact /></div>}
        </div>
        <nav className="flex gap-4">
          {NAV.map(({ label, path }) => (
            <NavLink key={path} to={path} className="font-medium hover:opacity-80"
              style={({ isActive }) => ({
                fontSize: 'var(--text-tiny)',
                color: isActive ? 'var(--accent)' : 'var(--muted)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                paddingBottom: 2,
                transition: `color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out)`,
              })}>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <main className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-6 pt-4">{children}</main>
    </div>
  );
}
