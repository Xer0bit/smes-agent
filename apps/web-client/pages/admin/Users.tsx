import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { confirmRowDeleted } from '@/services/confirmDeletion';
import { Page, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';

const PAGE_SIZE = 20;
const dialogCls = 'bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white';

interface UserWithRole {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  role: string | null;
}

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

export default function Users() {
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<UserWithRole | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [roleUser, setRoleUser] = useState<UserWithRole | null>(null);
  const [selectedRole, setSelectedRole] = useState('');
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(searchQuery.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => { loadUsers(); }, [page, debouncedSearch]);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      setCurrentUserId(session?.user?.id || null);

      let query = supabase.from('profiles').select('id, email, full_name, created_at', { count: 'exact' }).order('created_at', { ascending: false });
      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`);
      }
      const { data: profiles, error, count } = await query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;

      const ids = (profiles || []).map((p) => p.id);
      const { data: roles } = await supabase.from('user_roles').select('user_id, role').in('user_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const roleMap = new Map((roles || []).map((r) => [r.user_id, r.role]));

      if (session?.user?.id) {
        const { data: myRole } = await supabase.from('user_roles').select('role').eq('user_id', session.user.id).maybeSingle();
        setCurrentUserRole(myRole?.role || 'user');
      }

      const merged = (profiles || []).map((p) => ({ ...p, role: roleMap.get(p.id) || null }));
      setUsers(merged);
      setTotalCount(count ?? merged.length);
    } catch (error) {
      console.error('Failed to load users:', error);
      toast.error('Failed to load users');
    } finally { setLoading(false); }
  };

  const handleEditUser = (user: UserWithRole) => { setEditUser(user); setEditName(user.full_name || ''); setEditEmail(user.email); };

  const handleUpdateUser = async () => {
    if (!editUser) return;
    try {
      const { error } = await supabase.from('profiles').update({ full_name: editName, email: editEmail }).eq('id', editUser.id);
      if (error) throw error;
      toast.success('User updated');
      setEditUser(null);
      loadUsers();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to update user'));
    }
  };

  const handleManageRole = (user: UserWithRole) => {
    if (user.role === 'super_admin' && currentUserRole !== 'super_admin') return void toast.error('Only super admins can manage super admin users');
    setRoleUser(user);
    setSelectedRole(user.role || 'user');
  };

  const handleUpdateRole = async () => {
    if (!roleUser) return;
    if (selectedRole === 'super_admin' && currentUserRole !== 'super_admin') return void toast.error('Only super admins can assign the super admin role');
    if (roleUser.id === currentUserId && selectedRole === 'user') return void toast.error('You cannot remove your own admin access');
    try {
      if (selectedRole === 'user') {
        await supabase.from('user_roles').delete().eq('user_id', roleUser.id);
      } else {
        const { data: existing } = await supabase.from('user_roles').select('id').eq('user_id', roleUser.id).maybeSingle();
        if (existing) await supabase.from('user_roles').update({ role: selectedRole }).eq('user_id', roleUser.id);
        else await supabase.from('user_roles').insert({ user_id: roleUser.id, role: selectedRole });
      }
      toast.success('Role updated');
      setRoleUser(null);
      loadUsers();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to update role'));
    }
  };

  const handleRequestDeleteUser = (id: string) => {
    const target = users.find((u) => u.id === id);
    if (id === currentUserId) return void toast.error('You cannot delete your own account from admin panel');
    if (target?.role === 'super_admin' && currentUserRole !== 'super_admin') return void toast.error('Only super admins can delete super admin users');
    setDeleteUserId(id);
  };

  const handleDeleteUser = async (id: string) => {
    setDeletingUser(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data, error } = await supabase.functions.invoke('admin-delete-user', {
        body: { user_id: id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const outcome = await confirmRowDeleted('profiles', id);
      toast.success(outcome === 'gone' ? 'User deleted' : 'Delete sent, but it could not be confirmed. Refresh to check.');
      loadUsers();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to delete user'));
    } finally { setDeletingUser(false); setDeleteUserId(null); }
  };

  const pages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <Page title="Users" actions={<span className="text-xs text-gray-500">{totalCount} users</span>}>
      <input className={`${input} max-w-xs`} placeholder="Search users" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      <Panel>
        <Table head={['User', 'Role', 'Joined', '']} empty={loading ? 'Loading' : 'No users found'}>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="text-white">{user.full_name || user.email}</div>
                {user.full_name && <div className="text-[11px] text-gray-500">{user.email}</div>}
              </td>
              <td><Tag tone={user.role === 'super_admin' ? 'bad' : user.role === 'admin' ? 'accent' : 'gray'}>{(user.role || 'user').replace('_', ' ')}</Tag></td>
              <td className="text-gray-500 whitespace-nowrap">{when(user.created_at)}</td>
              <td className="text-right whitespace-nowrap space-x-1">
                <button type="button" className={btn.ghost} onClick={() => handleEditUser(user)}>Edit</button>
                <button type="button" className={btn.ghost} onClick={() => handleManageRole(user)}>Role</button>
                <button type="button" className={btn.danger} onClick={() => handleRequestDeleteUser(user.id)}>Delete</button>
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

      <Dialog open={!!editUser} onOpenChange={() => setEditUser(null)}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>Edit user</DialogTitle></DialogHeader>
          <label className="text-xs text-gray-400">Full name<input className={`${input} mt-1`} value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
          <label className="text-xs text-gray-400">Email<input className={`${input} mt-1`} value={editEmail} onChange={(e) => setEditEmail(e.target.value)} /></label>
          <DialogFooter>
            <button type="button" className={btn.ghost} onClick={() => setEditUser(null)}>Cancel</button>
            <button type="button" className={btn.primary} onClick={handleUpdateUser}>Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!roleUser} onOpenChange={() => setRoleUser(null)}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>Role for {roleUser?.email}</DialogTitle></DialogHeader>
          <Select value={selectedRole} onValueChange={setSelectedRole}>
            <SelectTrigger className="h-8 text-xs bg-transparent border-white/10 text-white"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-[#1a1d24] border-white/10">
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              {currentUserRole === 'super_admin' && <SelectItem value="super_admin">Super Admin</SelectItem>}
            </SelectContent>
          </Select>
          <DialogFooter>
            <button type="button" className={btn.ghost} onClick={() => setRoleUser(null)}>Cancel</button>
            <button type="button" className={btn.primary} onClick={handleUpdateRole}>Update role</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleteUserId} onOpenChange={(open) => { if (!open) setDeleteUserId(null); }}>
        <DialogContent className={dialogCls}>
          <DialogHeader><DialogTitle>Delete user?</DialogTitle></DialogHeader>
          <p className="text-xs text-gray-400">Removes the account from auth. The email can re-register.</p>
          <DialogFooter>
            <button type="button" className={btn.ghost} disabled={deletingUser} onClick={() => setDeleteUserId(null)}>Cancel</button>
            <button type="button" className={btn.danger} disabled={deletingUser} onClick={() => { if (deleteUserId) handleDeleteUser(deleteUserId); }}>{deletingUser ? 'Deleting' : 'Delete'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
