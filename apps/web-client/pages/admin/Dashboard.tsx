import BrandLoader from '@/components/BrandLoader';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import {
  Building2,
  FolderKanban,
  Users,
  Activity,
  TrendingUp,
  ArrowUpRight,
  Plus,
  Mail,
  Clock,
} from 'lucide-react';

interface Trends {
  totalUsers: string;
  totalOrgs: string;
  totalProjects: string;
  activeProjects: string;
}

function calcTrend(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100%' : '0%';
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    totalOrgs: 0,
    totalProjects: 0,
    totalUsers: 0,
    activeProjects: 0,
  });
  const [trends, setTrends] = useState<Trends>({
    totalUsers: '…',
    totalOrgs: '…',
    totalProjects: '…',
    activeProjects: '…',
  });
  const [recentActivity, setRecentActivity] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    loadStats();
    loadRecentActivity();
  }, []);

  const loadStats = async () => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

      const [
        orgsRes, projectsRes, usersRes, activeProjectsRes,
        orgsThisRes, projectsThisRes, usersThisRes, activeThisRes,
        orgsLastRes, projectsLastRes, usersLastRes, activeLastRes,
      ] = await Promise.all([
        // All-time totals (for the stat cards)
        supabase.from('organizations').select('id', { count: 'exact', head: true }),
        supabase.from('projects').select('id', { count: 'exact', head: true }).neq('status', 'deleted'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        // New this month
        supabase.from('organizations').select('id', { count: 'exact', head: true }).gte('created_at', startOfMonth),
        supabase.from('projects').select('id', { count: 'exact', head: true }).neq('status', 'deleted').gte('created_at', startOfMonth),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', startOfMonth),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'active').gte('created_at', startOfMonth),
        // New last month (for trend comparison)
        supabase.from('organizations').select('id', { count: 'exact', head: true }).gte('created_at', startOfLastMonth).lte('created_at', endOfLastMonth),
        supabase.from('projects').select('id', { count: 'exact', head: true }).neq('status', 'deleted').gte('created_at', startOfLastMonth).lte('created_at', endOfLastMonth),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', startOfLastMonth).lte('created_at', endOfLastMonth),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'active').gte('created_at', startOfLastMonth).lte('created_at', endOfLastMonth),
      ]);

      const current = {
        totalOrgs: orgsRes.count || 0,
        totalProjects: projectsRes.count || 0,
        totalUsers: usersRes.count || 0,
        activeProjects: activeProjectsRes.count || 0,
      };
      // Trends compare "new this month" vs "new last month"
      const thisMonth = {
        totalOrgs: orgsThisRes.count || 0,
        totalProjects: projectsThisRes.count || 0,
        totalUsers: usersThisRes.count || 0,
        activeProjects: activeThisRes.count || 0,
      };
      const prev = {
        totalOrgs: orgsLastRes.count || 0,
        totalProjects: projectsLastRes.count || 0,
        totalUsers: usersLastRes.count || 0,
        activeProjects: activeLastRes.count || 0,
      };

      setStats(current);
      setTrends({
        totalUsers: calcTrend(thisMonth.totalUsers, prev.totalUsers),
        totalOrgs: calcTrend(thisMonth.totalOrgs, prev.totalOrgs),
        totalProjects: calcTrend(thisMonth.totalProjects, prev.totalProjects),
        activeProjects: calcTrend(thisMonth.activeProjects, prev.activeProjects),
      });
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadRecentActivity = async () => {
    try {
      const { data, error } = await supabase
        .from('usage_tracking')
        .select('id, action, created_at, user_id')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;

      const userIds = Array.from(new Set((data || []).map((item: any) => item.user_id).filter(Boolean)));
      const { data: profiles } = userIds.length
        ? await supabase.from('profiles').select('id, email').in('id', userIds)
        : { data: [] as any[] };

      const profileMap = new Map((profiles || []).map((profile: any) => [profile.id, profile.email]));
      const enriched = (data || []).map((item: any) => ({
        ...item,
        profiles: { email: profileMap.get(item.user_id) || 'Unknown' },
      }));

      setRecentActivity(enriched);
    } catch (e) {
      console.error('Failed to load activity:', e);
    }
  };

  const statCards = [
    {
      title: 'Total Users',
      value: stats.totalUsers,
      icon: Users,
      iconColor: 'text-primary',
      borderColor: 'border-primary/20',
      trend: trends.totalUsers,
      path: '/admin/users',
    },
    {
      title: 'Organizations',
      value: stats.totalOrgs,
      icon: Building2,
      iconColor: 'text-primary',
      borderColor: 'border-primary/20',
      trend: trends.totalOrgs,
      path: '/admin/organizations',
    },
    {
      title: 'Total Projects',
      value: stats.totalProjects,
      icon: FolderKanban,
      iconColor: 'text-primary',
      borderColor: 'border-primary/20',
      trend: trends.totalProjects,
      path: '/admin/projects',
    },
    {
      title: 'Active Projects',
      value: stats.activeProjects,
      icon: Activity,
      iconColor: 'text-primary',
      borderColor: 'border-primary/20',
      trend: trends.activeProjects,
      path: '/admin/projects',
    },
  ];

  const quickActions = [
    { label: 'Invite User', icon: Mail, path: '/admin/invitations', color: 'text-muted-foreground' },
    { label: 'New Organization', icon: Plus, path: '/admin/organizations', color: 'text-muted-foreground' },
    { label: 'System Status', icon: TrendingUp, path: '/admin/system-status', color: 'text-emerald-400' },
    { label: 'View Usage', icon: TrendingUp, path: '/admin/usage', color: 'text-amber-400' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <BrandLoader variant="compass" size={100} label="Loading dashboard" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div
            key={stat.title}
            onClick={() => navigate(stat.path)}
            role="button"
            tabIndex={0}
            className={`relative overflow-hidden rounded-none border ${stat.borderColor} p-5 transition-all duration-150 hover:border-white/20 cursor-pointer`}
            style={{ background: 'rgba(255,255,255,0.02)' }}
          >
            <div className="relative z-10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.title}</span>
                <stat.icon className={`h-4 w-4 ${stat.iconColor}`} />
              </div>
              <div className="flex items-end gap-3">
                <span className="text-3xl font-bold text-white">{stat.value.toLocaleString()}</span>
                <span className={`flex items-center gap-0.5 text-xs font-medium mb-1 ${stat.trend.startsWith('-') ? 'text-red-400' : 'text-emerald-400'}`}>
                  <ArrowUpRight className={`h-3 w-3 ${stat.trend.startsWith('-') ? 'rotate-180' : ''}`} />
                  {stat.trend}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Recent Activity ── */}
        <div
          className="lg:col-span-2 rounded-none border p-5"
          style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Recent Activity
            </h3>
            <button
              onClick={() => navigate('/admin/usage')}
              className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
            >
              View all →
            </button>
          </div>
          <div className="space-y-3">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
            ) : (
              recentActivity.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-2.5 px-3 rounded-none hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                      <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-white">
                        {item.profiles?.email || 'Unknown user'}
                      </p>
                      <p className="text-xs text-muted-foreground">{item.action || 'activity'}</p>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.created_at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Quick Actions ── */}
        <div
          className="rounded-none border p-5"
          style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}
        >
          <h3 className="text-sm font-semibold text-white mb-4">Quick Actions</h3>
          <div className="space-y-2">
            {quickActions.map((action) => (
              <button
                key={action.label}
                onClick={() => navigate(action.path)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-none text-sm text-foreground/80 hover:text-white hover:bg-white/5 transition-all duration-200 group"
              >
                <div className="h-8 w-8 rounded-none bg-white/5 group-hover:bg-white/10 flex items-center justify-center transition-colors">
                  <action.icon className={`h-4 w-4 ${action.color}`} />
                </div>
                <span className="font-medium">{action.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
