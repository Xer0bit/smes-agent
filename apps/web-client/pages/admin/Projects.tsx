import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from '@/components/ui/pagination';
import { Search, Pencil, Trash2, FolderKanban, Users } from 'lucide-react';
import { ProjectMemberAccess } from '@/components/ProjectMemberAccess';
import { toast } from 'sonner';
import { confirmRowDeleted } from '@/services/confirmDeletion';

const PAGE_SIZE = 20;

interface ProjectWithOrg {
  id: string;
  name: string;
  status: string;
  created_at: string;
  org_name: string | null;
  organization_id: string | null;
}

export default function Projects() {
  const [projects, setProjects] = useState<ProjectWithOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const [editProject, setEditProject] = useState<ProjectWithOrg | null>(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [accessProject, setAccessProject] = useState<ProjectWithOrg | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => { loadProjects(); }, [page, debouncedSearch]);

  const loadProjects = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('projects')
        .select('id, name, status, created_at, organization_id, organizations(name)', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.ilike('name', `%${q}%`);
      }

      const { data, error, count } = await query
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      const mapped = (data || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        status: p.status || 'active',
        created_at: p.created_at,
        org_name: p.organizations?.name || null,
        organization_id: p.organization_id || null,
      }));
      setProjects(mapped);
      setTotalCount(count ?? mapped.length);
    } catch (error) {
      console.error('Failed to load projects:', error);
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (project: ProjectWithOrg) => {
    setEditProject(project);
    setEditName(project.name);
    setEditStatus(project.status);
  };

  const handleUpdate = async () => {
    if (!editProject) return;
    try {
      const { error } = await supabase.from('projects')
        .update({ name: editName, status: editStatus })
        .eq('id', editProject.id);
      if (error) throw error;
      toast.success('Project updated');
      setEditProject(null);
      loadProjects();
    } catch (error: any) {
      toast.error(error.message || 'Failed to update project');
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingProject(true);
    try {
      const { error } = await supabase.from('projects').delete().eq('id', id);
      if (error) throw error;
      const outcome = await confirmRowDeleted('projects', id);
      toast.success(outcome === 'gone'
        ? 'Project deleted'
        : 'Delete sent, but it could not be confirmed. Refresh to check.');
      loadProjects();
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
      setDeleteProjectId(null);
    }
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const statusBadge = (status: string) => {
    const colors: Record<string, { bg: string; text: string; border: string }> = {
      active: { bg: 'rgba(34,197,94,0.1)', text: '#4ade80', border: 'rgba(34,197,94,0.2)' },
      archived: { bg: 'rgba(107,114,128,0.1)', text: '#9ca3af', border: 'rgba(107,114,128,0.2)' },
      draft: { bg: 'rgba(59,130,246,0.1)', text: '#60a5fa', border: 'rgba(59,130,246,0.2)' },
    };
    const s = colors[status] || colors.active;
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full capitalize inline-flex items-center gap-1"
        style={{ background: s.bg, color: s.text, border: `1px solid ${s.border}` }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.text }} />
        {status}
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
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-72 pl-9 text-xs bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-purple-500/50"
          />
        </div>
        <span className="text-xs text-gray-500">{totalCount} projects</span>
      </div>

      <div className="rounded-xl border overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Project</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Organization</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Status</th>
              <th className="text-left text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Created</th>
              <th className="text-right text-[11px] font-medium text-gray-400 uppercase tracking-wider px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="group hover:bg-white/[0.03] transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                      <FolderKanban className="h-4 w-4 text-emerald-400" />
                    </div>
                    <span className="text-sm text-white font-medium">{project.name}</span>
                  </div>
                </td>
                <td className="px-5 py-3">
                  {project.org_name ? (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.1)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.2)' }}>
                      {project.org_name}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500"> </span>
                  )}
                </td>
                <td className="px-5 py-3">{statusBadge(project.status)}</td>
                <td className="px-5 py-3 text-xs text-gray-400">{formatDate(project.created_at)}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {project.organization_id && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10" title="Manage Access" onClick={() => setAccessProject(project)}>
                        <Users className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-white hover:bg-white/10" onClick={() => handleEdit(project)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-red-400 hover:bg-red-500/10" onClick={() => setDeleteProjectId(project.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr><td colSpan={5} className="text-center py-12 text-sm text-gray-500">No projects found</td></tr>
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

      {/* Access Management Dialog */}
      <Dialog open={!!accessProject} onOpenChange={() => setAccessProject(null)}>
        <DialogContent className="bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-400" />
              Member Access   {accessProject?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            {accessProject?.organization_id ? (
              <ProjectMemberAccess
                projectId={accessProject.id}
                organizationId={accessProject.organization_id}
              />
            ) : (
              <p className="text-sm text-gray-500 text-center py-6">This project has no organization.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAccessProject(null)} className="text-gray-400">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editProject} onOpenChange={() => setEditProject(null)}>
        <DialogContent className="bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">Edit Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-gray-300">Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-white/5 border-white/10 text-white" />
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">Status</Label>
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger className="bg-white/5 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1a1d24] border-white/10">
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditProject(null)} className="text-gray-400">Cancel</Button>
            <Button onClick={handleUpdate} className="bg-purple-600 hover:bg-purple-700 text-white">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Project Confirmation */}
      <AlertDialog open={!!deleteProjectId} onOpenChange={(open) => { if (!open) setDeleteProjectId(null); }}>
        <AlertDialogContent className="bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete this project?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400">
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingProject} className="bg-transparent border-white/10 text-gray-300 hover:bg-white/10 hover:text-white">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingProject}
              onClick={(e) => { e.preventDefault(); if (deleteProjectId) handleDelete(deleteProjectId); }}
              className={buttonVariants({ variant: 'destructive' })}
            >
              {deletingProject ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
