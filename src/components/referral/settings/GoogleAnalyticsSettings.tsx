/* Hallmark · redesign: in-place, existing workspace-surface token system preserved
 * component: settings-panel · states: loading · disconnected · connected-no-property ·
 * connected-with-data · error · pre-emit critique: P4 H4 E4 S4 R4 V4
 */
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Unlink, Users, Eye, MousePointerClick, FileText, MousePointer2 } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";
import { GoogleAnalyticsIcon } from "@/components/icons/GoogleAnalyticsIcon";

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

const DAY_RANGES = [7, 30, 90] as const;

// Reference-palette categorical slots 1 (blue) + 2 (green), dark-surface steps,
// in their validated adjacent order — this panel is always on the dark
// workspace surface, so no light-mode variant is needed.
const SERIES_SESSIONS = "#3987e5";
const SERIES_PAGEVIEWS = "#008300";

const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

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
  const [days, setDays] = useState<typeof DAY_RANGES[number]>(30);

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
    queryKey: ["ga-report", projectId, days],
    enabled: !!projectId && !!selectedPropertyId,
    queryFn: () => authedFetch(`/${projectId}/report?days=${days}`) as Promise<GaReport>,
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
      {!connected ? (
        <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
          <Card className="bg-workspace-surface border-white/[0.07]">
            <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] border border-white/[0.07]">
                <GoogleAnalyticsIcon className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-white/85">Connect Google Analytics</p>
                <p className="text-xs text-white/40 max-w-xs">
                  Sign in with Google to pick a GA4 property and see sessions, pageviews, and top content right here.
                </p>
              </div>
              <Button size="sm" onClick={handleConnect} disabled={connecting} className="h-8 px-4 text-[13px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
                <GoogleAnalyticsIcon className="h-4 w-4" />
                {connecting ? "Redirecting…" : "Connect Google Analytics"}
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <motion.div {...fadeUp} transition={{ duration: 0.3 }}>
          <Card className="bg-workspace-surface border-white/[0.07]">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <GoogleAnalyticsIcon className="h-5 w-5 shrink-0" />
                <span className="text-sm text-white/80 truncate">
                  Connected{status?.email ? <> as <strong className="text-white/90">{status.email}</strong></> : null}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedPropertyId} onValueChange={handleSelectProperty} disabled={savingProperty || properties.length === 0}>
                  <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 w-48 text-[13px]">
                    <SelectValue placeholder={properties.length === 0 ? "No properties found" : "Select a property"} />
                  </SelectTrigger>
                  <SelectContent>
                    {properties.map((p) => (
                      <SelectItem key={p.propertyId} value={p.propertyId}>{p.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="ghost" onClick={handleDisconnect} className="h-8 w-8 p-0 text-white/30 hover:text-white/70" title="Disconnect">
                  <Unlink className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
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
                {[
                  { icon: <Users className="h-4 w-4" />, label: "Users", value: report.totals.activeUsers },
                  { icon: <MousePointerClick className="h-4 w-4" />, label: "Sessions", value: report.totals.sessions },
                  { icon: <Eye className="h-4 w-4" />, label: "Pageviews", value: report.totals.pageviews },
                ].map((stat, i) => (
                  <motion.div key={stat.label} {...fadeUp} transition={{ duration: 0.3, delay: i * 0.05 }}>
                    <StatCard icon={stat.icon} label={stat.label} value={stat.value} />
                  </motion.div>
                ))}
              </div>

              <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.1 }}>
                <Card className="bg-workspace-surface border-white/[0.07]">
                  <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base text-white/85">Traffic — last {days} days</CardTitle>
                    <div className="flex items-center gap-0.5 rounded-md border border-white/[0.07] bg-workspace-surface-recessed p-0.5">
                      {DAY_RANGES.map((d) => (
                        <button
                          key={d}
                          onClick={() => setDays(d)}
                          className={cn(
                            "px-2 py-1 rounded text-[11px] transition-colors duration-smooth",
                            days === d ? "bg-indigo-500/15 text-white font-medium" : "text-white/35 hover:text-white/60"
                          )}
                        >
                          {d}d
                        </button>
                      ))}
                    </div>
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
              </motion.div>

              <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.15 }} className="grid grid-cols-2 gap-3">
                <TopList icon={<FileText className="h-3.5 w-3.5" />} title="Top pages" rows={report.topPages.map((p) => ({ label: p.path, value: p.pageviews }))} />
                <TopList icon={<MousePointer2 className="h-3.5 w-3.5" />} title="Top events" rows={report.topEvents.map((e) => ({ label: e.name, value: e.count }))} />
              </motion.div>
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
        <div className="flex items-center gap-2 mb-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-400">
            {icon}
          </div>
          <span className="text-white/45 text-[11px]">{label}</span>
        </div>
        <div className="text-2xl font-semibold text-white/85 tabular-nums">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function TopList({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <Card className="bg-workspace-surface border-white/[0.07]">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-white/60">
          {icon}
          <CardTitle className="text-sm text-white/85">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-white/40">No data yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.label} className="relative overflow-hidden rounded">
              <div
                className="absolute inset-y-0 left-0 bg-indigo-500/10"
                style={{ width: `${Math.max(4, (r.value / max) * 100)}%` }}
              />
              <div className="relative flex items-center justify-between gap-2 px-1.5 py-1 text-xs">
                <span className="text-white/60 truncate max-w-[70%]" title={r.label}>{r.label}</span>
                <span className="text-white/80 font-medium tabular-nums">{r.value.toLocaleString()}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
