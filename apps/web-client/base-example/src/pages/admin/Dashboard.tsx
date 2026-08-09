import { useMemo } from "react";
import { Newspaper, Share2, Users, Image, Clock, TrendingUp, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useClientContext } from "@/hooks/useClientContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { formatDistanceToNow, subDays, isAfter } from "date-fns";

interface SheetConfig {
  type: "google_sheet";
  sheet_url: string;
  col_start: string;
  col_end: string;
}

function parseSheetConfig(webhook_url: string | null): SheetConfig | null {
  if (!webhook_url) return null;
  try {
    const cfg = JSON.parse(webhook_url);
    if (cfg.type === "google_sheet") return cfg as SheetConfig;
  } catch {}
  return null;
}

function extractSheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : url;
}

const STATUS_COLORS = {
  draft: "hsl(230, 15%, 45%)",
  scheduled: "hsl(45, 90%, 50%)",
  published: "hsl(142, 60%, 40%)",
  failed: "hsl(0, 84%, 60%)",
};

const Dashboard = () => {
  const navigate = useNavigate();
  const { clientId, clients } = useClientContext();
  const clientName = clients.find((c) => c.id === clientId)?.name;

  // Press Releases
  const { data: pressReleases = [], isLoading: prLoading } = useQuery({
    queryKey: ["dashboard-pr", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("press_releases")
        .select("id, title, status, total_visits, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!clientId,
  });

  // Social Media Posts
  const { data: socialPosts = [], isLoading: socialLoading } = useQuery({
    queryKey: ["dashboard-social", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("social_media_posts")
        .select("id, content, status, platforms, scheduled_at, published_at, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!clientId,
  });

  // Leads + Forms
  const { data: leads = [], isLoading: leadsLoading } = useQuery({
    queryKey: ["dashboard-leads", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("leads")
        .select("id, created_at, lead_form_id")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!clientId,
  });

  const { data: leadForms = [] } = useQuery({
    queryKey: ["dashboard-lead-forms", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("lead_forms")
        .select("id, form_name, webhook_url")
        .eq("client_id", clientId);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!clientId,
  });

  // Google Sheet row counts for forms with sheet config
  const sheetForms = useMemo(() => (leadForms as any[]).filter((f: any) => parseSheetConfig(f.webhook_url)), [leadForms]);

  const { data: sheetData = {}, isLoading: sheetLoading } = useQuery({
    queryKey: ["dashboard-sheet-leads", clientId, sheetForms.map((f: any) => f.id).join(",")],
    queryFn: async () => {
      const results: Record<string, number> = {};
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      await Promise.all(sheetForms.map(async (form: any) => {
        const cfg = parseSheetConfig(form.webhook_url)!;
        try {
          const res = await fetch(`https://${projectId}.supabase.co/functions/v1/fetch-google-sheet`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              sheet_id: extractSheetId(cfg.sheet_url),
              col_start: cfg.col_start,
              col_end: cfg.col_end,
            }),
          });
          const data = await res.json();
          if (data.ok && data.rows) {
            results[form.id] = data.rows.length;
          }
        } catch {}
      }));
      return results;
    },
    enabled: sheetForms.length > 0,
    staleTime: 60_000,
  });

  // Brand Assets
  const { data: brandAssets = [], isLoading: assetsLoading } = useQuery({
    queryKey: ["dashboard-assets", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("brand_assets")
        .select("id, updated_at")
        .eq("client_id", clientId)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!clientId,
  });

  const { data: assetCount = 0 } = useQuery({
    queryKey: ["dashboard-asset-count", clientId],
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from("brand_assets")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!clientId,
  });

  const loading = prLoading || socialLoading || leadsLoading || assetsLoading;

  // Total sheet leads count
  const totalSheetLeads = Object.values(sheetData).reduce((sum, count) => sum + count, 0);
  const totalLeads = leads.length + totalSheetLeads;

  // Derived stats
  const publishedPR = pressReleases.filter((p: any) => p.status === "published").length;
  const scheduledPosts = socialPosts.filter((p: any) => p.status === "scheduled").length;
  const weekAgo = subDays(new Date(), 7);
  const newLeadsThisWeek = leads.filter((l: any) => isAfter(new Date(l.created_at), weekAgo)).length;
  const lastAssetUpdate = brandAssets[0]?.updated_at
    ? formatDistanceToNow(new Date(brandAssets[0].updated_at), { addSuffix: true })
    : "—";

  // Chart data: top 5 PRs by visits
  const topPRs = [...pressReleases]
    .sort((a: any, b: any) => (b.total_visits ?? 0) - (a.total_visits ?? 0))
    .slice(0, 5)
    .map((pr: any) => ({
      name: pr.title?.length > 25 ? pr.title.slice(0, 25) + "…" : pr.title,
      visits: pr.total_visits ?? 0,
    }));

  // Chart data: social posts by status
  const socialStatusMap: Record<string, number> = {};
  socialPosts.forEach((p: any) => {
    socialStatusMap[p.status] = (socialStatusMap[p.status] || 0) + 1;
  });
  const socialByStatus = Object.keys(socialStatusMap).map((status) => ({
    status,
    count: socialStatusMap[status],
  }));

  // Chart data: leads by form (DB leads + Google Sheet leads)
  const formMap = new Map<string, string>(leadForms.map((f: any) => [f.id, f.form_name]));
  const leadsByFormMap: Record<string, number> = {};
  // Count DB leads per form
  leads.forEach((l: any) => {
    const name: string = formMap.get(l.lead_form_id) || "Unknown";
    leadsByFormMap[name] = (leadsByFormMap[name] || 0) + 1;
  });
  // Add Google Sheet row counts
  Object.entries(sheetData).forEach(([formId, count]) => {
    const name = formMap.get(formId) || "Sheet";
    leadsByFormMap[name] = (leadsByFormMap[name] || 0) + count;
  });
  const leadsByForm = Object.entries(leadsByFormMap).map(([form, count]) => ({ form, count }));
  // Recent activity feed
  const activities = [
    ...pressReleases.slice(0, 5).map((pr: any) => ({
      type: "pr" as const,
      icon: Newspaper,
      text: `PR "${pr.title?.slice(0, 30)}" — ${pr.status}`,
      date: new Date(pr.created_at),
    })),
    ...socialPosts.slice(0, 5).map((p: any) => ({
      type: "social" as const,
      icon: Share2,
      text: `${(p.platforms || []).join(", ")} post — ${p.status}`,
      date: new Date(p.created_at),
    })),
    ...leads.slice(0, 5).map((l: any) => ({
      type: "lead" as const,
      icon: Users,
      text: `New lead received`,
      date: new Date(l.created_at),
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 8);

  const statCards = [
    {
      title: "Press Releases",
      icon: Newspaper,
      count: pressReleases.length,
      sub: `${publishedPR} published`,
      href: "/admin/press",
    },
    {
      title: "Social Posts",
      icon: Share2,
      count: socialPosts.length,
      sub: `${scheduledPosts} scheduled`,
      href: "/admin/social",
    },
    {
      title: "Sales Leads",
      icon: Users,
      count: totalLeads,
      sub: `+${newLeadsThisWeek} this week`,
      href: "/admin/leads",
    },
    {
      title: "Brand Assets",
      icon: Image,
      count: assetCount,
      sub: `Last: ${lastAssetUpdate}`,
      href: "/admin/brand",
    },
  ];

  if (!clientId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Please select a client to view the dashboard.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="font-display text-2xl font-bold text-foreground">
          Welcome back{clientName ? `, ${clientName}` : ""}
        </h2>
        <p className="text-muted-foreground font-body text-sm">
          Manage your media campaigns from one place.
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) =>
          loading ? (
            <Skeleton key={card.title} className="h-[120px] rounded-xl" />
          ) : (
            <button
              key={card.title}
              onClick={() => navigate(card.href)}
              className="bg-card border border-border rounded-xl p-5 text-left hover:shadow-md transition-shadow group"
            >
              <div className="flex items-center justify-between mb-3">
                <card.icon className="h-6 w-6 text-primary" />
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-3xl font-display font-bold text-foreground">{card.count}</p>
              <p className="text-xs text-muted-foreground font-body mt-1">{card.title}</p>
              <p className="text-xs text-primary font-medium mt-0.5">{card.sub}</p>
            </button>
          )
        )}
      </div>

      {/* Row 2: Activity + Press Traffic */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-display flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" /> Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : activities.length === 0 ? (
              <p className="text-muted-foreground text-sm">No recent activity.</p>
            ) : (
              <div className="space-y-3">
                {activities.map((a, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <a.icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-foreground truncate">{a.text}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(a.date, { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Press Traffic */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-display flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Press Traffic (Top 5)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[200px]" />
            ) : topPRs.length === 0 ? (
              <p className="text-muted-foreground text-sm">No press release data yet.</p>
            ) : (
              <ChartContainer config={{ visits: { label: "Visits", color: "hsl(var(--primary))" } }} className="h-[200px]">
                <BarChart data={topPRs} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="visits" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Social donut + Leads by Form */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Social by Status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-display flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" /> Social Posts by Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[200px]" />
            ) : socialByStatus.length === 0 ? (
              <p className="text-muted-foreground text-sm">No social posts yet.</p>
            ) : (
              <div className="flex items-center gap-6">
                <ChartContainer
                  config={Object.fromEntries(
                    socialByStatus.map((s) => [s.status, { label: s.status, color: STATUS_COLORS[s.status as keyof typeof STATUS_COLORS] || "hsl(var(--muted))" }])
                  )}
                  className="h-[200px] w-[200px]"
                >
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent nameKey="status" />} />
                    <Pie data={socialByStatus} dataKey="count" nameKey="status" innerRadius={50} outerRadius={80}>
                      {socialByStatus.map((s) => (
                        <Cell
                          key={s.status}
                          fill={STATUS_COLORS[s.status as keyof typeof STATUS_COLORS] || "hsl(var(--muted))"}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="space-y-2">
                  {socialByStatus.map((s) => (
                    <div key={s.status} className="flex items-center gap-2 text-sm">
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: STATUS_COLORS[s.status as keyof typeof STATUS_COLORS] || "hsl(var(--muted))" }}
                      />
                      <span className="capitalize text-foreground">{s.status}</span>
                      <span className="text-muted-foreground ml-auto">{s.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Leads by Form */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-display flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" /> Leads by Form
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[200px]" />
            ) : leadsByForm.length === 0 ? (
              <p className="text-muted-foreground text-sm">No leads yet.</p>
            ) : (
              <ChartContainer
                config={Object.fromEntries(
                  leadsByForm.map((l, i) => [l.form, { label: l.form, color: i === 0 ? "hsl(var(--primary))" : `hsl(${200 + i * 40}, 60%, 50%)` }])
                )}
                className="h-[200px]"
              >
                <BarChart data={leadsByForm} margin={{ left: 10, right: 10 }}>
                  <XAxis dataKey="form" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis hide />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Dashboard;
