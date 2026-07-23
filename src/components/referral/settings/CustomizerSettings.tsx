import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Palette, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface CustomizerConfig {
  appName: string;
  logoUrl: string;
  layout: "sidebar" | "topnav" | "minimal";
  theme: string;
  accentColor: string;
  fontFamily: string;
  showSummaryCards: boolean;
}

const DEFAULT_CONFIG: CustomizerConfig = {
  appName: "",
  logoUrl: "",
  layout: "sidebar",
  theme: "light",
  accentColor: "#2563eb",
  fontFamily: "Inter",
  showSummaryCards: true,
};

const THEMES = ["light", "dark", "ocean", "forest", "sunset", "slate"];

interface CustomizerSettingsProps {
  projectId?: string;
}

export const CustomizerSettings = ({ projectId }: CustomizerSettingsProps) => {
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [config, setConfig] = useState<CustomizerConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");
        const res = await fetch(getApiServerUrl(`/api/v1/ecg-connect/${projectId}/customize`), {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.status === 404) { setNotFound(true); return; }
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load");
        setConfig({ ...DEFAULT_CONFIG, ...(json.config ?? {}) });
      } catch (e: any) {
        toast.error(e?.message ?? "Failed to load customizer config");
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  const set = <K extends keyof CustomizerConfig>(key: K) => (value: CustomizerConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSyncStatus("idle");
  };

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(getApiServerUrl(`/api/v1/ecg-connect/${projectId}/customize`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ config }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setSyncStatus("saved");
      toast.success("Customizer changes synced to your live preview");
      setTimeout(() => setSyncStatus("idle"), 4000);
    } catch (e: any) {
      setSyncStatus("error");
      toast.error(e?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <SettingsSkeleton cards={2} />;

  if (notFound) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-white/85">eCG Customizer</h2>
        <p className="text-sm text-white/45">
          This project wasn't created via eCG Agent connect, so there's no dashboard
          config to customize here. Attach an eCG Agent from the eCG Agents dashboard
          page first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between px-0.5">
        <div>
          <h2 className="text-xl font-semibold text-white/85 mb-1">eCG Customizer</h2>
          <p className="text-sm text-white/45">
            Branding and layout for the eCG Agent dashboard seeded into this project.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {syncStatus === "saved" && <span className="flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle2 className="h-3 w-3" />Synced</span>}
          {syncStatus === "error" && <span className="flex items-center gap-1 text-[11px] text-red-400"><AlertCircle className="h-3 w-3" />Failed</span>}
          <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 px-4 text-[13px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
            <RefreshCw className={`h-3 w-3 ${saving ? "animate-spin" : ""}`} />
            {saving ? "Saving…" : "Save & Sync"}
          </Button>
        </div>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Branding</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">App name and logo shown in the dashboard header.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">App name</Label>
            <Input value={config.appName} onChange={(e) => set("appName")(e.target.value)}
              placeholder="Your Company Dashboard"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Logo URL</Label>
            <Input value={config.logoUrl} onChange={(e) => set("logoUrl")(e.target.value)}
              placeholder="https://…/logo.png"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-white/85">Layout & Theme</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Layout</Label>
              <Select value={config.layout} onValueChange={(v) => set("layout")(v as CustomizerConfig["layout"])}>
                <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sidebar">Sidebar</SelectItem>
                  <SelectItem value="topnav">Top nav</SelectItem>
                  <SelectItem value="minimal">Minimal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Theme preset</Label>
              <Select value={config.theme} onValueChange={(v) => set("theme")(v)}>
                <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px] capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {THEMES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Accent color</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={config.accentColor} onChange={(e) => set("accentColor")(e.target.value)}
                  className="h-8 w-8 rounded border border-white/[0.07] bg-workspace-surface-recessed" />
                <Input value={config.accentColor} onChange={(e) => set("accentColor")(e.target.value)}
                  className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px]" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Font family</Label>
              <Input value={config.fontFamily} onChange={(e) => set("fontFamily")(e.target.value)}
                className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px]" />
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <Label className="text-white/60 text-xs">Show summary cards</Label>
            <Switch checked={config.showSummaryCards} onCheckedChange={(v) => set("showSummaryCards")(v)} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
