import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings, LucideIcon } from 'lucide-react';
import { ECG } from '../ecg-config';
import { ecgApi } from '../lib/ecgClient';

// Live count of posts awaiting review, shown as a badge on Planned Posts.
// One fetch per mount  cheap, and the badge is advisory, not real-time.
function usePendingCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!ECG.modules.includes('posts')) return;
    ecgApi.posts.list()
      .then((d: any) => {
        const posts = Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? []);
        setCount(posts.filter((p: any) => p.status === 'pending').length);
      })
      .catch(() => {});
  }, []);
  return count;
}

const ALL_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings,
};

const ALL_NAV = [
  { id: 'dashboard',  label: 'Home',          path: '/',           icon: 'LayoutDashboard', always: true },
  { id: 'chat',       label: 'Assistant',     path: '/assistant',  icon: 'MessageSquare',   always: true },
  { id: 'agents',     label: 'Agents',        path: '/agents',     icon: 'Zap' },
  { id: 'schedulers', label: 'Schedulers',    path: '/schedulers', icon: 'Calendar' },
  { id: 'posts',      label: 'Planned Posts', path: '/posts',      icon: 'FileText' },
  { id: 'connectors', label: 'Connectors',    path: '/connectors', icon: 'Plug' },
  { id: 'runs',       label: 'Run History',   path: '/runs',       icon: 'History' },
  { id: 'knowledge',  label: 'Knowledge',     path: '/knowledge',  icon: 'BookOpen' },
  { id: 'settings',   label: 'Settings',      path: '/settings',   icon: 'Settings', always: true },
];

// Order follows ECG.modules (set by drag-and-drop reordering in Dashboard
// Creator), not ALL_NAV's fixed declaration order   the always-shown tabs
// (Home, Assistant first; Settings last) stay pinned regardless of module
// order. Previously this used ALL_NAV.find(n => n.always), which only ever
// returns the FIRST always-item   Settings silently never made it into the
// sidebar at all. filter() picks up every always-item instead.
const NAV = [
  ...ALL_NAV.filter(n => n.always && n.id !== 'settings'),
  ...ECG.modules.map(id => ALL_NAV.find(n => n.id === id)).filter((n): n is typeof ALL_NAV[number] => Boolean(n)),
  ALL_NAV.find(n => n.id === 'settings')!,
];

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

function Sidebar({ children, pathname }: { children: ReactNode; pathname: string }) {
  const pendingCount = usePendingCount();
  let lastGroup = '';
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <aside className="w-60 flex flex-col border-r shrink-0"
        style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2.5">
            <BrandLogo className="w-8 h-8" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest leading-none" style={{ color: 'var(--accent)' }}>eCG</p>
              <p className="text-sm truncate mt-1" style={{ color: 'var(--sidebar-text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ id, label, path, icon }) => {
            const Icon = ALL_ICONS[icon] ?? Zap;
            const isActive = path === '/' ? pathname === '/' : pathname.startsWith(path);
            const group = NAV_GROUPS[id] ?? '';
            const showLabel = group !== lastGroup;
            if (showLabel) lastGroup = group;
            const showBadge = id === 'posts' && pendingCount > 0;
            return (
              <div key={path}>
                {showLabel && (
                  <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--sidebar-muted)', opacity: 0.7 }}>
                    {group}
                  </p>
                )}
                <NavLink to={path}
                  className="relative flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--sidebar-hover)]"
                  style={{
                    borderRadius: 'var(--radius-sm)',
                    ...(isActive
                      ? { background: 'var(--accent-bg)', color: 'var(--accent)' }
                      : { color: 'var(--sidebar-muted)' }),
                  }}>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full" style={{ background: 'var(--accent)' }} />
                  )}
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {showBadge && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center text-white" style={{ background: 'var(--accent)' }}>
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="px-4 py-3.5 border-t" style={{ borderColor: 'var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--sidebar-muted)' }}>Powered by eComGear</p>
        </div>
      </aside>
      <div className="flex-1 flex flex-col overflow-hidden">
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
            <span className="text-sm truncate" style={{ color: 'var(--sidebar-text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map(({ label, path, icon }) => {
              const Icon = ALL_ICONS[icon] ?? Zap;
              return (
                <NavLink key={path} to={path}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--sidebar-hover)]"
                  style={({ isActive }) => ({
                    borderRadius: 'var(--radius-sm)',
                    ...(isActive
                      ? { background: 'var(--accent-bg)', color: 'var(--accent)' }
                      : { color: 'var(--sidebar-muted)' }),
                  })}>
                  <Icon className="w-3.5 h-3.5" />{label}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function Minimal({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <div className="max-w-4xl mx-auto w-full px-6 pt-6 pb-4 flex items-center justify-between shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <BrandLogo className="w-6 h-6" />
          <span className="text-sm truncate" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</span>
        </div>
        <nav className="flex gap-4">
          {NAV.map(({ label, path }) => (
            <NavLink key={path} to={path} className="text-xs font-medium transition-colors hover:opacity-80"
              style={({ isActive }) => ({
                color: isActive ? 'var(--accent)' : 'var(--muted)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                paddingBottom: 2,
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
