import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, Unlink, Users, Eye, MousePointerClick } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface GoogleAnalyticsSettingsProps {
  projectId?: string;
}

interface GaProperty {
  propertyId: string;
  displayName: string;
}

interface GaReport {
  totals: { sessions: number; activeUsers: number; pageviews: number };
  daily: Array<{ date: string; sessions: number; pageviews: number }>;
  topPages: Array<{ path: string; pageviews: number }>;
  topEvents: Array<{ name: string; count: number }>;
}

// Reference-palette categorical slots 1 (blue) + 2 (green), dark-surface steps,
// in their validated adjacent order — this panel is always on the dark
// workspace surface, so no light-mode variant is needed.
const SERIES_SESSIONS = "#3987e5";
const SERIES_PAGEVIEWS = "#008300";

async function authedFetch(path: string, opts: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  const res = await fetch(getApiServerUrl(`/api/v1/google-analytics${path}`), {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${session.access_token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export const GoogleAnalyticsSettings = ({ projectId }: GoogleAnalyticsSettingsProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [savingProperty, setSavingProperty] = useState(false);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["ga-status"],
    queryFn: () => authedFetch("/status") as Promise<{ connected: boolean; email?: string | null }>,
  });
  const connected = status?.connected ?? false;

  const { data: propertiesData, isLoading: propertiesLoading } = useQuery({
    queryKey: ["ga-properties"],
    enabled: connected,
    queryFn: () => authedFetch("/properties") as Promise<{ properties: GaProperty[] }>,
  });
  const properties = propertiesData?.properties ?? [];

  const { data: savedSetting, isLoading: savedLoading } = useQuery({
    queryKey: ["ga-property", projectId],
    enabled: !!projectId && connected,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("setting_value")
        .eq("project_id", projectId!)
        .eq("setting_key", "google_analytics")
        .maybeSingle();
      return data?.setting_value as { property_id?: string; display_name?: string } | null;
    },
  });
  const selectedPropertyId = savedSetting?.property_id ?? "";

  const { data: report, isLoading: reportLoading, error: reportError } = useQuery({
    queryKey: ["ga-report", projectId],
    enabled: !!projectId && !!selectedPropertyId,
    queryFn: () => authedFetch(`/${projectId}/report?days=30`) as Promise<GaReport>,
  });

  useEffect(() => {
    const gaParam = searchParams.get("ga");
    if (gaParam === "connected") toast.success("Google Analytics connected — pick a property below");
    if (gaParam === "error") toast.error("Failed to connect Google Analytics");
    if (gaParam) {
      const p = new URLSearchParams(searchParams);
      p.delete("ga");
      setSearchParams(p, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); setConnecting(false); return; }
    const params = new URLSearchParams({ token: session.access_token });
    if (projectId) params.set("projectId", projectId);
    window.location.href = getApiServerUrl(`/api/v1/google-analytics/connect?${params.toString()}`);
  };

  const handleDisconnect = async () => {
    try {
      await authedFetch("/disconnect", { method: "DELETE" });
      queryClient.setQueryData(["ga-status"], { connected: false });
      queryClient.removeQueries({ queryKey: ["ga-properties"] });
      queryClient.removeQueries({ queryKey: ["ga-property", projectId] });
      queryClient.removeQueries({ queryKey: ["ga-report", projectId] });
      toast.success("Google Analytics disconnected");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to disconnect");
    }
  };

  const handleSelectProperty = async (propertyId: string) => {
    if (!projectId) return;
    setSavingProperty(true);
    try {
      const property = properties.find((p) => p.propertyId === propertyId);
      const { error } = await supabase
        .from("project_settings")
        .upsert(
          {
            project_id: projectId,
            setting_key: "google_analytics",
            setting_value: { property_id: propertyId, display_name: property?.displayName ?? propertyId },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id,setting_key" }
        );
      if (error) throw error;
      queryClient.setQueryData(["ga-property", projectId], { property_id: propertyId, display_name: property?.displayName });
      queryClient.invalidateQueries({ queryKey: ["ga-report", projectId] });
    } catch (e: any) {
      toast.error("Failed to save property: " + (e?.message ?? "unknown error"));
    } finally {
      setSavingProperty(false);
    }
  };

  const loading = statusLoading || (connected && (propertiesLoading || savedLoading));
  if (loading) return <SettingsSkeleton cards={2} />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Analytics</h2>
        <p className="text-sm text-white/45">Connect Google Analytics to see real traffic for this project right here.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Account</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {connected ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/80">
                Connected{status?.email ? <> as <strong>{status.email}</strong></> : null}
              </span>
              <Button size="sm" variant="outline" onClick={handleDisconnect} className="h-7 px-3 text-[11px] gap-1.5">
                <Unlink className="h-3 w-3" />
                Disconnect
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={handleConnect} disabled={connecting} className="h-8 px-4 text-[13px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
              {connecting ? "Redirecting…" : "Connect Google Analytics"}
            </Button>
          )}
        </CardContent>
      </Card>

      {connected && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-white/85">Property</CardTitle>
            <CardDescription className="text-white/45 text-xs">
              Pick which GA4 property tracks this project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={selectedPropertyId} onValueChange={handleSelectProperty} disabled={savingProperty || properties.length === 0}>
              <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 text-[13px]">
                <SelectValue placeholder={properties.length === 0 ? "No properties found" : "Select a property"} />
              </SelectTrigger>
              <SelectContent>
                {properties.map((p) => (
                  <SelectItem key={p.propertyId} value={p.propertyId}>{p.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {connected && selectedPropertyId && (
        <>
          {reportError ? (
            <Card className="bg-workspace-surface border-white/[0.07]">
              <CardContent className="p-6">
                <p className="text-sm text-red-400">{(reportError as Error).message}</p>
              </CardContent>
            </Card>
          ) : reportLoading || !report ? (
            <SettingsSkeleton cards={1} />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatCard icon={<Users className="h-4 w-4" />} label="Users" value={report.totals.activeUsers} />
                <StatCard icon={<MousePointerClick className="h-4 w-4" />} label="Sessions" value={report.totals.sessions} />
                <StatCard icon={<Eye className="h-4 w-4" />} label="Pageviews" value={report.totals.pageviews} />
              </div>

              <Card className="bg-workspace-surface border-white/[0.07]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-white/85">Last 30 days</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={report.daily} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
                        <XAxis dataKey="date" tickFormatter={formatDate} stroke="rgba(255,255,255,0.45)" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} tickLine={false} axisLine={false} width={32} />
                        <Tooltip
                          labelFormatter={formatDate}
                          contentStyle={{ background: '#1a1a19', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: 'rgba(255,255,255,0.85)' }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} />
                        <Line type="monotone" dataKey="sessions" name="Sessions" stroke={SERIES_SESSIONS} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="pageviews" name="Pageviews" stroke={SERIES_PAGEVIEWS} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-2 gap-3">
                <TopList title="Top pages" rows={report.topPages.map((p) => ({ label: p.path, value: p.pageviews }))} />
                <TopList title="Top events" rows={report.topEvents.map((e) => ({ label: e.name, value: e.count }))} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card className="bg-workspace-surface border-white/[0.07]">
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-white/45 text-[11px] mb-1">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-semibold text-white/85">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function TopList({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  return (
    <Card className="bg-workspace-surface border-white/[0.07]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-white/85">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.length === 0 ? (
          <p className="text-xs text-white/40">No data yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-xs">
              <span className="text-white/60 truncate max-w-[70%]" title={r.label}>{r.label}</span>
              <span className="text-white/80 font-medium">{r.value.toLocaleString()}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
