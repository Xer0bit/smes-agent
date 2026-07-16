import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Loader2, Search } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { supabase } from "@/integrations/supabase/client";

interface RouteSeoData {
  title: string;
  description: string;
  keywords: string;
  robots: string;
  og_title: string;
  og_description: string;
  og_image: string;
  canonical_url: string;
  structured_data_type: string;
  structured_data: Record<string, string>;
}

const DEFAULTS: RouteSeoData = {
  title: "", description: "", keywords: "", robots: "index, follow",
  og_title: "", og_description: "", og_image: "", canonical_url: "",
  structured_data_type: "WebSite", structured_data: {},
};

const STRUCTURED_DATA_TYPES = ["WebSite", "Product", "Article", "LocalBusiness", "Organization", "BreadcrumbList"];

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
}

export function RouteSeoEditor({
  projectId, routePath, onSaved,
}: {
  projectId?: string;
  routePath: string;
  onSaved?: () => void;
}) {
  const [data, setData] = useState<RouteSeoData>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ["seo-route", projectId, routePath],
    enabled: !!projectId,
    queryFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/routes`), { headers });
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      return (json.routes ?? []).find((r: { route_path: string }) => r.route_path === routePath) ?? null;
    },
  });

  useEffect(() => {
    if (existing) {
      setData({
        title: existing.title ?? "",
        description: existing.description ?? "",
        keywords: existing.keywords ?? "",
        robots: existing.robots ?? "index, follow",
        og_title: existing.og_title ?? "",
        og_description: existing.og_description ?? "",
        og_image: existing.og_image ?? "",
        canonical_url: existing.canonical_url ?? "",
        structured_data_type: existing.structured_data_type ?? "WebSite",
        structured_data: existing.structured_data ?? {},
      });
    } else {
      setData(DEFAULTS);
    }
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async (payload: RouteSeoData) => {
      const headers = await authHeaders();
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/routes`), {
        method: "PUT",
        headers,
        body: JSON.stringify({ route_path: routePath, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      return json.route;
    },
    onSuccess: () => { toast.success(`SEO saved for ${routePath}`); onSaved?.(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSave = async () => {
    setSaving(true);
    try { await saveMutation.mutateAsync(data); } finally { setSaving(false); }
  };

  const setField = <K extends keyof RouteSeoData>(key: K, value: RouteSeoData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const structuredEntries = Object.entries(data.structured_data);

  if (isLoading) return <p className="text-white/30 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <code className="text-[13px] text-indigo-300 font-mono">{routePath}</code>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 px-3 text-[12px] bg-indigo-600 hover:bg-indigo-500">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>

      <Tabs defaultValue="basic">
        <TabsList className="bg-workspace-surface border border-white/[0.07]">
          <TabsTrigger value="basic" className="text-[12px]">Basic</TabsTrigger>
          <TabsTrigger value="social" className="text-[12px]">Social</TabsTrigger>
          <TabsTrigger value="advanced" className="text-[12px]">Advanced</TabsTrigger>
          <TabsTrigger value="structured" className="text-[12px]">Structured Data</TabsTrigger>
          <TabsTrigger value="preview" className="text-[12px]">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-4 pt-4">
          <Field label="Title" value={data.title} onChange={(v) => setField("title", v)} maxLength={60} placeholder="Page title" />
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Description</Label>
            <Textarea value={data.description} onChange={(e) => setField("description", e.target.value)} rows={3} maxLength={160}
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 text-[13px] resize-none" />
          </div>
          <Field label="Keywords" value={data.keywords} onChange={(v) => setField("keywords", v)} placeholder="comma, separated" />
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Search Visibility</Label>
            <Select value={data.robots} onValueChange={(v) => setField("robots", v)}>
              <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="index, follow">Index, Follow</SelectItem>
                <SelectItem value="noindex, follow">No Index, Follow</SelectItem>
                <SelectItem value="index, nofollow">Index, No Follow</SelectItem>
                <SelectItem value="noindex, nofollow">No Index, No Follow</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TabsContent>

        <TabsContent value="social" className="space-y-4 pt-4">
          <Field label="Social Title" value={data.og_title} onChange={(v) => setField("og_title", v)} placeholder={data.title || "Falls back to Title"} />
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Social Description</Label>
            <Textarea value={data.og_description} onChange={(e) => setField("og_description", e.target.value)} rows={2}
              placeholder={data.description || "Falls back to Description"}
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 text-[13px] resize-none" />
          </div>
          <Field label="Social Image URL" value={data.og_image} onChange={(v) => setField("og_image", v)} placeholder="https://…" />
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-4">
          <Field label="Canonical URL" value={data.canonical_url} onChange={(v) => setField("canonical_url", v)}
            placeholder="Leave blank to use this page's own URL" />
        </TabsContent>

        <TabsContent value="structured" className="space-y-4 pt-4">
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Schema Type</Label>
            <Select value={data.structured_data_type} onValueChange={(v) => setField("structured_data_type", v)}>
              <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STRUCTURED_DATA_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-white/60 text-xs">
              Extra fields {data.structured_data_type === "Product" && "(e.g. price, availability, sku)"}
            </Label>
            {structuredEntries.map(([key, value], i) => (
              <div key={i} className="flex gap-2">
                <Input value={key} placeholder="key" className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px] w-[140px]"
                  onChange={(e) => {
                    const entries = [...structuredEntries];
                    entries[i] = [e.target.value, value];
                    setField("structured_data", Object.fromEntries(entries));
                  }} />
                <Input value={value} placeholder="value" className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px] flex-1"
                  onChange={(e) => {
                    const entries = [...structuredEntries];
                    entries[i] = [key, e.target.value];
                    setField("structured_data", Object.fromEntries(entries));
                  }} />
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-white/30 hover:text-red-400 shrink-0"
                  onClick={() => {
                    const entries = structuredEntries.filter((_, idx) => idx !== i);
                    setField("structured_data", Object.fromEntries(entries));
                  }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" className="h-8 px-3 text-[12px] gap-1.5 border-white/[0.07]"
              onClick={() => setField("structured_data", { ...data.structured_data, "": "" })}>
              <Plus className="h-3.5 w-3.5" /> Add field
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="preview" className="pt-4">
          <div className="rounded-2xl bg-[#f1f3f4] p-3 select-none">
            <div className="flex items-center gap-2 mb-3 px-1">
              <Search className="h-4 w-4 text-gray-400" />
              <span className="text-[12px] text-gray-500">Search preview</span>
            </div>
            <div className="bg-white rounded-xl px-4 py-3 shadow-sm">
              <p className="text-[12px] text-[#4d5156]">{routePath}</p>
              <p className="text-[20px] leading-[1.3] mt-1 truncate" style={{ color: '#1558d6' }}>{data.title || "Page Title"}</p>
              <p className="text-[14px] leading-[1.57] mt-1 line-clamp-2" style={{ color: '#4d5156' }}>
                {data.description || "Page description will appear here."}
              </p>
            </div>
          </div>
          {data.og_image && (
            <div className="rounded-xl overflow-hidden border border-gray-200 bg-white shadow-sm mt-3">
              <img src={data.og_image} alt="" className="w-full h-36 object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              <div className="px-3 py-2 border-t border-gray-100">
                <p className="text-[13px] font-semibold text-gray-900 truncate">{data.og_title || data.title}</p>
                <p className="text-[12px] text-gray-500 line-clamp-2">{data.og_description || data.description}</p>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-white/60 text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength}
        className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
    </div>
  );
}
