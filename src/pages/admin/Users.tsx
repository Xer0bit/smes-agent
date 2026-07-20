import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from '@/components/ui/pagination';
import { Search, Pencil, Trash2, Shield, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

const PAGE_SIZE = 20;

interface UserWithRole {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  role: string | null;
}

export default function Users() {
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // Edit user
  const [editUser, setEditUser] = useState<UserWithRole | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  // Role management
  const [roleUser, setRoleUser] = useState<UserWithRole | null>(null);
  const [selectedRole, setSelectedRole] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => { loadUsers(); }, [page, debouncedSearch]);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      setCurrentUserId(session?.user?.id || null);

      let query = supabase
        .from('profiles')
        .select('id, email, full_name, created_at', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`);
      }

      const { data: profiles, error, count } = await query
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;

      const ids = (profiles || []).map(p => p.id);
      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('user_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const roleMap = new Map((roles || []).map(r => [r.user_id, r.role]));

      if (session?.user?.id) {
        const { data: myRole } = await supabase
          .from('user_roles').select('role').eq('user_id', session.user.id).maybeSingle();
        setCurrentUserRole(myRole?.role || 'user');
      }

      const merged = (profiles || []).map(p => ({
        ...p,
        role: roleMap.get(p.id) || null,
      }));
      setUsers(merged);
      setTotalCount(count ?? merged.length);
    } catch (error) {
      console.error('Failed to load users:', error);
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const handleEditUser = (user: UserWithRole) => {
    setEditUser(user);
    setEditName(user.full_name || '');
    setEditEmail(user.email);
  };

  const handleUpdateUser = async () => {
    if (!editUser) return;
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ full_name: editName, email: editEmail })
        .eq('id', editUser.id);
      if (error) throw error;
      toast.success('User updated');
      setEditUser(null);
      loadUsers();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update user');
    }
  };

  const handleManageRole = (user: UserWithRole) => {
    if (user.role === 'super_admin' && currentUserRole !== 'super_admin') {
      toast.error('Only super admins can manage super admin users');
      return;
    }

    setRoleUser(user);
    setSelectedRole(user.role || 'user');
  };

  const handleUpdateRole = async () => {
    if (!roleUser) return;

    if (selectedRole === 'super_admin' && currentUserRole !== 'super_admin') {
      toast.error('Only super admins can assign the super admin role');
      return;
    }

    if (roleUser.id === currentUserId && selectedRole === 'user') {
      toast.error('You cannot remove your own admin access');
      return;
    }

    try {
      if (selectedRole === 'user') {
        await supabase.from('user_roles').delete().eq('user_id', roleUser.id);
      } else {
        const { data: existing } = await supabase
          .from('user_roles').select('id').eq('user_id', roleUser.id).maybeSingle();
        if (existing) {
          await supabase.from('user_roles').update({ role: selectedRole }).eq('user_id', roleUser.id);
        } else {
          await supabase.from('user_roles').insert({ user_id: roleUser.id, role: selectedRole });
        }
      }
      toast.success('Role updated');
      setRoleUser(null);
      loadUsers();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update role');
    }
  };

  const handleDeleteUser = async (id: string) => {
    const target = users.find((u) => u.id === id);
    if (id === currentUserId) {
      toast.error('You cannot delete your own account from admin panel');
      return;
    }
    if (target?.role === 'super_admin' && currentUserRole !== 'super_admin') {
      toast.error('Only super admins can delete super admin users');
      return;
    }

    if (!confirm('Are you sure you want to delete this user? This will permanently remove them from auth and they can re-register with the same email.')) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data, error } = await supabase.functions.invoke('admin-delete-user', {
        body: { user_id: id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success('User deleted   email is now free to re-register');
      loadUsers();
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete user');
    }
  };

  const roleBadge = (role: string | null) => {
    const styles: Record<string, { bg: string; text: string; border: string }> = {
      super_admin: { bg: 'rgba(239,68,68,0.1)', text: '#f87171', border: 'rgba(239,68,68,0.2)' },
      admin: { bg: 'rgba(139,92,246,0.1)', text: '#a78bfa', border: 'rgba(139,92,246,0.2)' },
    };
    if (!role) return <span className="text-xs text-gray-500">User</span>;
    const s = styles[role] || { bg: 'rgba(107,114,128,0.1)', text: '#9ca3af', border: 'rgba(107,114,128,0.2)' };
    return (
      <span
        className="text-[11px] font-medium px-2 py-0.5 rounded-full capitalize"
        style={{ background: s.bg, color: s.text, border: `1px solid ${s.border}` }}
      >
        {role.replace('_', ' ')}
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
      {/* Search + count */}
      <div className="flex items-center justify-between">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
          <Input
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-72 pl-9 text-xs bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-purple-500/50"
          />
        </div>
        <span className="text-xs text-gray-500">{totalCount} users</span>
      </div>

      {/* Table */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}
      >
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">User</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Role</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Joined</th>
              <th className="text-right text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                className="group hover:bg-white/[0.03] transition-colors"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                      style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' }}
                    >
                      {(user.email?.[0] || '?').toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm text-white font-medium">{user.full_name || ' '}</p>
                      <p className="text-xs text-gray-500">{user.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3">{roleBadge(user.role)}</td>
                <td className="px-5 py-3 text-xs text-gray-400">{formatDate(user.created_at)}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-white hover:bg-white/10" onClick={() => handleEditUser(user)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-purple-400 hover:bg-purple-500/10" onClick={() => handleManageRole(user)}>
                      <Shield className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-red-400 hover:bg-red-500/10" onClick={() => handleDeleteUser(user.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-12 text-sm text-gray-500">No users found</td>
              </tr>
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

      {/* Edit User Dialog */}
      <Dialog open={!!editUser} onOpenChange={() => setEditUser(null)}>
        <DialogContent className="bg-[#111318] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">Edit User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-gray-300">Full Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-white/5 border-white/10 text-white" />
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">Email</Label>
              <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="bg-white/5 border-white/10 text-white" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditUser(null)} className="text-gray-400">Cancel</Button>
            <Button onClick={handleUpdateUser} className="bg-purple-600 hover:bg-purple-700 text-white">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Role Dialog */}
      <Dialog open={!!roleUser} onOpenChange={() => setRoleUser(null)}>
        <DialogContent className="bg-[#111318] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">Manage Role   {roleUser?.email}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-gray-300 mb-2 block">Role</Label>
            <Select value={selectedRole} onValueChange={setSelectedRole}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#1a1d24] border-white/10">
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                {currentUserRole === 'super_admin' && <SelectItem value="super_admin">Super Admin</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRoleUser(null)} className="text-gray-400">Cancel</Button>
            <Button onClick={handleUpdateRole} className="bg-purple-600 hover:bg-purple-700 text-white">Update Role</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
