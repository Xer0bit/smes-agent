import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { getApiServerUrl } from '@/config/external-api';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Settings } from 'lucide-react';
import { ProjectThumbnail } from '@/components/dashboard/ProjectThumbnail';
import EcgConnectWizard from '@/components/ecg/EcgConnectWizard';

interface ConnectedProject {
  id: string;
  name: string;
  thumbnail_url: string | null;
}

// Every dashboard ever connected here, old launch-token flow or the new
// API-key + MCP-discovery flow   both write a project secret, just under a
// different key name, and one org can have many of these over time.
async function loadConnectedProjects(): Promise<ConnectedProject[]> {
  const { data } = await supabase
    .from('project_secrets')
    .select('project_id, projects(id, name, thumbnail_url)')
    .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_MCP_API_KEY']);
  const seen = new Set<string>();
  const projects: ConnectedProject[] = [];
  for (const row of (data || []) as any[]) {
    const p = row.projects;
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      projects.push(p);
    }
  }
  return projects;
}

export default function EcgAgentsPage() {
  const navigate = useNavigate();
  const [connectedProjects, setConnectedProjects] = useState<ConnectedProject[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [showConnectForm, setShowConnectForm] = useState(false);

  const load = async () => {
    setLoadingProjects(true);
    try {
      const projects = await loadConnectedProjects();
      setConnectedProjects(projects);

      const urls: Record<string, string> = {};
      await Promise.all(projects.map(async (p) => {
        const { data } = await supabase.rpc('get_latest_preview_url', { p_project_id: p.id });
        if (data) urls[p.id] = data;
      }));
      setPreviewUrls(urls);

      // Same best-effort auto-capture Projects.tsx does for thumbnail-less cards.
      const session = (await supabase.auth.getSession()).data.session;
      if (session?.access_token) {
        for (const p of projects.filter((p) => !p.thumbnail_url)) {
          fetch(getApiServerUrl(`/api/v1/projects/${p.id}/capture-thumbnail`), {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(urls[p.id] ? { previewUrl: urls[p.id] } : {}),
          }).catch(() => { /* silent   thumbnail is best-effort */ });
        }
      }
    } catch (error) {
      console.error('Failed to load eCG Agent connections:', error);
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => { load(); }, []);

  const refreshPreviewUrl = async (projectId: string) => {
    const { data } = await supabase.rpc('get_latest_preview_url', { p_project_id: projectId });
    if (data) setPreviewUrls((prev) => ({ ...prev, [projectId]: data }));
  };

  if (loadingProjects) {
    return (
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card">
              <div className="skeleton h-48 w-full rounded-none" />
              <div className="space-y-2 p-4"><div className="skeleton h-3.5 w-2/3" /><div className="skeleton h-3 w-1/3" /></div>
            </div>
          ))}
        </div>
    );
  }

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="eCG Agents"
        description="Dashboards built from your connected eCG Agent orgs. One org can run several of these."
      />

      {connectedProjects.length === 0 ? (
        <EcgConnectWizard emptyState />
      ) : showConnectForm ? (
        <>
          <Button variant="ghost" size="sm" className="mb-4 rounded-full" onClick={() => setShowConnectForm(false)}>
            ← Back to your dashboards
          </Button>
          <EcgConnectWizard emptyState={false} />
        </>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {connectedProjects.map((p, i) => (
            <div
              className="animate-msg-appear"
              key={p.id}
            >
              <Card
                className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border-border/60 transition-colors duration-150 hover:border-primary/40"
                onClick={() => navigate(`/project/${p.id}`)}
              >
                <ProjectThumbnail
                  projectName={p.name}
                  thumbnailUrl={p.thumbnail_url}
                  previewUrl={previewUrls[p.id] ?? null}
                  onRefresh={() => refreshPreviewUrl(p.id)}
                />
                <CardContent className="flex items-center gap-3 p-4">
                  <h3 className="min-w-0 flex-1 truncate font-display text-base font-semibold text-foreground transition-colors group-hover:text-primary">
                    {p.name}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/settings`); }}
                    className="h-8 w-8 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
                    title="Project settings"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            </div>
          ))}
          <button
            onClick={() => setShowConnectForm(true)}
            className="flex min-h-48 items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-card/20 p-4 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <Plus className="h-4 w-4" /> Connect another
          </button>
        </div>
      )}
    </div>
  );
}
