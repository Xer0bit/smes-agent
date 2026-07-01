// Orchestrates seeding of the pre-built eCG dashboard template into an eComGear project.
// Page component generators live in ecg-template-pages.ts to stay under the 500-line limit.

import path from 'node:path';
import fs from 'node:fs';
import {
  agentsPage, schedulersPage, postsPage,
  connectorsPage, runsPage, knowledgePage, aiAssistantPage, emptyPage,
  dashboardChatTsx,
} from './ecg-template-pages.js';

export interface TemplateOptions {
  orgName: string;
  modules: string[];
  agentIds: string[];
  config: Record<string, unknown>;
}

// Resolved design config with safe defaults
interface DesignCfg {
  appName: string;
  layout: 'sidebar' | 'topnav' | 'minimal';
  theme: string;
  accentColor: string;
  sidebarColor: string;
  bodyColor: string;
  showSummaryCards: boolean;
  moduleSettings: Record<string, Record<string, boolean | string>>;
}

const THEME_DEFAULTS: Record<string, Omit<DesignCfg, 'appName' | 'layout' | 'showSummaryCards' | 'moduleSettings'>> = {
  light:  { theme: 'light',  accentColor: '#2563eb', sidebarColor: '#ffffff', bodyColor: '#f8fafc' },
  dark:   { theme: 'dark',   accentColor: '#60a5fa', sidebarColor: '#0f172a', bodyColor: '#020617' },
  ocean:  { theme: 'ocean',  accentColor: '#00b4d8', sidebarColor: '#0f4c75', bodyColor: '#f0f9ff' },
  forest: { theme: 'forest', accentColor: '#22c55e', sidebarColor: '#1a3a2a', bodyColor: '#f0fdf4' },
  sunset: { theme: 'sunset', accentColor: '#f97316', sidebarColor: '#7c2d12', bodyColor: '#fff7ed' },
  slate:  { theme: 'slate',  accentColor: '#8b5cf6', sidebarColor: '#334155', bodyColor: '#f8fafc' },
  custom: { theme: 'custom', accentColor: '#2563eb', sidebarColor: '#1e293b', bodyColor: '#f8fafc' },
};

function resolveDesign(raw: Record<string, unknown>, orgName: string): DesignCfg {
  const themeKey = (raw.theme as string) || 'light';
  const defaults = THEME_DEFAULTS[themeKey] ?? THEME_DEFAULTS.light;
  return {
    appName:         (raw.appName as string) || orgName,
    layout:          (raw.layout as DesignCfg['layout']) || 'sidebar',
    theme:           themeKey,
    accentColor:     (raw.accentColor as string) || defaults.accentColor,
    sidebarColor:    (raw.sidebarColor as string) || defaults.sidebarColor,
    bodyColor:       (raw.bodyColor as string) || defaults.bodyColor,
    showSummaryCards: (raw.showSummaryCards as boolean) !== false,
    moduleSettings:  (raw.moduleSettings as DesignCfg['moduleSettings']) || {},
  };
}

function isDark(hex: string): boolean {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

const ALL_MODULES = ['agents', 'schedulers', 'posts', 'connectors', 'runs', 'knowledge'];

export function seedEcgTemplate(projectDir: string, opts: TemplateOptions): Record<string, string> {
  const mods = opts.modules.length > 0 ? opts.modules : ALL_MODULES;
  const has = (m: string) => mods.includes(m);
  const design = resolveDesign(opts.config, opts.orgName);
  const defaultRoute = mods[0] ?? 'agents';
  const ms = design.moduleSettings;

  const files: Record<string, string> = {
    'index.html':                   indexHtml(design.appName),
    'tailwind.config.js':           tailwindConfig(),
    'postcss.config.js':            postcssConfig(),
    'src/index.css':                indexCss(design),
    'src/main.tsx':                 mainTsx(),
    'src/App.tsx':                  appTsx(mods, defaultRoute, design),
    'src/lib/ecgClient.ts':         ecgClient(),
    'src/components/Layout.tsx':        layoutTsx(mods, design),
    'src/components/StatusBadge.tsx':   statusBadgeTsx(),
    'src/components/SummaryCards.tsx':  summaryCardsTsx(),
    'src/components/DashboardChat.tsx': dashboardChatTsx(),
    'src/pages/AgentsPage.tsx':       has('agents')     ? agentsPage(ms.agents)     : emptyPage('Agents', 'Zap'),
    'src/pages/SchedulersPage.tsx':   has('schedulers') ? schedulersPage()          : emptyPage('Schedulers', 'Calendar'),
    'src/pages/PostsPage.tsx':        has('posts')      ? postsPage(ms.posts)       : emptyPage('Planned Posts', 'FileText'),
    'src/pages/ConnectorsPage.tsx':   has('connectors') ? connectorsPage()          : emptyPage('Connectors', 'Plug'),
    'src/pages/RunsPage.tsx':         has('runs')       ? runsPage(ms.runs)         : emptyPage('Run History', 'History'),
    'src/pages/KnowledgePage.tsx':    has('knowledge')  ? knowledgePage()           : emptyPage('Knowledge', 'BookOpen'),
    'src/pages/AiAssistantPage.tsx':  aiAssistantPage(),
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(projectDir, rel);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    } catch { /* non-fatal in dev */ }
  }

  return files;
}

// ── Config files ──────────────────────────────────────────────────────────────

function indexHtml(appName: string) {
  return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${appName}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
}

function tailwindConfig() {
  return `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],\n  theme: { extend: { fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] } } },\n  plugins: [],\n};\n`;
}

function postcssConfig() {
  return `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`;
}

function indexCss(d: DesignCfg) {
  const sidebarText = isDark(d.sidebarColor) ? '#f1f5f9' : '#1e293b';
  const sidebarMuted = isDark(d.sidebarColor) ? '#94a3b8' : '#64748b';
  const accentBg = isDark(d.accentColor) ? '#1e3a5f' : `${d.accentColor}18`;
  const cardBg = isDark(d.bodyColor) ? '#1e293b' : '#ffffff';
  const border = isDark(d.bodyColor) ? '#334155' : '#e2e8f0';
  const text = isDark(d.bodyColor) ? '#f1f5f9' : '#1e293b';
  const muted = isDark(d.bodyColor) ? '#94a3b8' : '#64748b';

  return `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --accent: ${d.accentColor};\n  --accent-bg: ${accentBg};\n  --sidebar-bg: ${d.sidebarColor};\n  --sidebar-text: ${sidebarText};\n  --sidebar-muted: ${sidebarMuted};\n  --body-bg: ${d.bodyColor};\n  --card-bg: ${cardBg};\n  --border: ${border};\n  --text: ${text};\n  --muted: ${muted};\n}\n\nbody { font-family: Inter, system-ui, sans-serif; background: var(--body-bg); color: var(--text); }\n`;
}

function mainTsx() {
  return `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n`;
}

// ── App.tsx ───────────────────────────────────────────────────────────────────

function appTsx(mods: string[], defaultRoute: string, d: DesignCfg) {
  const imports = [
    `import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';`,
    `import Layout from './components/Layout';`,
    d.showSummaryCards && `import SummaryCards from './components/SummaryCards';`,
    mods.includes('agents')     && `import AgentsPage from './pages/AgentsPage';`,
    mods.includes('schedulers') && `import SchedulersPage from './pages/SchedulersPage';`,
    mods.includes('posts')      && `import PostsPage from './pages/PostsPage';`,
    mods.includes('connectors') && `import ConnectorsPage from './pages/ConnectorsPage';`,
    mods.includes('runs')       && `import RunsPage from './pages/RunsPage';`,
    mods.includes('knowledge')  && `import KnowledgePage from './pages/KnowledgePage';`,
  ].filter(Boolean).join('\n');

  const wrapCards = d.showSummaryCards
    ? (inner: string) => `        <div className="space-y-5"><SummaryCards />${inner}</div>`
    : (inner: string) => inner;

  const routes = [
    `        <Route path="/" element={<Navigate to="/${defaultRoute}" replace />} />`,
    mods.includes('agents')     && `        <Route path="/agents"     element={${wrapCards('<AgentsPage />')}} />`,
    mods.includes('schedulers') && `        <Route path="/schedulers" element={<SchedulersPage />} />`,
    mods.includes('posts')      && `        <Route path="/posts"      element={${wrapCards('<PostsPage />')}} />`,
    mods.includes('connectors') && `        <Route path="/connectors" element={<ConnectorsPage />} />`,
    mods.includes('runs')       && `        <Route path="/runs"       element={<RunsPage />} />`,
    mods.includes('knowledge')  && `        <Route path="/knowledge"  element={<KnowledgePage />} />`,
  ].filter(Boolean).join('\n');

  return `${imports}\n\nexport default function App() {\n  return (\n    <BrowserRouter>\n      <Layout>\n        <Routes>\n${routes}\n        </Routes>\n      </Layout>\n    </BrowserRouter>\n  );\n}\n`;
}

// ── ecgClient.ts ──────────────────────────────────────────────────────────────

function ecgClient() {
  return `const SERVER = (import.meta.env.VITE_ECG_PROXY_URL || '').replace(/\\/$/, '');\nconst PROJECT_ID = import.meta.env.VITE_PROJECT_ID || '';\n\nasync function req(method: string, path: string, body?: unknown) {\n  const sep = path.includes('?') ? '&' : '?';\n  const url = \`\${SERVER}/api/v1/ecg-proxy\${path}\${sep}projectId=\${PROJECT_ID}\`;\n  const res = await fetch(url, { method, credentials: 'include',\n    headers: { 'Content-Type': 'application/json' },\n    body: body !== undefined ? JSON.stringify(body) : undefined });\n  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any).error || \`API error \${res.status}\`); }\n  return res.json();\n}\n\nexport const ecgApi = {\n  agents:     { list: () => req('GET', '/agents') },\n  schedulers: { list: () => req('GET', '/schedulers') },\n  posts: {\n    list:    () => req('GET', '/planned-posts'),\n    approve: (id: string) => req('PATCH', \`/planned-posts/\${id}\`, { status: 'approved' }),\n    reject:  (id: string) => req('PATCH', \`/planned-posts/\${id}\`, { status: 'rejected' }),\n  },\n  connectors: { list: () => req('GET', '/connectors') },\n  runs:       { list: () => req('GET', '/runs') },\n  knowledge:  { list: () => req('GET', '/knowledge') },\n  summary:    { get:  () => req('GET', '/summary') },\n};\n`;
}

// ── SummaryCards (optional) ───────────────────────────────────────────────────

function summaryCardsTsx() {
  return `import { useEffect, useState } from 'react';\nimport { Zap, FileText, History, AlertCircle } from 'lucide-react';\nimport { ecgApi } from '../lib/ecgClient';\n\nexport default function SummaryCards() {\n  const [data, setData] = useState<any>(null);\n  useEffect(() => { ecgApi.summary.get().then(setData).catch(() => null); }, []);\n  if (!data) return null;\n  const cards = [\n    { label: 'Active Agents',   value: data.activeAgents ?? 0,   Icon: Zap,       color: 'text-blue-600' },\n    { label: 'Pending Posts',   value: data.pendingPosts ?? 0,    Icon: FileText,  color: 'text-amber-600' },\n    { label: 'Runs Today',      value: data.runsToday ?? 0,       Icon: History,   color: 'text-green-600' },\n    { label: 'Failed Runs',     value: data.failedRuns ?? 0,      Icon: AlertCircle, color: 'text-red-600' },\n  ];\n  return (\n    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-2">\n      {cards.map(({ label, value, Icon, color }) => (\n        <div key={label} className="rounded-xl border p-4 flex items-center gap-3" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>\n          <Icon className={\`w-5 h-5 shrink-0 \${color}\`} />\n          <div>\n            <p className="text-xl font-bold" style={{ color: 'var(--text)' }}>{value}</p>\n            <p className="text-xs" style={{ color: 'var(--muted)' }}>{label}</p>\n          </div>\n        </div>\n      ))}\n    </div>\n  );\n}\n`;
}

// ── Layout.tsx ────────────────────────────────────────────────────────────────

function layoutTsx(mods: string[], d: DesignCfg) {
  const navItems = [
    mods.includes('agents')     && `  { label: 'Agents',        path: '/agents',     icon: 'Zap' },`,
    mods.includes('schedulers') && `  { label: 'Schedulers',    path: '/schedulers', icon: 'Calendar' },`,
    mods.includes('posts')      && `  { label: 'Planned Posts', path: '/posts',      icon: 'FileText' },`,
    mods.includes('connectors') && `  { label: 'Connectors',    path: '/connectors', icon: 'Plug' },`,
    mods.includes('runs')       && `  { label: 'Run History',   path: '/runs',       icon: 'History' },`,
    mods.includes('knowledge')  && `  { label: 'Knowledge',     path: '/knowledge',  icon: 'BookOpen' },`,
  ].filter(Boolean).join('\n');

  if (d.layout === 'topnav') return topnavLayoutTsx(navItems, d);
  if (d.layout === 'minimal') return minimalLayoutTsx(navItems, d);
  return sidebarLayoutTsx(navItems, d);
}

function sidebarLayoutTsx(navItems: string, d: DesignCfg) {
  return `import { ReactNode } from 'react';\nimport { NavLink, useLocation } from 'react-router-dom';\nimport { Zap, Calendar, FileText, Plug, History, BookOpen, LucideIcon } from 'lucide-react';\nimport DashboardChat from './DashboardChat';\n\nconst ICONS: Record<string, LucideIcon> = { Zap, Calendar, FileText, Plug, History, BookOpen };\nconst NAV = [\n${navItems}\n];\n\nexport default function Layout({ children }: { children: ReactNode }) {\n  const { pathname } = useLocation();\n  const active = NAV.find(n => pathname.startsWith(n.path));\n  const sStyle = { background: 'var(--sidebar-bg)', borderColor: 'var(--border)' };\n  const lActive = { background: 'var(--accent-bg)', color: 'var(--accent)' };\n  const lIdle   = { color: 'var(--sidebar-muted)' };\n\n  return (\n    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--body-bg)' }}>\n      <aside className="w-56 flex flex-col border-r shrink-0" style={sStyle}>\n        <div className="px-4 py-5 border-b" style={{ borderColor: 'var(--border)' }}>\n          <div className="flex items-center gap-2.5">\n            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent)' }}>\n              <Zap className="w-4 h-4 text-white" />\n            </div>\n            <div>\n              <p className="text-xs font-bold uppercase tracking-widest leading-none" style={{ color: 'var(--accent)' }}>eCG</p>\n              <p className="text-sm font-semibold truncate max-w-[120px]" style={{ color: 'var(--sidebar-text)' }}>${d.appName}</p>\n            </div>\n          </div>\n        </div>\n        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">\n          {NAV.map(({ label, path, icon }) => {\n            const Icon = ICONS[icon] ?? Zap;\n            const isActive = pathname.startsWith(path);\n            return (\n              <NavLink key={path} to={path}\n                className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"\n                style={isActive ? lActive : lIdle}>\n                <Icon className="w-4 h-4 shrink-0" />\n                {label}\n              </NavLink>\n            );\n          })}\n        </nav>\n        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>\n          <p className="text-xs" style={{ color: 'var(--sidebar-muted)' }}>Powered by eComGear</p>\n        </div>\n      </aside>\n      <div className="flex-1 overflow-y-auto">\n        <header className="sticky top-0 z-10 border-b px-6 py-3" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>\n          <h1 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{active?.label ?? 'Dashboard'}</h1>\n        </header>\n        <main className="p-6 max-w-5xl mx-auto">{children}</main>\n      </div>\n      <DashboardChat />\n    </div>\n  );\n}\n`;
}

function topnavLayoutTsx(navItems: string, d: DesignCfg) {
  return `import { ReactNode } from 'react';\nimport { NavLink } from 'react-router-dom';\nimport { Zap, Calendar, FileText, Plug, History, BookOpen, LucideIcon } from 'lucide-react';\nimport DashboardChat from './DashboardChat';\n\nconst ICONS: Record<string, LucideIcon> = { Zap, Calendar, FileText, Plug, History, BookOpen };\nconst NAV = [\n${navItems}\n];\n\nexport default function Layout({ children }: { children: ReactNode }) {\n  return (\n    <div className="flex flex-col min-h-screen" style={{ background: 'var(--body-bg)' }}>\n      <header className="border-b" style={{ background: 'var(--sidebar-bg)', borderColor: 'var(--border)' }}>\n        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6">\n          <div className="flex items-center gap-2 shrink-0">\n            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent)' }}>\n              <Zap className="w-3.5 h-3.5 text-white" />\n            </div>\n            <span className="text-sm font-bold" style={{ color: 'var(--sidebar-text)' }}>${d.appName}</span>\n          </div>\n          <nav className="flex items-center gap-1">\n            {NAV.map(({ label, path, icon }) => {\n              const Icon = ICONS[icon] ?? Zap;\n              return (\n                <NavLink key={path} to={path}\n                  className={({ isActive }) => ['flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',\n                    isActive ? '' : '',\n                  ].join(' ')}\n                  style={({ isActive }) => isActive\n                    ? { background: 'var(--accent-bg)', color: 'var(--accent)' }\n                    : { color: 'var(--sidebar-muted)' }}>\n                  <Icon className="w-3.5 h-3.5" />{label}\n                </NavLink>\n              );\n            })}\n          </nav>\n        </div>\n      </header>\n      <main className="flex-1 p-6 max-w-6xl mx-auto w-full">{children}</main>\n      <DashboardChat />\n    </div>\n  );\n}\n`;
}

function minimalLayoutTsx(navItems: string, d: DesignCfg) {
  return `import { ReactNode } from 'react';\nimport { NavLink } from 'react-router-dom';\nimport { Zap, Calendar, FileText, Plug, History, BookOpen, LucideIcon } from 'lucide-react';\nimport DashboardChat from './DashboardChat';\n\nconst ICONS: Record<string, LucideIcon> = { Zap, Calendar, FileText, Plug, History, BookOpen };\nconst NAV = [\n${navItems}\n];\n\nexport default function Layout({ children }: { children: ReactNode }) {\n  return (\n    <div className="min-h-screen" style={{ background: 'var(--body-bg)' }}>\n      <div className="max-w-4xl mx-auto px-6 pt-8 pb-4">\n        <div className="flex items-center justify-between mb-6">\n          <div className="flex items-center gap-2">\n            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: 'var(--accent)' }}>\n              <Zap className="w-3 h-3 text-white" />\n            </div>\n            <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>${d.appName}</span>\n          </div>\n          <nav className="flex gap-3">\n            {NAV.map(({ label, path }) => (\n              <NavLink key={path} to={path}\n                className="text-xs font-medium transition-colors"\n                style={({ isActive }) => ({ color: isActive ? 'var(--accent)' : 'var(--muted)', textDecoration: isActive ? 'underline' : 'none' })}>\n                {label}\n              </NavLink>\n            ))}\n          </nav>\n        </div>\n        {children}\n      </div>\n      <DashboardChat />\n    </div>\n  );\n}\n`;
}

// ── StatusBadge.tsx ───────────────────────────────────────────────────────────

function statusBadgeTsx() {
  return `const MAP: Record<string, string> = {\n  active: 'bg-green-100 text-green-700 border-green-200',\n  approved: 'bg-green-100 text-green-700 border-green-200',\n  succeeded: 'bg-green-100 text-green-700 border-green-200',\n  pending: 'bg-amber-100 text-amber-700 border-amber-200',\n  provisioning: 'bg-amber-100 text-amber-700 border-amber-200',\n  draft: 'bg-slate-100 text-slate-600 border-slate-200',\n  idle: 'bg-slate-100 text-slate-600 border-slate-200',\n  suspended: 'bg-red-100 text-red-700 border-red-200',\n  rejected: 'bg-red-100 text-red-700 border-red-200',\n  failed: 'bg-red-100 text-red-700 border-red-200',\n};\nexport default function StatusBadge({ status }: { status: string }) {\n  const cls = MAP[status?.toLowerCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200';\n  return <span className={\`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border \${cls}\`}>{status}</span>;\n}\n`;
}
