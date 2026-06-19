import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Input } from '@/components/ui/input';
import { Search, Activity, Users, TrendingUp, Clock } from 'lucide-react';
import { toast } from 'sonner';

interface UsageRecord {
  id: string;
  organization_id: string;
  project_id: string;
  user_id: string;
  action: string;
  created_at: string;
  org_name: string | null;
  project_name: string | null;
  user_email: string | null;
}

export default function Usage() {
  const [usageData, setUsageData] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => { loadUsageData(); }, []);

  const loadUsageData = async () => {
    try {
      const { data, error } = await supabase
        .from('usage_tracking')
        .select('id, project_id, user_id, action, created_at')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      // Fetch related names — org_id is derived via project.organization_id
      const projectIds = [...new Set((data || []).map((r: any) => r.project_id).filter(Boolean))];
      const userIds = [...new Set((data || []).map((r: any) => r.user_id).filter(Boolean))];

      const [projsRes, profilesRes] = await Promise.all([
        projectIds.length ? supabase.from('projects').select('id, name, organization_id').in('id', projectIds) : { data: [] },
        userIds.length ? supabase.from('profiles').select('id, email').in('id', userIds) : { data: [] },
      ]);

      // Derive org IDs from projects
      const projList = projsRes.data || [];
      const orgIds = [...new Set(projList.map((p: any) => p.organization_id).filter(Boolean))];
      const orgsRes = orgIds.length ? await supabase.from('organizations').select('id, name').in('id', orgIds) : { data: [] };

      const orgMap = new Map((orgsRes.data || []).map((o: any) => [o.id, o.name]));
      const projMap = new Map(projList.map((p: any) => [p.id, p.name]));
      const projOrgMap = new Map(projList.map((p: any) => [p.id, p.organization_id]));
      const profileMap = new Map((profilesRes.data || []).map((p: any) => [p.id, p.email]));

      const formatted = (data || []).map((r: any) => ({
        id: r.id,
        organization_id: projOrgMap.get(r.project_id) || null,
        project_id: r.project_id,
        user_id: r.user_id,
        action: r.action,
        created_at: r.created_at,
        org_name: orgMap.get(projOrgMap.get(r.project_id) || '') || null,
        project_name: projMap.get(r.project_id) || null,
        user_email: profileMap.get(r.user_id) || null,
      }));
      setUsageData(formatted);
    } catch (error) {
      console.error('Failed to load usage data:', error);
      toast.error('Failed to load usage data');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const filtered = searchQuery.trim()
    ? usageData.filter(r =>
      (r.user_email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.action || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.org_name || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
    : usageData;

  const uniqueUsers = new Set(usageData.map(r => r.user_id)).size;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: 'Total Events', value: usageData.length, icon: Activity, color: 'text-purple-400', bg: 'bg-purple-500/10' },
          { label: 'Unique Users', value: uniqueUsers, icon: Users, color: 'text-blue-400', bg: 'bg-blue-500/10' },
          { label: 'Latest', value: usageData[0] ? formatDate(usageData[0].created_at) : 'N/A', icon: Clock, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border p-4 flex items-center gap-4" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
            <div className={`h-10 w-10 rounded-lg ${s.bg} flex items-center justify-center`}>
              <s.icon className={`h-5 w-5 ${s.color}`} />
            </div>
            <div>
              <p className="text-xs text-gray-400">{s.label}</p>
              <p className="text-lg font-bold text-white">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
        <Input
          placeholder="Search by user, action, or org..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-9 w-72 pl-9 text-xs bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-purple-500/50"
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">User</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Action</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Organization</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Project</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr key={record.id} className="hover:bg-white/[0.03] transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td className="px-5 py-3 text-sm text-white">{record.user_email || '—'}</td>
                <td className="px-5 py-3">
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.1)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.2)' }}>
                    {record.action || '—'}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-gray-400">{record.org_name || '—'}</td>
                <td className="px-5 py-3 text-xs text-gray-400">{record.project_name || '—'}</td>
                <td className="px-5 py-3 text-xs text-gray-500">{formatDate(record.created_at)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-center py-12 text-sm text-gray-500">No usage data found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
