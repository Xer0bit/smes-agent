import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from '@/components/ui/pagination';
import { Search, Pencil, Trash2, Plus, Building2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

const PAGE_SIZE = 20;

interface Organization {
  id: string;
  name: string;
  slug: string;
  seats_total: number;
  status: string;
  plan_tier: string;
  ai_gens_used: number;
  ai_gens_limit: number;
  ai_gens_reset_at: string | null;
  created_at: string;
}

export default function Organizations() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Create/Edit
  const [showCreate, setShowCreate] = useState(false);
  const [editOrg, setEditOrg] = useState<Organization | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formMaxUsers, setFormMaxUsers] = useState('10');
  const [formEcoLimit, setFormEcoLimit] = useState('10');
  const [formEcoUsed, setFormEcoUsed] = useState('0');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => { loadOrganizations(); }, [page, debouncedSearch]);

  const loadOrganizations = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('organizations')
        .select('id, name, slug, seats_total, status, plan_tier, ai_gens_used, ai_gens_limit, ai_gens_reset_at, created_at', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
      }

      const { data, error, count } = await query
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      setOrgs(data || []);
      setTotalCount(count ?? (data || []).length);
    } catch (error) {
      console.error('Failed to load organizations:', error);
      toast.error('Failed to load organizations');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    try {
      const { error } = await supabase.from('organizations').insert([{
        name: formName,
        slug: formSlug || formName.toLowerCase().replace(/\s+/g, '-'),
        seats_total: parseInt(formMaxUsers) || 10,
      }]);
      if (error) throw error;
      toast.success('Organization created');
      setShowCreate(false);
      setFormName(''); setFormSlug(''); setFormMaxUsers('10');
      loadOrganizations();
    } catch (error: any) {
      toast.error(error.message || 'Failed to create organization');
    }
  };

  const handleEdit = (org: Organization) => {
    setEditOrg(org);
    setFormName(org.name);
    setFormSlug(org.slug);
    setFormMaxUsers(String(org.seats_total));
    setFormEcoLimit(String(org.ai_gens_limit ?? 10));
    setFormEcoUsed(String(org.ai_gens_used ?? 0));
  };

  const handleUpdate = async () => {
    if (!editOrg) return;
    try {
      const { error } = await supabase.from('organizations')
        .update({
          name: formName,
          slug: formSlug,
          seats_total: parseInt(formMaxUsers) || 10,
          ai_gens_limit: parseFloat(formEcoLimit) || 10,
          ai_gens_used: parseFloat(formEcoUsed) || 0,
        })
        .eq('id', editOrg.id);
      if (error) throw error;
      toast.success('Organization updated');
      setEditOrg(null);
      loadOrganizations();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update');
    }
  };

  const handleToggleStatus = async (org: Organization) => {
    const newStatus = org.status === 'active' ? 'suspended' : 'active';
    try {
      const { error } = await supabase.from('organizations').update({ status: newStatus }).eq('id', org.id);
      if (error) throw error;
      toast.success(`Organization ${newStatus}`);
      loadOrganizations();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update status');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this organization? This cannot be undone.')) return;
    try {
      const { error } = await supabase.from('organizations').delete().eq('id', id);
      if (error) throw error;
      toast.success('Organization deleted');
      loadOrganizations();
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete');
    }
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const statusBadge = (status: string) => {
    const isActive = status === 'active';
    return (
      <span
        className="text-[11px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{
          background: isActive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: isActive ? '#4ade80' : '#f87171',
          border: `1px solid ${isActive ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-green-400' : 'bg-red-400'}`} />
        {status}
      </span>
    );
  };

  const tierBadge = (tier: string) => {
    const colors: Record<string, string> = {
      free: '#9ca3af', starter: '#60a5fa', professional: '#a78bfa', enterprise: '#fbbf24',
    };
    const color = colors[tier] || '#9ca3af';
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full capitalize"
        style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
        {tier}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
          <Input
            placeholder="Search organizations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-72 pl-9 text-xs bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-purple-500/50"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">{totalCount} organizations</span>
          <Button onClick={() => setShowCreate(true)} className="h-9 bg-purple-600 hover:bg-purple-700 text-white gap-2 text-xs">
            <Plus className="h-3.5 w-3.5" /> New Organization
          </Button>
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Organization</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Plan</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Status</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Eco Usage</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Users</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Created</th>
              <th className="text-right text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id} className="group hover:bg-white/[0.03] transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                      <Building2 className="h-4 w-4 text-purple-400" />
                    </div>
                    <div>
                      <p className="text-sm text-white font-medium">{org.name}</p>
                      <p className="text-xs text-gray-500">{org.slug}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3">{tierBadge(org.plan_tier)}</td>
                <td className="px-5 py-3">{statusBadge(org.status)}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, ((org.ai_gens_used ?? 0) / Math.max(1, org.ai_gens_limit ?? 10)) * 100)}%`,
                          background: ((org.ai_gens_used ?? 0) / Math.max(1, org.ai_gens_limit ?? 10)) > 0.9 ? '#f87171' : '#818cf8',
                        }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-400 font-mono tabular-nums">
                      {org.ai_gens_used ?? 0}/{org.ai_gens_limit ?? 10}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-3 text-xs text-gray-400">{org.seats_total}</td>
                <td className="px-5 py-3 text-xs text-gray-400">{formatDate(org.created_at)}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-white hover:bg-white/10" onClick={() => handleEdit(org)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 w-7 p-0 text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10"
                      title="Reset eco usage to 0"
                      onClick={async () => {
                        if (!confirm(`Reset eco usage for "${org.name}" to 0?`)) return;
                        try {
                          const { error } = await supabase.from('organizations')
                            .update({ ai_gens_used: 0, ai_gens_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() })
                            .eq('id', org.id);
                          if (error) throw error;
                          toast.success(`Eco usage reset for ${org.name}`);
                          loadOrganizations();
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to reset eco');
                        }
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className={`h-7 px-2 text-[11px] ${org.status === 'active' ? 'text-amber-400 hover:bg-amber-500/10' : 'text-emerald-400 hover:bg-emerald-500/10'}`} onClick={() => handleToggleStatus(org)}>
                      {org.status === 'active' ? 'Suspend' : 'Activate'}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-red-400 hover:bg-red-500/10" onClick={() => handleDelete(org.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {orgs.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-sm text-gray-500">No organizations found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalCount > PAGE_SIZE && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => { e.preventDefault(); if (page > 0) setPage(page - 1); }}
                className={page === 0 ? 'pointer-events-none opacity-50' : ''}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="text-xs text-gray-500 px-3">
                Page {page + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}
              </span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => { e.preventDefault(); if ((page + 1) * PAGE_SIZE < totalCount) setPage(page + 1); }}
                className={(page + 1) * PAGE_SIZE >= totalCount ? 'pointer-events-none opacity-50' : ''}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showCreate || !!editOrg} onOpenChange={() => { setShowCreate(false); setEditOrg(null); }}>
        <DialogContent className="bg-[#111318] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">{editOrg ? 'Edit Organization' : 'New Organization'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-gray-300">Name</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Acme Corp" className="bg-white/5 border-white/10 text-white" />
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">Slug</Label>
              <Input value={formSlug} onChange={(e) => setFormSlug(e.target.value)} placeholder="acme-corp" className="bg-white/5 border-white/10 text-white" />
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">Max Users</Label>
              <Input type="number" value={formMaxUsers} onChange={(e) => setFormMaxUsers(e.target.value)} className="bg-white/5 border-white/10 text-white" />
            </div>
            {editOrg && (
              <>
                <div className="h-px bg-white/[0.06]" />
                <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Eco Quota</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Eco Used</Label>
                    <Input type="number" step="0.5" min="0" value={formEcoUsed} onChange={(e) => setFormEcoUsed(e.target.value)} className="bg-white/5 border-white/10 text-white" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Eco Limit</Label>
                    <Input type="number" step="1" min="0" value={formEcoLimit} onChange={(e) => setFormEcoLimit(e.target.value)} className="bg-white/5 border-white/10 text-white" />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-xs h-8 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10"
                  onClick={() => setFormEcoUsed('0')}
                >
                  <RotateCcw className="h-3 w-3 mr-1.5" /> Reset Eco to 0
                </Button>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowCreate(false); setEditOrg(null); }} className="text-gray-400">Cancel</Button>
            <Button onClick={editOrg ? handleUpdate : handleCreate} className="bg-purple-600 hover:bg-purple-700 text-white">
              {editOrg ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
