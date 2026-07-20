import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshCw, CheckCircle2, AlertCircle, Upload, Loader2, Image } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { revisionService } from "@/services/revisionService";

// Truly site-wide settings   everything page-specific (title, description, OG,
// robots, structured data) lives per-route now, including for "/" itself. Only
// favicon and Google Search Console verification stay here since they genuinely
// apply to the whole site, not to any one page.
interface SiteData {
  favicon: string;
  google_verification: string;
}

const DEFAULTS: SiteData = { favicon: "", google_verification: "" };

export function SiteSettingsEditor({ projectId }: { projectId?: string }) {
  const [data, setData] = useState<SiteData>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saved' | 'synced' | 'live' | 'error'>('idle');
  const [requiresRepublish, setRequiresRepublish] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);

  const { data: loaded, isLoading: loading } = useQuery({
    queryKey: ["site-settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data: seoData } = await supabase
        .from("project_settings")
        .select("setting_value")
        .eq("project_id", projectId!)
        .eq("setting_key", "seo")
        .maybeSingle();
      return seoData;
    },
  });

  // Only hydrate once   a background refetch (e.g. refetchOnWindowFocus)
  // landing mid-edit would otherwise overwrite an in-progress edit with the
  // pre-edit DB row before the autosave debounce has committed.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !loaded) return;
    const saved = (loaded.setting_value as Partial<SiteData>) ?? {};
    setData({ favicon: saved.favicon ?? "", google_verification: saved.google_verification ?? "" });
    hydrated.current = true;
  }, [loaded]);

  const saveToDb = useCallback(async (next: SiteData) => {
    if (!projectId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("project_settings")
        .upsert({ project_id: projectId, setting_key: "seo", setting_value: next }, { onConflict: "project_id,setting_key" });
      if (error) throw error;
      setSyncStatus('saved');
      setTimeout(() => setSyncStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e: any) {
      toast.error("Failed to save: " + (e?.message ?? "unknown error"));
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const setValue = (key: keyof SiteData, value: string) => {
    const next = { ...data, [key]: value };
    setData(next);
    setSyncStatus('idle');
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => saveToDb(next), 800);
  };

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Blur/close/hard-refresh flush   see HeaderIntegrationsSettings for why:
  // without this, an edit sitting in the 800ms debounce window is lost if
  // the user navigates away or refreshes before it fires.
  const flushSave = () => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
      saveToDb(dataRef.current);
    }
  };

  useEffect(() => {
    const handler = () => { if (autoSaveTimer.current) saveToDb(dataRef.current); };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      if (autoSaveTimer.current) saveToDb(dataRef.current);
    };
  }, [saveToDb]);

  const handleFaviconUpload = async (file: File) => {
    if (!projectId) return;
    setUploadingFavicon(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${projectId}/favicon-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("project-assets").upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: pub } = supabase.storage.from("project-assets").getPublicUrl(path);
      setValue("favicon", pub.publicUrl);
      toast.success("Favicon uploaded");
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploadingFavicon(false);
    }
  };

  const handleSync = async () => {
    if (!projectId) return;
    setSyncing(true);
    try {
      await supabase.from("project_settings").upsert(
        { project_id: projectId, setting_key: "seo", setting_value: data },
        { onConflict: "project_id,setting_key" }
      );
      const revisions = await revisionService.getRevisions(projectId, 1, 0);
      const latest = revisions[0];
      if (!latest) throw new Error("No revisions found   generate the project first.");
      const files = await revisionService.getRevisionFilesForExport(projectId, latest.id);
      const indexHtml = files.find((f) => f.path === "index.html")?.content;
      if (!indexHtml) throw new Error("index.html not found in the latest revision.");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/sync`), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ indexHtml }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const isLive = json.productionDeployed === true;
      setSyncStatus(isLive ? 'live' : 'synced');
      setRequiresRepublish(json.requiresRepublish === true);
      toast.success(json.message ?? "Synced to site");
      setTimeout(() => setSyncStatus('idle'), 6000);
    } catch (e: any) {
      setSyncStatus('error');
      toast.error(e.message ?? "Sync failed");
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <p className="text-white/30 text-sm">Loading…</p>;

  return (
    <div className="space-y-4 max-w-xl">
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-white/85">Favicon</CardTitle>
          <CardDescription className="text-white/45 text-xs">Shown in browser tabs and bookmarks   applies site-wide.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="flex gap-2 items-center">
            {data.favicon && (
              <img src={data.favicon} alt="" className="h-6 w-6 rounded object-contain shrink-0 border border-white/[0.07]"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            )}
            <Input value={data.favicon} onChange={(e) => setValue("favicon", e.target.value)} onBlur={flushSave}
              placeholder="https://example.com/favicon.ico or upload below"
              className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px] flex-1" />
            <input ref={faviconInputRef} type="file" accept="image/png,image/x-icon,image/jpeg,image/webp" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFaviconUpload(f); e.target.value = ""; }} />
            <Button type="button" size="sm" variant="outline" disabled={uploadingFavicon || !projectId}
              onClick={() => faviconInputRef.current?.click()} className="h-8 px-2.5 shrink-0">
              {uploadingFavicon ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="text-[11px] text-white/30">.ico or .png, 32×32px recommended</p>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Image className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Google Verification</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">Verify site ownership with Google Search Console</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label className="text-white/60 text-xs">Verification Meta Tag Content</Label>
          <Input value={data.google_verification} onChange={(e) => setValue("google_verification", e.target.value)} onBlur={flushSave}
            placeholder="abc123xyz (content= value only)"
            className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          <p className="text-[11px] text-white/30">
            In Search Console → "HTML tag" verification → paste only the <code className="bg-white/[0.05] px-1 rounded">content=</code> value
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          {syncStatus === 'saved' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Auto-saved</span>}
          {syncStatus === 'live' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Live on site</span>}
          {syncStatus === 'synced' && <span className="flex items-center gap-1 text-amber-400"><CheckCircle2 className="h-3 w-3" />Saved   re-publish to go live</span>}
          {syncStatus === 'error' && <span className="flex items-center gap-1 text-red-400"><AlertCircle className="h-3 w-3" />Sync failed</span>}
          {(syncStatus === 'idle' || saving) && <span className="text-white/30">{saving ? 'Saving…' : 'Changes auto-save'}</span>}
        </div>
        <Button size="sm" onClick={handleSync} disabled={syncing} className="h-7 px-3 text-[11px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
          <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync to Site'}
        </Button>
      </div>

      {requiresRepublish && syncStatus !== 'idle' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-300">
            <p className="font-semibold">Saved   re-publish to go live.</p>
            <p className="text-amber-400/80 mt-0.5">Click <strong>Publish</strong> in the editor toolbar to rebuild and deploy.</p>
          </div>
        </div>
      )}
    </div>
  );
}
