import { useEffect, useState } from 'react';
import logo from '@/assets/ecg-logo.png';
import { useNavigate, useLocation, NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { motion, AnimatePresence } from 'framer-motion';
import {
    LayoutDashboard,
    Users,
    Building2,
    FolderKanban,
    Mail,
    CreditCard,
    Shield,
    Settings,
    LogOut,
    Search,
    ChevronLeft,
    ChevronRight,
    Loader2,
    Activity,
    Bell,
    ExternalLink,
    Server,
    Database,
    Zap,
    Bot,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';

// Page imports
import AdminDashboard from './Dashboard';
import AdminUsers from './Users';
import AdminOrganizations from './Organizations';
import AdminProjects from './Projects';
import AdminInvitations from './Invitations';
import AdminSubscriptions from './Subscriptions';
import AdminRolesPermissions from './RolesPermissions';
import AdminUsage from './Usage';
import AdminHosting from './Hosting';
import AdminEcgAgents from './EcgAgents';
import AdminServers from './Servers';
import AdminDatabaseHosting from './DatabaseHosting';
import AdminSystemStatus from './SystemStatus';
import AdminSettings from './Settings';
import AdminTenantDetail from './TenantDetail';
import AdminDemoRequests from './DemoRequests';
import AdminAIMetrics from './AIMetrics';
import { cn } from '@/lib/utils';

interface NavItem {
    title: string;
    path: string;
    icon: React.ElementType;
    badge?: number;
}

export default function AdminApp() {
    const [user, setUser] = useState<User | null>(null);
    const [userRole, setUserRole] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        checkAuth();
    }, []);

    const checkAuth = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                navigate('/admin/login');
                return;
            }

            const { data: roleData } = await supabase
                .from('user_roles')
                .select('role')
                .eq('user_id', session.user.id)
                .in('role', ['super_admin', 'admin'])
                .maybeSingle();

            if (!roleData) {
                navigate('/admin/login');
                return;
            }

            setUser(session.user);
            setUserRole(roleData.role);
            setLoading(false);
        } catch {
            navigate('/admin/login');
        }
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        navigate('/admin/login');
    };

    const navGroups = [
        {
            label: null,
            items: [
                { title: 'Overview', path: '/admin/dashboard', icon: LayoutDashboard },
            ],
        },
        {
            label: 'Users & Orgs',
            items: [
                { title: 'Users', path: '/admin/users', icon: Users },
                { title: 'Organizations', path: '/admin/organizations', icon: Building2 },
                { title: 'Projects', path: '/admin/projects', icon: FolderKanban },
                { title: 'Invitations', path: '/admin/invitations', icon: Mail },
                { title: 'Demo Requests', path: '/admin/demo-requests', icon: Mail },
            ],
        },
        {
            label: 'Billing & Access',
            items: [
                { title: 'Billing & Tiers', path: '/admin/subscriptions', icon: CreditCard },
                { title: 'Access Control', path: '/admin/roles', icon: Shield },
            ],
        },
        {
            label: 'Analytics',
            items: [
                { title: 'Usage Analytics', path: '/admin/usage', icon: Activity },
                { title: 'AI Cost Metrics', path: '/admin/ai-metrics', icon: Zap },
            ],
        },
        {
            label: 'eCG Agents',
            items: [
                { title: 'Agent Dashboards', path: '/admin/ecg-agents', icon: Bot },
            ],
        },
        {
            label: 'Infrastructure',
            items: [
                { title: 'Hosting & Domains', path: '/admin/hosting', icon: Server },
                { title: 'ECG CLAUDE DBs', path: '/admin/database-hosting', icon: Database },
                { title: 'System Status', path: '/admin/system-status', icon: Settings },
                { title: 'LLM Providers', path: '/admin/llm-settings', icon: Zap },
            ],
        },
    ];

    const navItems: NavItem[] = navGroups.flatMap(g => g.items);

    const getPageTitle = () => {
        if (location.pathname.includes('llm-settings') || location.pathname.endsWith('/settings')) return 'LLM Providers';
        if (location.pathname.includes('system-status')) return 'System Status';
        const current = navItems.find(item => location.pathname.startsWith(item.path));
        return current?.title || 'Administrative Hub';
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center p-4 bg-[#07080a]">
                <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 rounded-full border-2 border-purple-500/60 border-t-transparent animate-spin" />
                    <span className="text-[11px] text-white/25 tracking-widest uppercase font-medium">Loading</span>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex selection:bg-primary/30 selection:text-white" style={{ background: '#07080a' }}>
            {/* ═══════════════════ SIDEBAR ═══════════════════ */}
            <aside
                className={cn(
                    "fixed left-0 top-0 h-screen z-50 flex flex-col transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] border-r overflow-hidden",
                    sidebarCollapsed ? 'w-[72px]' : 'w-[280px]'
                )}
                style={{
                    background: 'rgba(10,12,18,0.7)',
                    borderColor: 'rgba(255,255,255,0.04)',
                    backdropFilter: 'blur(32px) saturate(180%)',
                }}
            >
                {/* Logo Area */}
                <div className="h-20 flex items-center px-5 relative overflow-hidden">
                    <div className="flex items-center gap-3 relative z-10 w-full">
                        <div className="h-10 w-10 flex-shrink-0  flex items-center justify-center group-hover:scale-110 transition-transform">
                            <img src={logo} alt="E" className="h-6 w-auto object-contain" />
                        </div>
                        <AnimatePresence mode="wait">
                            {!sidebarCollapsed && (
                                <motion.div
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -10 }}
                                    className="flex flex-col min-w-0"
                                >
                                    <span className="text-sm font-bold text-white tracking-widest uppercase leading-none">eCOMGear</span>
                                    <span className="text-[10px] text-purple-400 font-bold tracking-tighter uppercase mt-1">Platform Admin</span>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>

                {/* Primary Navigation */}
                <div className="flex-1 py-4 px-3 overflow-y-auto custom-scrollbar scrollbar-hide space-y-4">
                    {navGroups.map((group, gi) => (
                        <div key={gi}>
                            {group.label && !sidebarCollapsed && (
                                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/20 px-3 mb-1.5">{group.label}</p>
                            )}
                            {group.label && sidebarCollapsed && gi > 0 && (
                                <div className="h-px bg-white/[0.04] mx-2 mb-2" />
                            )}
                            <div className="space-y-0.5">
                                {group.items.map((item) => (
                                    <NavLink
                                        key={item.path}
                                        to={item.path}
                                        className={({ isActive }) => cn(
                                            "group relative flex items-center h-10 rounded-xl text-sm transition-all duration-200 px-2.5",
                                            isActive
                                                ? "text-white bg-white/[0.05] border border-white/[0.08]"
                                                : "text-gray-400 hover:text-white hover:bg-white/[0.03] border border-transparent"
                                        )}
                                    >
                                        {({ isActive }) => (
                                            <>
                                                {isActive && (
                                                    <motion.div
                                                        layoutId="nav-glow"
                                                        className="absolute inset-0 bg-primary/10 rounded-xl"
                                                    />
                                                )}
                                                <div className={cn(
                                                    "h-7 w-7 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200",
                                                    isActive ? "bg-purple-500/20 text-purple-400" : "text-gray-500 group-hover:text-gray-300"
                                                )}>
                                                    <item.icon size={15} strokeWidth={isActive ? 2.5 : 2} />
                                                </div>
                                                <AnimatePresence mode="wait">
                                                    {!sidebarCollapsed && (
                                                        <motion.span
                                                            initial={{ opacity: 0, x: -5 }}
                                                            animate={{ opacity: 1, x: 0 }}
                                                            exit={{ opacity: 0, x: -5 }}
                                                            className="ml-2.5 text-[13px] font-medium tracking-tight truncate flex-1"
                                                        >
                                                            {item.title}
                                                        </motion.span>
                                                    )}
                                                </AnimatePresence>
                                                {!sidebarCollapsed && isActive && (
                                                    <div className="absolute right-3 w-1 h-3 rounded-full bg-purple-500" />
                                                )}
                                            </>
                                        )}
                                    </NavLink>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Account Actions */}
                <div className="p-4 mt-auto border-t border-white/[0.04] bg-white/[0.01]">
                   

                    <div className="flex flex-col gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                            className="h-10 justify-start px-3 text-gray-500 hover:text-white hover:bg-white/5 rounded-xl border border-transparent hover:border-white/5"
                        >
                            {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
                            {!sidebarCollapsed && <span className="ml-3 font-medium text-xs"></span>}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleLogout}
                            className="h-10 justify-start px-3 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl border border-transparent hover:border-rose-500/10"
                        >
                            <LogOut size={18} />
                            {!sidebarCollapsed && <span className="ml-3 font-medium text-xs">Logout</span>}
                        </Button>
                    </div>
                </div>
            </aside>

            {/* ═══════════════════ MAIN VIEWPORT ═══════════════════ */}
            <div className={cn(
                "flex-1 flex flex-col transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] relative",
                sidebarCollapsed ? 'ml-[72px]' : 'ml-[280px]'
            )}>
                {/* Global Header */}
                <header
                    className="h-20 flex items-center justify-between px-8 border-b sticky top-0 z-40"
                    style={{
                        background: 'rgba(7,8,10,0.6)',
                        borderColor: 'rgba(255,255,255,0.04)',
                        backdropFilter: 'blur(24px) saturate(150%)',
                    }}
                >
                    <div className="flex flex-col">
                        <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                            {getPageTitle()}
                            <div className="h-1 w-1 rounded-full bg-white/20" />
                        </h1>
                    </div>

                    <div className="flex items-center gap-6">
                        {/* Search Focus */}
                        <div className="relative group hidden lg:block">
                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-gray-500 group-focus-within:text-purple-400 transition-colors" />
                            <Input
                                placeholder="Search..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="h-11 w-80 pl-11 rounded-xl bg-white/[0.03] border-white/10 text-xs text-white placeholder:text-gray-600 focus:border-purple-500/40 focus:bg-white/[0.05] transition-all shadow-inner"
                            />
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-white/10 text-[9px] text-gray-600 font-bold">
                                ⌘K
                            </div>
                        </div>

                        <div className="flex items-center gap-2 h-10 px-1 rounded-xl bg-white/[0.03] border border-white/10">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-white rounded-lg">
                                <Bell size={16} />
                            </Button>
                            <div className="w-px h-4 bg-white/10 mx-1" />
                            <Button
                                variant="ghost" size="sm"
                                className="h-8 px-3 text-[10px] font-bold uppercase tracking-wider text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 rounded-lg flex items-center gap-2"
                                onClick={() => window.open('/', '_blank')}
                            >
                                <ExternalLink size={12} />
                                Preview Site
                            </Button>
                        </div>
                    </div>
                </header>

                {/* Content Reservoir */}
                <main className="flex-1 p-8 overflow-x-hidden relative">
                    <div className="relative z-10 mx-auto w-full max-w-[1600px]">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={location.pathname}
                                initial={{ opacity: 0, y: 15 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                            >
                                <Routes>
                                    <Route index element={<Navigate to="/admin/dashboard" replace />} />
                                    <Route path="dashboard" element={<AdminDashboard />} />
                                    <Route path="users" element={<AdminUsers />} />
                                    <Route path="organizations" element={<AdminOrganizations />} />
                                    <Route path="projects" element={<AdminProjects />} />
                                    <Route path="invitations" element={<AdminInvitations />} />
                                    <Route path="subscriptions" element={<AdminSubscriptions />} />
                                    <Route path="demo-requests" element={<AdminDemoRequests />} />
                                    <Route path="roles" element={<AdminRolesPermissions />} />
                                    <Route path="usage" element={<AdminUsage />} />
                                    <Route path="ai-metrics" element={<AdminAIMetrics />} />
                                    <Route path="hosting" element={<AdminHosting />} />
                                    <Route path="ecg-agents" element={<AdminEcgAgents />} />
                                    <Route path="database-hosting" element={<AdminDatabaseHosting />} />
                                    <Route path="servers" element={<AdminServers />} />
                                    <Route path="tenant/:projectId" element={<AdminTenantDetail />} />
                                    <Route path="system-status" element={<AdminSystemStatus />} />
                                    <Route path="llm-settings" element={<AdminSettings />} />
                                    <Route path="settings" element={<Navigate to="/admin/llm-settings" replace />} />
                                </Routes>
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Footer Branding */}
                    <footer className="mt-20 py-8 border-t border-white/[0.03] flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-4 text-gray-600 font-bold uppercase tracking-[0.2em]">
                            <span>© 2026 eCOMGear Tech</span>
                            <div className="h-1 w-1 rounded-full bg-white/20" />

                        </div>

                    </footer>
                </main>
            </div>
        </div>
    );
}
