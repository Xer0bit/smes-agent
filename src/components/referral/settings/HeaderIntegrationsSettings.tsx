import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { lovableCloud } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BarChart3, MessageCircle, Code2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { revisionService } from "@/services/revisionService";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface HeaderIntegrationsData {
  ga_measurement_id: string;
  gtm_container_id: string;
  meta_pixel_id: string;
  whatsapp_number: string;
  whatsapp_message: string;
  custom_head_code: string;
  custom_body_code: string;
}

const DEFAULT_DATA: HeaderIntegrationsData = {
  ga_measurement_id: "",
  gtm_container_id: "",
  meta_pixel_id: "",
  whatsapp_number: "",
  whatsapp_message: "",
  custom_head_code: "",
  custom_body_code: "",
};

interface HeaderIntegrationsSettingsProps {
  projectId?: string;
}

export const HeaderIntegrationsSettings = ({ projectId }: HeaderIntegrationsSettingsProps) => {
  const [data, setData] = useState<HeaderIntegrationsData>(DEFAULT_DATA);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saved' | 'synced' | 'live' | 'error'>('idle');
  const [requiresRepublish, setRequiresRepublish] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: row, isLoading: loading } = useQuery({
    queryKey: ["header-integrations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("setting_value")
        .eq("project_id", projectId!)
        .eq("setting_key", "header_integrations")
        .maybeSingle();
      return data;
    },
  });

  // Only hydrate from the server once — react-query's background refetches
  // (e.g. refetchOnWindowFocus) would otherwise land mid-edit and stomp
  // whatever the user just typed with the pre-edit DB row.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    if (row?.setting_value) {
      setData({ ...DEFAULT_DATA, ...(row.setting_value as Partial<HeaderIntegrationsData>) });
      hydrated.current = true;
    }
  }, [row]);

  const saveToDb = useCallback(async (next: HeaderIntegrationsData) => {
    if (!projectId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("project_settings")
        .upsert(
          { project_id: projectId, setting_key: "header_integrations", setting_value: next, updated_at: new Date().toISOString() },
          { onConflict: "project_id,setting_key" }
        );
      if (error) throw error;
      setSyncStatus('saved');
      setTimeout(() => setSyncStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch (e: any) {
      toast.error("Failed to save integrations: " + (e?.message ?? "unknown error"));
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  const set = (key: keyof HeaderIntegrationsData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = { ...data, [key]: e.target.value };
    setData(next);
    setSyncStatus('idle');
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => saveToDb(next), 800);
  };

  // Blur (tab to next field, click away, close the settings panel) fires
  // before most refresh/close paths — flushing here means a debounced edit
  // isn't still sitting unsaved in the 800ms window when the page reloads.
  const flushSave = () => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
      saveToDb(dataRef.current);
    }
  };

  // Covers the hard-refresh/close-tab case blur can't catch (e.g. hitting
  // Ctrl+R while still focused in the field).
  useEffect(() => {
    const handler = () => { if (autoSaveTimer.current) saveToDb(dataRef.current); };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      if (autoSaveTimer.current) saveToDb(dataRef.current);
    };
  }, [saveToDb]);

  const handleSync = useCallback(async () => {
    if (!projectId) return;
    setSyncing(true);
    try {
      await supabase
        .from("project_settings")
        .upsert(
          { project_id: projectId, setting_key: "header_integrations", setting_value: data },
          { onConflict: "project_id,setting_key" }
        );
      const revisions = await revisionService.getRevisions(projectId, 1, 0);
      const latest = revisions[0];
      if (!latest) throw new Error("No revisions found — generate the project first.");
      const files = await revisionService.getRevisionFilesForExport(projectId, latest.id);
      const indexHtml = files.find(f => f.path === "index.html")?.content;
      if (!indexHtml) throw new Error("index.html not found in the latest revision.");

      const { data: { session } } = await lovableCloud.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(getApiServerUrl(`/api/v1/header-integrations/${projectId}/sync`), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ indexHtml }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const isLive = json.productionDeployed === true;
      setSyncStatus(isLive ? 'live' : 'synced');
      setRequiresRepublish(json.requiresRepublish === true);
      toast.success(json.message ?? "Integrations synced to site");
      setTimeout(() => setSyncStatus('idle'), 6000);
    } catch (e: any) {
      setSyncStatus('error');
      toast.error(e.message ?? "Sync failed");
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSyncing(false);
    }
  }, [projectId, data]);

  if (loading) return <SettingsSkeleton cards={3} />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Header Integrations</h2>
        <p className="text-sm text-white/45">Analytics, pixels, and custom scripts injected into your published site.</p>
      </div>

      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          {syncStatus === 'saved' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Auto-saved</span>}
          {syncStatus === 'live' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Live on site</span>}
          {syncStatus === 'synced' && <span className="flex items-center gap-1 text-amber-400"><CheckCircle2 className="h-3 w-3" />Saved — re-publish to go live</span>}
          {syncStatus === 'error' && <span className="flex items-center gap-1 text-red-400"><AlertCircle className="h-3 w-3" />Sync failed</span>}
          {(syncStatus === 'idle' || saving) && <span className="text-white/30">{saving ? 'Saving…' : 'Changes auto-save'}</span>}
        </div>
        <Button
          size="sm"
          onClick={handleSync}
          disabled={syncing}
          className="h-7 px-3 text-[11px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync to Site'}
        </Button>
      </div>

      {/* ── Analytics & Pixels ──────────────────────────────── */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Analytics &amp; Ad Pixels</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">Google Analytics, Google Tag Manager, Meta Pixel</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ga-id" className="text-white/60 text-xs">Google Analytics — Measurement ID</Label>
            <Input id="ga-id" value={data.ga_measurement_id} onChange={set("ga_measurement_id")} onBlur={flushSave}
              placeholder="G-XXXXXXXXXX"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gtm-id" className="text-white/60 text-xs">Google Tag Manager — Container ID</Label>
            <Input id="gtm-id" value={data.gtm_container_id} onChange={set("gtm_container_id")} onBlur={flushSave}
              placeholder="GTM-XXXXXXX"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pixel-id" className="text-white/60 text-xs">Meta (Facebook) Pixel ID</Label>
            <Input id="pixel-id" value={data.meta_pixel_id} onChange={set("meta_pixel_id")} onBlur={flushSave}
              placeholder="123456789012345"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>
        </CardContent>
      </Card>

      {/* ── WhatsApp ─────────────────────────────────────────── */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-emerald-400" />
            <CardTitle className="text-base text-white/85">WhatsApp Chat Button</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">Adds a floating WhatsApp button to every page</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wa-number" className="text-white/60 text-xs">WhatsApp Number (with country code)</Label>
            <Input id="wa-number" value={data.whatsapp_number} onChange={set("whatsapp_number")} onBlur={flushSave}
              placeholder="15551234567"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
            <p className="text-[11px] text-white/30">Digits only, no + or spaces. Leave blank to hide the button.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wa-message" className="text-white/60 text-xs">Pre-filled Message</Label>
            <Input id="wa-message" value={data.whatsapp_message} onChange={set("whatsapp_message")} onBlur={flushSave}
              placeholder="Hi! I have a question."
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>
        </CardContent>
      </Card>

      {/* ── Custom Code ──────────────────────────────────────── */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Custom Scripts</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">Raw HTML/JS for anything not covered above</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="head-code" className="text-white/60 text-xs">Head Code</Label>
            <Textarea id="head-code" value={data.custom_head_code} onChange={set("custom_head_code")} onBlur={flushSave} rows={4}
              placeholder="<script>...</script>"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 text-[13px] font-mono resize-none" />
            <p className="text-[11px] text-white/30">Injected just before &lt;/head&gt; on every page</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="body-code" className="text-white/60 text-xs">Body Code (Footer)</Label>
            <Textarea id="body-code" value={data.custom_body_code} onChange={set("custom_body_code")} onBlur={flushSave} rows={4}
              placeholder="<script>...</script>"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 text-[13px] font-mono resize-none" />
            <p className="text-[11px] text-white/30">Injected just before &lt;/body&gt; on every page</p>
          </div>
        </CardContent>
      </Card>

      {requiresRepublish && syncStatus !== 'idle' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-300">
            <p className="font-semibold">Integrations saved — re-publish to go live.</p>
            <p className="text-amber-400/80 mt-0.5">Click <strong>Publish</strong> in the editor toolbar to rebuild and deploy with the new scripts.</p>
          </div>
        </div>
      )}
    </div>
  );
};
