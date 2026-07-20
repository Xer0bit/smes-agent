import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, FileText, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { revisionService } from "@/services/revisionService";
import { detectRoutesFromAppTsx, type DetectedRoute } from "@/utils/detectRoutes";
import { RouteSeoEditor } from "@/components/seo/RouteSeoEditor";
import { RedirectSettings } from "@/components/referral/settings/RedirectSettings";
import { SiteSettingsEditor } from "@/components/seo/SiteSettingsEditor";

// Shared by the SEO settings dialog tab and the standalone /project/:id/seo
// page   kept as one component so neither view can drift out of sync with
// the other, and so the settings-dialog case never has to re-implement it.
export function SeoSettingsPanel({ projectId }: { projectId?: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const { data: detectedRoutes, isLoading: detecting, error: detectError } = useQuery({
    queryKey: ["seo-detected-routes", projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<DetectedRoute[]> => {
      const revisions = await revisionService.getRevisions(projectId!, 1, 0);
      const latest = revisions[0];
      let routes: DetectedRoute[] = [];
      if (latest) {
        const files = await revisionService.getRevisionFilesForExport(projectId!, latest.id);
        const appTsx = files.find((f) => f.path === "src/App.tsx")?.content;
        if (appTsx) routes = detectRoutesFromAppTsx(appTsx);
      }
      if (!routes.some((r) => r.path === "/")) {
        routes = [{ path: "/", component: "Home", isDynamic: false }, ...routes];
      }
      return routes;
    },
  });

  useEffect(() => {
    if (selected === null && detectedRoutes && detectedRoutes.length > 0) {
      setSelected(detectedRoutes.find((r) => r.path === "/")?.path ?? detectedRoutes[0].path);
    }
  }, [detectedRoutes, selected]);

  const { data: savedRoutes } = useQuery({
    queryKey: ["seo-routes", projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<Set<string>> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return new Set();
      const { getApiServerUrl } = await import("@/config/external-api");
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/routes`), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return new Set();
      const json = await res.json();
      return new Set((json.routes ?? []).map((r: { route_path: string }) => r.route_path));
    },
  });

  const filteredRoutes = useMemo(() => {
    const routes = detectedRoutes ?? [];
    if (!search.trim()) return routes;
    const q = search.toLowerCase();
    return routes.filter((r) => r.path.toLowerCase().includes(q) || r.component.toLowerCase().includes(q));
  }, [detectedRoutes, search]);

  const staticRoutes = filteredRoutes.filter((r) => !r.isDynamic);
  const dynamicRoutes = filteredRoutes.filter((r) => r.isDynamic);

  return (
    <Tabs defaultValue="pages" className="flex flex-col h-full min-h-0">
      <div className="border-b border-white/[0.07] shrink-0">
        <TabsList className="bg-workspace-surface border border-white/[0.07]">
          <TabsTrigger value="pages" className="text-[12px]">Pages</TabsTrigger>
          <TabsTrigger value="redirects" className="text-[12px]">Redirects</TabsTrigger>
          <TabsTrigger value="site" className="text-[12px]">Site Settings</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="pages" className="flex-1 min-h-0 m-0">
        <div className="flex h-full min-h-0">
          <div className="w-[280px] shrink-0 border-r border-white/[0.07] flex flex-col bg-workspace-surface-recessed">
            <div className="p-3 border-b border-white/[0.07]">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search pages…"
                  className="pl-8 h-8 bg-workspace-surface border-white/[0.07] text-white/85 placeholder:text-white/30 text-[13px]"
                />
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-2 space-y-3">
                {detecting && (
                  <div className="px-2 py-3 flex items-center gap-2 text-white/30 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Detecting pages…
                  </div>
                )}

                {detectError && (
                  <p className="px-2 text-[11px] text-red-400/80">Couldn't read App.tsx from the latest revision.</p>
                )}

                {!detecting && staticRoutes.length > 0 && (
                  <div>
                    <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-white/30">Pages ({staticRoutes.length})</p>
                    {staticRoutes.map((r) => (
                      <RouteListItem
                        key={r.path}
                        label={r.path === "/" ? "/ (Home)" : r.path}
                        sublabel={r.component}
                        configured={savedRoutes?.has(r.path)}
                        active={selected === r.path}
                        onClick={() => setSelected(r.path)}
                      />
                    ))}
                  </div>
                )}

                {!detecting && dynamicRoutes.length > 0 && (
                  <div>
                    <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-white/30">Dynamic patterns ({dynamicRoutes.length})</p>
                    {dynamicRoutes.map((r) => (
                      <RouteListItem
                        key={r.path}
                        label={r.path}
                        sublabel={r.component}
                        configured={savedRoutes?.has(r.path)}
                        active={selected === r.path}
                        onClick={() => setSelected(r.path)}
                        dynamic
                      />
                    ))}
                  </div>
                )}

                {!detecting && filteredRoutes.length === 0 && !detectError && (
                  <p className="px-2 text-[11px] text-white/30">No pages found.</p>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className="max-w-2xl mx-auto p-6">
              {selected && (
                <RouteSeoEditor
                  key={selected}
                  projectId={projectId}
                  routePath={selected}
                  onSaved={() => queryClient.invalidateQueries({ queryKey: ["seo-routes", projectId] })}
                />
              )}
            </div>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="redirects" className="flex-1 min-h-0 overflow-y-auto m-0">
        <div className="max-w-2xl mx-auto p-6">
          <RedirectSettings projectId={projectId} />
        </div>
      </TabsContent>

      <TabsContent value="site" className="flex-1 min-h-0 overflow-y-auto m-0">
        <div className="max-w-2xl mx-auto p-6">
          <SiteSettingsEditor projectId={projectId} />
        </div>
      </TabsContent>
    </Tabs>
  );
}

function RouteListItem({
  label, sublabel, active, onClick, configured, dynamic,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  onClick: () => void;
  configured?: boolean;
  dynamic?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors duration-smooth ${
        active ? "bg-indigo-500/15 text-white" : "text-white/60 hover:bg-white/[0.04] hover:text-white/85"
      }`}
    >
      <span className={active ? "text-indigo-400" : "text-white/30"}><FileText className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <code className="text-[12px] font-mono truncate">{label}</code>
          {dynamic && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-white/15 text-white/30">pattern</Badge>}
        </div>
        <p className="text-[10px] text-white/30 truncate">{sublabel}</p>
      </div>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${configured ? "bg-emerald-400" : "bg-white/15"}`} />
    </button>
  );
}
