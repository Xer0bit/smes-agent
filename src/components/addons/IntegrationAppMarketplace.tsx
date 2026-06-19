import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Search } from 'lucide-react';

interface IntegrationApp {
  id: string;
  name: string;
  description: string;
  category: string;
  icon_url: string | null;
}

interface IntegrationAppMarketplaceProps {
  orgId: string;
  projectId: string;
}

export function IntegrationAppMarketplace({ orgId, projectId }: IntegrationAppMarketplaceProps) {
  const [apps, setApps] = useState<IntegrationApp[]>([]);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      supabase.from('integration_apps').select('id, name, description, category, icon_url'),
      supabase
        .from('project_integrations')
        .select('integration_app_id')
        .eq('project_id', projectId),
    ]).then(([appsRes, intRes]) => {
      if (appsRes.data) setApps(appsRes.data as IntegrationApp[]);
      if (intRes.data)
        setInstalledIds(new Set(intRes.data.map((r) => r.integration_app_id)));
      setLoading(false);
    });
  }, [projectId]);

  const toggle = async (appId: string) => {
    setToggling(appId);
    const installed = installedIds.has(appId);
    if (installed) {
      const { error } = await supabase
        .from('project_integrations')
        .delete()
        .eq('project_id', projectId)
        .eq('integration_app_id', appId);
      if (error) {
        toast.error('Failed to remove integration');
      } else {
        setInstalledIds((prev) => {
          const next = new Set(prev);
          next.delete(appId);
          return next;
        });
        toast.success('Integration removed');
      }
    } else {
      const { error } = await supabase
        .from('project_integrations')
        .insert({ project_id: projectId, integration_app_id: appId, org_id: orgId });
      if (error) {
        toast.error('Failed to install integration');
      } else {
        setInstalledIds((prev) => new Set([...prev, appId]));
        toast.success('Integration installed');
      }
    }
    setToggling(null);
  };

  const filtered = apps.filter(
    (a) =>
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.category.toLowerCase().includes(query.toLowerCase())
  );

  if (loading) return <div className="animate-pulse h-40 bg-muted rounded" />;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No integrations found.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((app) => {
            const installed = installedIds.has(app.id);
            return (
              <div
                key={app.id}
                className="flex items-start gap-3 p-3 border rounded-lg bg-card"
              >
                {app.icon_url ? (
                  <img src={app.icon_url} alt={app.name} className="w-8 h-8 rounded" />
                ) : (
                  <div className="w-8 h-8 rounded bg-muted flex items-center justify-center text-xs font-bold">
                    {app.name[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{app.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {app.category}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{app.description}</p>
                </div>
                <Button
                  size="sm"
                  variant={installed ? 'outline' : 'default'}
                  onClick={() => toggle(app.id)}
                  disabled={toggling === app.id}
                  className="shrink-0"
                >
                  {toggling === app.id ? '…' : installed ? 'Remove' : 'Install'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
