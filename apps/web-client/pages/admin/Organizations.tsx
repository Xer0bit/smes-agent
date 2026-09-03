import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { confirmRowDeleted } from '@/services/confirmDeletion';
import { Page, Panel, Table, Tag, Dot, btn, input, when } from '@/components/admin/ui';

const PAGE_SIZE = 20;
const dialogCls = 'bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white';

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

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;
const tierTone = (tier: string): 'gray' | 'accent' | 'warn' => (tier === 'enterprise' ? 'warn' : tier === 'free' ? 'gray' : 'accent');

export default function Organizations() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [editOrg, setEditOrg] = useState<Organization | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formMaxUsers, setFormMaxUsers] = useState('10');
  const [formEcoLimit, setFormEcoLimit] = useState('10');
  const [formEcoUsed, setFormEcoUsed] = useState('0');
  const [deleteOrgId, setDeleteOrgId] = useState<string | null>(null);
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [resetUsageOrg, setResetUsageOrg] = useState<Organization | null>(null);
  const [resettingUsage, setResettingUsage] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(searchQuery.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => { loadOrganizations(); }, [page, debouncedSearch]);

  const loadOrganizations = async () => {
    try {
      setLoading(true);
      let query = supabase.from('organizations')
        .select('id, name, slug, seats_total, status, plan_tier, ai_gens_used, ai_gens_limit, ai_gens_reset_at, created_at', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
      }
      const { data, error, count } = await query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      setOrgs(data || []);
      setTotalCount(count ?? (data || []).length);
    } catch (error) {
      console.error('Failed to load organizations:', error);
      toast.error('Failed to load organizations');
    } finally { setLoading(false); }
  };

  const closeForm = () => { setShowCreate(false); setEditOrg(null); };

  const handleCreate = async () => {
    try {
      const slug = formSlug || formName.toLowerCase().replace(/\s+/g, '-');
      const { error } = await supabase.from('organizations').insert([{ name: formName, slug, seats_total: parseInt(formMaxUsers) || 10 }]);
      if (error) throw error;
      toast.success('Organization created');
      closeForm();
      setFormName(''); setFormSlug(''); setFormMaxUsers('10');
      loadOrganizations();
    } catch (error) { toast.error(errorMessage(error, 'Failed to create organization')); }
  };

  const handleEdit = (org: Organization) => {
    setEditOrg(org); setFormName(org.name); setFormSlug(org.slug); setFormMaxUsers(String(org.seats_total));
    setFormEcoLimit(String(org.ai_gens_limit ?? 10)); setFormEcoUsed(String(org.ai_gens_used ?? 0));
  };

  const handleUpdate = async () => {
    if (!editOrg) return;
    try {
      const { error } = await supabase.from('organizations').update({
        name: formName, slug: formSlug, seats_total: parseInt(formMaxUsers) || 10,
        ai_gens_limit: parseFloat(formEcoLimit) || 10, ai_gens_used: parseFloat(formEcoUsed) || 0,
      }).eq('id', editOrg.id);
      if (error) throw error;
      toast.success('Organization updated');
      closeForm();
      loadOrganizations();
    } catch (error) { toast.error(errorMessage(error, 'Failed to update')); }
  };

  const handleToggleStatus = async (org: Organization) => {
    const newStatus = org.status === 'active' ? 'suspended' : 'active';
    try {
      const { error } = await supabase.from('organizations').update({ status: newStatus }).eq('id', org.id);
      if (error) throw error;
      toast.success(`Organization ${newStatus}`);
      loadOrganizations();
    } catch (error) { toast.error(errorMessage(error, 'Failed to update status')); }
  };

  const handleDelete = async (id: string) => {
    setDeletingOrg(true);
    try {
      const { error } = await supabase.from('organizations').delete().eq('id', id);
      if (error) throw error;
      const outcome = await confirmRowDeleted('organizations', id);
      toast.success(outcome === 'gone' ? 'Organization deleted' : 'Delete sent, but it could not be confirmed. Refresh to check.');
      loadOrganizations();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to delete'));
    } finally { setDeletingOrg(false); setDeleteOrgId(null); }
  };

  const handleResetUsage = async (org: Organization) => {
    setResettingUsage(true);
    try {
      const ai_gens_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await supabase.from('organizations').update({ ai_gens_used: 0, ai_gens_reset_at }).eq('id', org.id);
      if (error) throw error;
      toast.success(`Eco usage reset for ${org.name}`);
      loadOrganizations();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to reset eco'));
    } finally { setResettingUsage(false); setResetUsageOrg(null); }
  };

  const pages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const field = (label: string, value: string, set: (v: string) => void, type = 'text') =>
    <label className="block text-xs text-gray-400">{label}<input type={type} className={`${input} mt-1`} value={value} onChange={(e) => set(e.target.value)} /></label>;

  return (
    <Page title="Organizations" actions={<><span className="text-xs text-gray-500">{totalCount} organizations</span><button type="button" className={btn.primary} onClick={() => setShowCreate(true)}>New</button></>}>
      <input className={`${input} max-w-xs`} placeholder="Search organizations" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      <Panel>
        <Table head={['Organization', 'Plan', 'Status', 'Eco', 'Seats', 'Created', '']} empty={loading ? 'Loading' : 'No organizations found'}>
          {orgs.map((org) => (
            <tr key={org.id}>
              <td><div className="text-white">{org.name}</div><div className="text-[11px] text-gray-500">{org.slug}</div></td>
              <td><Tag tone={tierTone(org.plan_tier)}>{org.plan_tier}</Tag></td>
              <td className="whitespace-nowrap"><Dot tone={org.status === 'active' ? 'ok' : 'bad'} /> <span className="text-gray-400">{org.status}</span></td>
              <td className={`tabular-nums ${(org.ai_gens_used ?? 0) / Math.max(1, org.ai_gens_limit ?? 10) > 0.9 ? 'text-red-400' : 'text-gray-400'}`}>{org.ai_gens_used ?? 0}/{org.ai_gens_limit ?? 10}</td>
              <td className="text-gray-400">{org.seats_total}</td>
              <td className="text-gray-500 whitespace-nowrap">{when(org.created_at)}</td>
              <td className="text-right whitespace-nowrap space-x-1">
                <button type="button" className={btn.ghost} onClick={() => handleEdit(org)}>Edit</button>
                <button type="button" className={btn.ghost} onClick={() => setResetUsageOrg(org)}>Reset eco</button>
                <button type="button" className={btn.ghost} onClick={() => handleToggleStatus(org)}>{org.status === 'active' ? 'Suspend' : 'Activate'}</button>
                <button type="button" className={btn.danger} onClick={() => setDeleteOrgId(org.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
      {totalCount > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
          <button type="button" className={btn.ghost} disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" className={btn.ghost} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      <Dialog open={showCreate || !!editOrg} onOpenChange={closeForm}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>{editOrg ? 'Edit organization' : 'New organization'}</DialogTitle></DialogHeader>
          {field('Name', formName, setFormName)}
          {field('Slug', formSlug, setFormSlug)}
          {field('Max users', formMaxUsers, setFormMaxUsers, 'number')}
          {editOrg && (
            <div className="grid grid-cols-2 gap-3">
              {field('Eco used', formEcoUsed, setFormEcoUsed, 'number')}
              {field('Eco limit', formEcoLimit, setFormEcoLimit, 'number')}
              <button type="button" className={`${btn.ghost} col-span-2`} onClick={() => setFormEcoUsed('0')}>Reset eco to 0</button>
            </div>
          )}
          <DialogFooter>
            <button type="button" className={btn.ghost} onClick={closeForm}>Cancel</button>
            <button type="button" className={btn.primary} onClick={editOrg ? handleUpdate : handleCreate}>{editOrg ? 'Save' : 'Create'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleteOrgId} onOpenChange={(open) => { if (!open) setDeleteOrgId(null); }}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>Delete this organization?</DialogTitle></DialogHeader>
          <p className="text-xs text-gray-400">This cannot be undone.</p>
          <DialogFooter>
            <button type="button" className={btn.ghost} disabled={deletingOrg} onClick={() => setDeleteOrgId(null)}>Cancel</button>
            <button type="button" className={btn.danger} disabled={deletingOrg} onClick={() => { if (deleteOrgId) handleDelete(deleteOrgId); }}>{deletingOrg ? 'Deleting' : 'Delete'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!resetUsageOrg} onOpenChange={(open) => { if (!open) setResetUsageOrg(null); }}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>Reset eco usage for {resetUsageOrg?.name} to 0?</DialogTitle></DialogHeader>
          <DialogFooter>
            <button type="button" className={btn.ghost} disabled={resettingUsage} onClick={() => setResetUsageOrg(null)}>Cancel</button>
            <button type="button" className={btn.danger} disabled={resettingUsage} onClick={() => { if (resetUsageOrg) handleResetUsage(resetUsageOrg); }}>{resettingUsage ? 'Resetting' : 'Reset'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
