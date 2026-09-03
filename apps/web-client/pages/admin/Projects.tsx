import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Page, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';
import { ProjectMemberAccess } from '@/components/ProjectMemberAccess';
import { toast } from 'sonner';
import { confirmRowDeleted } from '@/services/confirmDeletion';

const PAGE_SIZE = 20;
const DIALOG = 'bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white';
const STATUS_TONE: Record<string, 'ok' | 'gray' | 'accent'> = { active: 'ok', archived: 'gray', draft: 'accent' };

interface ProjectRow {
  id: string;
  name: string;
  status: string | null;
  created_at: string;
  organization_id: string | null;
  organizations: { name: string } | null;
}

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
        .select<string, ProjectRow>('id, name, status, created_at, organization_id, organizations(name)', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (debouncedSearch) {
        const q = debouncedSearch.replace(/[%,]/g, '');
        query = query.ilike('name', `%${q}%`);
      }
      const { data, error, count } = await query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      const mapped: ProjectWithOrg[] = (data || []).map((p) => ({
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
      const { error } = await supabase.from('projects').update({ name: editName, status: editStatus }).eq('id', editProject.id);
      if (error) throw error;
      toast.success('Project updated');
      setEditProject(null);
      loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update project');
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingProject(true);
    try {
      const { error } = await supabase.from('projects').delete().eq('id', id);
      if (error) throw error;
      const outcome = await confirmRowDeleted('projects', id);
      toast.success(outcome === 'gone' ? 'Project deleted' : 'Delete sent, but it could not be confirmed. Refresh to check.');
      loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete project');
    } finally {
      setDeletingProject(false);
      setDeleteProjectId(null);
    }
  };

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <Page
      title="Projects"
      actions={
        <>
          <span className="text-xs text-gray-500">{totalCount}</span>
          <input className={`${input} w-64`} placeholder="Search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </>
      }
    >
      <Panel>
        <Table head={['Project', 'Organization', 'Status', 'Created', '']} empty={loading ? 'Loading' : 'No projects'}>
          {projects.map((project) => (
            <tr key={project.id}>
              <td className="text-white">{project.name}</td>
              <td className="text-gray-400">{project.org_name ?? '—'}</td>
              <td><Tag tone={STATUS_TONE[project.status] ?? 'ok'}>{project.status}</Tag></td>
              <td className="text-gray-400">{when(project.created_at)}</td>
              <td className="text-right whitespace-nowrap">
                {project.organization_id && <button className={btn.ghost} onClick={() => setAccessProject(project)}>Access</button>}
                <button className={`${btn.ghost} ml-1`} onClick={() => handleEdit(project)}>Edit</button>
                <button className={`${btn.danger} ml-1`} onClick={() => setDeleteProjectId(project.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      {totalCount > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
          <button className={btn.ghost} disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
          <span>{page + 1} / {pageCount}</span>
          <button className={btn.ghost} disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}

      <Dialog open={!!accessProject} onOpenChange={() => setAccessProject(null)}>
        <DialogContent className={`${DIALOG} max-w-lg`}>
          <DialogHeader><DialogTitle className="text-sm">Access: {accessProject?.name}</DialogTitle></DialogHeader>
          {accessProject?.organization_id ? (
            <ProjectMemberAccess projectId={accessProject.id} organizationId={accessProject.organization_id} />
          ) : (
            <p className="text-[13px] text-gray-500 text-center py-6">No organization.</p>
          )}
          <DialogFooter><button className={btn.ghost} onClick={() => setAccessProject(null)}>Close</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editProject} onOpenChange={() => setEditProject(null)}>
        <DialogContent className={DIALOG}>
          <DialogHeader><DialogTitle className="text-sm">Edit project</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1 text-xs text-gray-400">
              Name
              <input className={input} value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <label className="block space-y-1 text-xs text-gray-400">
              Status
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger className={input}><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#1a1d24] border-white/10">
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setEditProject(null)}>Cancel</button>
            <button className={btn.primary} onClick={handleUpdate}>Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteProjectId} onOpenChange={(open) => { if (!open && !deletingProject) setDeleteProjectId(null); }}>
        <DialogContent className={DIALOG}>
          <DialogHeader><DialogTitle className="text-sm">Delete this project?</DialogTitle></DialogHeader>
          <p className="text-[13px] text-gray-400">This cannot be undone.</p>
          <DialogFooter>
            <button className={btn.ghost} disabled={deletingProject} onClick={() => setDeleteProjectId(null)}>Cancel</button>
            <button className={btn.danger} disabled={deletingProject} onClick={() => { if (deleteProjectId) handleDelete(deleteProjectId); }}>
              {deletingProject ? 'Deleting' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
