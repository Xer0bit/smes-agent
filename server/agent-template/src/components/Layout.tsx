import { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings, LucideIcon } from 'lucide-react';
import { ECG } from '../ecg-config';

const ALL_ICONS: Record<string, LucideIcon> = {
  Zap, Calendar, FileText, Plug, History, BookOpen, MessageSquare, Settings,
};

const ALL_NAV = [
  { id: 'chat',       label: 'Assistant',     path: '/',           icon: 'MessageSquare', always: true },
  { id: 'agents',     label: 'Agents',        path: '/agents',     icon: 'Zap' },
  { id: 'schedulers', label: 'Schedulers',    path: '/schedulers', icon: 'Calendar' },
  { id: 'posts',      label: 'Planned Posts', path: '/posts',      icon: 'FileText' },
  { id: 'connectors', label: 'Connectors',    path: '/connectors', icon: 'Plug' },
  { id: 'runs',       label: 'Run History',   path: '/runs',       icon: 'History' },
  { id: 'knowledge',  label: 'Knowledge',     path: '/knowledge',  icon: 'BookOpen' },
  { id: 'settings',   label: 'Settings',      path: '/settings',   icon: 'Settings', always: true },
];

// Order follows ECG.modules (set by drag-and-drop reordering in Dashboard
// Creator), not ALL_NAV's fixed declaration order — the always-shown
// Assistant tab stays pinned first regardless of module order.
const NAV = [
  ALL_NAV.find(n => n.always)!,
  ...ECG.modules.map(id => ALL_NAV.find(n => n.id === id)).filter((n): n is typeof ALL_NAV[number] => Boolean(n)),
];

function BrandLogo({ className }: { className: string }) {
  if (ECG.logoUrl) {
    return <img src={ECG.logoUrl} alt="" className={`${className} object-contain rounded-lg`} />;
  }
  return (
    <div className={`${className} rounded-lg flex items-center justify-center`} style={{ background: 'var(--accent)' }}>
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

function Sidebar({ children, pathname }: { children: ReactNode; pathname: string }) {
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>
      <aside className="w-56 flex flex-col border-r shrink-0"
        style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2.5">
            <BrandLogo className="w-8 h-8" />
            <div>
              <p className="text-xs font-bold uppercase tracking-widest leading-none" style={{ color: 'var(--accent)' }}>eCG</p>
              <p className="text-sm font-semibold truncate max-w-[120px]" style={{ color: 'var(--sidebar-text)' }}>{ECG.appName}</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ label, path, icon }) => {
            const Icon = ALL_ICONS[icon] ?? Zap;
            const isActive = path === '/' ? pathname === '/' : pathname.startsWith(path);
            return (
              <NavLink key={path} to={path}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                style={isActive
                  ? { background: 'var(--accent-bg, rgba(79,70,229,0.1))', color: 'var(--accent)' }
                  : { color: 'var(--sidebar-muted)' }}>
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </NavLink>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
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
      <header className="border-b shrink-0" style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6">
          <div className="flex items-center gap-2 shrink-0">
            <BrandLogo className="w-7 h-7" />
            <span className="text-sm font-bold" style={{ color: 'var(--sidebar-text)' }}>{ECG.appName}</span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map(({ label, path, icon }) => {
              const Icon = ALL_ICONS[icon] ?? Zap;
              return (
                <NavLink key={path} to={path}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={({ isActive }) => isActive
                    ? { background: 'var(--accent-bg, rgba(79,70,229,0.1))', color: 'var(--accent)' }
                    : { color: 'var(--sidebar-muted)' }}>
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
      <div className="max-w-4xl mx-auto w-full px-6 pt-6 pb-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <BrandLogo className="w-6 h-6" />
          <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>{ECG.appName}</span>
        </div>
        <nav className="flex gap-3">
          {NAV.map(({ label, path }) => (
            <NavLink key={path} to={path} className="text-xs font-medium transition-colors"
              style={({ isActive }) => ({ color: isActive ? 'var(--accent)' : 'var(--muted)', textDecoration: isActive ? 'underline' : 'none' })}>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <main className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-6">{children}</main>
    </div>
  );
}
