import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bot, Loader2, ArrowRight, Plus } from 'lucide-react';
import EcgConnectWizard from '@/components/ecg/EcgConnectWizard';

interface ConnectedProject {
  id: string;
  name: string;
}

// Every dashboard ever connected here, old launch-token flow or the new
// API-key + MCP-discovery flow   both write a project secret, just under a
// different key name, and one org can have many of these over time.
async function loadConnectedProjects(): Promise<ConnectedProject[]> {
  const { data } = await supabase
    .from('project_secrets')
    .select('project_id, projects(id, name)')
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
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [showConnectForm, setShowConnectForm] = useState(false);

  useEffect(() => {
    (async () => {
      setLoadingProjects(true);
      try {
        setConnectedProjects(await loadConnectedProjects());
      } catch (error) {
        console.error('Failed to load eCG Agent connections:', error);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, []);

  if (loadingProjects) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connectedProjects.map((p) => (
            <Card key={p.id} className="rounded-xl border-border/60 bg-card/60 transition-colors hover:border-border">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.name}</p>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate(`/project/${p.id}`)}>
                  Open <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </CardContent>
            </Card>
          ))}
          <button
            onClick={() => setShowConnectForm(true)}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-card/20 p-4 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <Plus className="h-4 w-4" /> Connect another
          </button>
        </div>
      )}
    </div>
  );
}
