import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovableCloud } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Share2, Image, RefreshCw, CheckCircle2, AlertCircle, MoreVertical } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";

interface SeoData {
  title: string;
  description: string;
  keywords: string;
  favicon: string;
  og_title: string;
  og_description: string;
  og_image: string;
  robots: string;
  google_verification: string;
}

const DEFAULT_SEO: SeoData = {
  title: "",
  description: "",
  keywords: "",
  favicon: "",
  og_title: "",
  og_description: "",
  og_image: "",
  robots: "index, follow",
  google_verification: "",
};

interface SeoSettingsProps {
  projectId?: string;
}

export const SeoSettings = ({ projectId }: SeoSettingsProps) => {
  const [seo, setSeo] = useState<SeoData>(DEFAULT_SEO);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saved' | 'synced' | 'live' | 'error'>('idle');
  const [requiresRepublish, setRequiresRepublish] = useState(false);
  const [loading, setLoading] = useState(true);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    const load = async () => {
      setLoading(true);
      const [{ data: seoData }, { data: proj }] = await Promise.all([
        supabase
          .from("project_settings")
          .select("setting_value")
          .eq("project_id", projectId)
          .eq("setting_key", "seo")
          .maybeSingle(),
        supabase
          .from("projects")
          .select("name, slug, description, published_subdomain, published_url")
          .eq("id", projectId)
          .single(),
      ]);

      const name = proj?.name ?? "";
      const slug = proj?.published_subdomain || proj?.slug || "";
      setProjectName(name);
      setProjectSlug(slug);

      if (seoData?.setting_value) {
        const saved = seoData.setting_value as Partial<SeoData>;
        setSeo({
          ...DEFAULT_SEO,
          title: saved.title || name,
          description: saved.description || proj?.description || "",
          ...saved,
          title: saved.title || name,
          description: saved.description || proj?.description || "",
        });
      } else {
        setSeo({ ...DEFAULT_SEO, title: name, description: proj?.description || "" });
      }
      setLoading(false);
    };
    load();
  }, [projectId]);

  const saveToDb = useCallback(async (data: SeoData) => {
    if (!projectId) return;
    setSaving(true);
    try {
      // Check if a row already exists (table may not have the unique constraint yet)
      const { data: existing } = await supabase
        .from("project_settings")
        .select("id")
        .eq("project_id", projectId)
        .eq("setting_key", "seo")
        .maybeSingle();

      const { error } = existing
        ? await supabase
            .from("project_settings")
            .update({ setting_value: data, updated_at: new Date().toISOString() })
            .eq("id", existing.id)
        : await supabase
            .from("project_settings")
            .insert({ project_id: projectId, setting_key: "seo", setting_value: data });

      if (error) throw error;
      setSyncStatus('saved');
      setTimeout(() => setSyncStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch (e: any) {
      toast.error("Failed to save SEO settings: " + (e?.message ?? "unknown error"));
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const set = (key: keyof SeoData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = { ...seo, [key]: e.target.value };
    setSeo(next);
    setSyncStatus('idle');
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => saveToDb(next), 800);
  };

  const setSelect = (key: keyof SeoData) => (value: string) => {
    const next = { ...seo, [key]: value };
    setSeo(next);
    setSyncStatus('idle');
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => saveToDb(next), 800);
  };

  const handleSync = useCallback(async (data?: SeoData) => {
    if (!projectId) return;
    const payload = data ?? seo;
    setSyncing(true);
    try {
      // Save first
      await supabase
        .from("project_settings")
        .upsert(
          { project_id: projectId, setting_key: "seo", setting_value: payload },
          { onConflict: "project_id,setting_key" }
        );
      // Then sync to site
      const { data: { session } } = await lovableCloud.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/sync`), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const isLive = json.productionDeployed === true;
      setSyncStatus(isLive ? 'live' : 'synced');
      setRequiresRepublish(json.requiresRepublish === true);
      toast.success(json.message ?? "SEO synced to site");
      setTimeout(() => setSyncStatus('idle'), 6000);
    } catch (e: any) {
      setSyncStatus('error');
      toast.error(e.message ?? "SEO sync failed");
      setTimeout(() => setSyncStatus('idle'), 4000);
    } finally {
      setSyncing(false);
    }
  }, [projectId, seo]);

  const displayTitle = seo.title || projectName || "Page Title";
  const displayDesc = seo.description || "Your page description will appear here in Google search results.";
  const displayHost = projectSlug
    ? `${projectSlug}.ecomgear.app`
    : "yourproject.ecomgear.app";
  const displayUrl = `https://${displayHost}`;

  if (loading) return <div className="p-6 text-sm text-white/45">Loading…</div>;

  return (
    <div className="space-y-5">

      {/* ── Google SERP preview ─────────────────────────────── */}
      <Card className="bg-[#0f0f12] border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[13px] text-white/70 font-medium">Search preview — updates live as you type</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Outer Google chrome */}
          <div className="rounded-2xl bg-[#f1f3f4] p-3 select-none">
            {/* Google search bar */}
            <div className="flex items-center gap-2 mb-4">
              {/* Google G logo */}
              <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {/* Fake search bar */}
              <div className="flex-1 flex items-center gap-2 bg-white rounded-full px-4 py-2 shadow-sm border border-gray-200">
                <span className="text-[13px] text-gray-800 truncate flex-1">{displayTitle}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0 text-gray-400">
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/>
                  <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
            </div>

            {/* Result count line */}
            <p className="text-[12px] text-gray-500 mb-3 px-1">About 1 result (0.42 seconds)</p>

            {/* Single search result */}
            <div className="bg-white rounded-xl px-4 py-3 shadow-sm">
              {/* Site row */}
              <div className="flex items-center justify-between mb-0.5">
                <div className="flex items-center gap-2">
                  {seo.favicon ? (
                    <img
                      src={seo.favicon}
                      alt=""
                      className="h-[18px] w-[18px] rounded-full object-contain"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="h-[18px] w-[18px] rounded-full bg-gray-100 flex items-center justify-center border border-gray-200">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" stroke="#9aa0a6" strokeWidth="2"/>
                        <path d="M12 3a9 9 0 0 1 0 18M12 3a9 9 0 0 0 0 18M3 12h18" stroke="#9aa0a6" strokeWidth="2"/>
                      </svg>
                    </div>
                  )}
                  <div className="flex flex-col">
                    <span className="text-[14px] text-[#202124] leading-none font-medium">{projectName || "Your Project"}</span>
                    <span className="text-[12px] text-[#4d5156] leading-none truncate max-w-[320px]">{displayUrl}</span>
                  </div>
                </div>
                <MoreVertical className="h-4 w-4 text-[#70757a] shrink-0" />
              </div>

              {/* Title */}
              <p
                className="text-[20px] leading-[1.3] mt-1 truncate"
                style={{ color: '#1558d6', fontFamily: 'arial, sans-serif' }}
              >
                {displayTitle}
              </p>

              {/* Description */}
              <p
                className="text-[14px] leading-[1.57] mt-1 line-clamp-2"
                style={{ color: '#4d5156', fontFamily: 'arial, sans-serif' }}
              >
                {displayDesc}
              </p>
            </div>

            {/* Pagination hint */}
            <div className="flex justify-center mt-4 gap-1">
              {[1,2,3,4].map(n => (
                <div key={n} className={`h-2 w-2 rounded-full ${n === 1 ? 'bg-[#4285F4]' : 'bg-gray-300'}`} />
              ))}
            </div>
          </div>

          {/* Sync status row */}
          <div className="flex items-center justify-between mt-3 px-0.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              {syncStatus === 'saved' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Auto-saved</span>}
              {syncStatus === 'live' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3 w-3" />Live on site</span>}
              {syncStatus === 'synced' && <span className="flex items-center gap-1 text-amber-400"><CheckCircle2 className="h-3 w-3" />Saved — re-publish to go live</span>}
              {syncStatus === 'error' && <span className="flex items-center gap-1 text-red-400"><AlertCircle className="h-3 w-3" />Sync failed</span>}
              {(syncStatus === 'idle' || saving) && <span className="text-white/25">{saving ? 'Saving…' : 'Changes auto-save'}</span>}
            </div>
            <Button
              size="sm"
              onClick={() => handleSync()}
              disabled={syncing}
              className="h-7 px-3 text-[11px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync to Site'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Page SEO fields ─────────────────────────────────── */}
      <Card className="bg-[#0f0f12] border-white/[0.07]">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-white/85">Page SEO</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="seo-title" className="text-white/60 text-xs">Page Title</Label>
              <span className={`text-[11px] tabular-nums ${seo.title.length > 55 ? 'text-red-400' : seo.title.length > 40 ? 'text-amber-400' : 'text-white/30'}`}>
                {seo.title.length}/60
              </span>
            </div>
            <Input id="seo-title" value={seo.title} onChange={set("title")} maxLength={60}
              placeholder={projectName || "My Awesome Website"}
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
            <div className="h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-300 ${seo.title.length > 55 ? 'bg-red-500/70' : seo.title.length > 40 ? 'bg-amber-400/70' : 'bg-emerald-400/60'}`}
                style={{ width: `${Math.min(100, (seo.title.length / 60) * 100)}%` }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="seo-desc" className="text-white/60 text-xs">Meta Description</Label>
              <span className={`text-[11px] tabular-nums ${seo.description.length > 150 ? 'text-red-400' : seo.description.length > 120 ? 'text-amber-400' : 'text-white/30'}`}>
                {seo.description.length}/160
              </span>
            </div>
            <Textarea id="seo-desc" value={seo.description} onChange={set("description")} rows={3} maxLength={160}
              placeholder="A short description of your website for search engines."
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 text-[13px] resize-none" />
            <div className="h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-300 ${seo.description.length > 150 ? 'bg-red-500/70' : seo.description.length > 120 ? 'bg-amber-400/70' : 'bg-emerald-400/60'}`}
                style={{ width: `${Math.min(100, (seo.description.length / 160) * 100)}%` }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="seo-keywords" className="text-white/60 text-xs">Keywords</Label>
            <Input id="seo-keywords" value={seo.keywords} onChange={set("keywords")}
              placeholder="ecommerce, store, products"
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
            <p className="text-[11px] text-white/30">Comma-separated</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="seo-favicon" className="text-white/60 text-xs">Favicon URL</Label>
            <div className="flex gap-2 items-center">
              {seo.favicon && (
                <img src={seo.favicon} alt="" className="h-6 w-6 rounded object-contain shrink-0 border border-white/[0.08]"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              )}
              <Input id="seo-favicon" value={seo.favicon} onChange={set("favicon")}
                placeholder="https://example.com/favicon.ico"
                className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px] flex-1" />
            </div>
            <p className="text-[11px] text-white/30">.ico or .png, 32×32px recommended</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs">Search Visibility</Label>
            <Select value={seo.robots} onValueChange={setSelect("robots")}>
              <SelectTrigger className="bg-[#0a0a0d] border-white/[0.08] text-white/70 h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="index, follow">Index, Follow — visible to Google</SelectItem>
                <SelectItem value="noindex, follow">No Index, Follow — hidden from search</SelectItem>
                <SelectItem value="index, nofollow">Index, No Follow</SelectItem>
                <SelectItem value="noindex, nofollow">No Index, No Follow — fully private</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── Social Sharing ──────────────────────────────────── */}
      <Card className="bg-[#0f0f12] border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Social Sharing (Open Graph)</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">How your site looks on Twitter, Facebook, LinkedIn</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(seo.og_image || seo.og_title || seo.og_description) && (
            <div className="rounded-xl overflow-hidden border border-gray-200 bg-white shadow-sm">
              {seo.og_image
                ? <img src={seo.og_image} alt="OG" className="w-full h-36 object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                : <div className="w-full h-24 bg-gradient-to-br from-indigo-100 to-purple-100" />}
              <div className="px-3 py-2 border-t border-gray-100">
                <p className="text-[11px] text-gray-400 uppercase tracking-wider">{displayHost}</p>
                <p className="text-[13px] font-semibold text-gray-900 truncate">{seo.og_title || displayTitle}</p>
                <p className="text-[12px] text-gray-500 line-clamp-2">{seo.og_description || displayDesc}</p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="og-title" className="text-white/60 text-xs">Social Title</Label>
            <Input id="og-title" value={seo.og_title} onChange={set("og_title")}
              placeholder={seo.title || "My Awesome Website"}
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="og-desc" className="text-white/60 text-xs">Social Description</Label>
            <Textarea id="og-desc" value={seo.og_description} onChange={set("og_description")} rows={2}
              placeholder={seo.description || "A short description for social cards."}
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 text-[13px] resize-none" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="og-image" className="text-white/60 text-xs">Social Image URL</Label>
            <Input id="og-image" value={seo.og_image} onChange={set("og_image")}
              placeholder="https://example.com/og-image.png"
              className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
            <p className="text-[11px] text-white/30">Recommended: 1200×630px JPG or PNG</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Google Verification ─────────────────────────────── */}
      <Card className="bg-[#0f0f12] border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Image className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Google Verification</CardTitle>
          </div>
          <CardDescription className="text-white/45 text-xs">Verify site ownership with Google Search Console</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="google-verify" className="text-white/60 text-xs">Verification Meta Tag Content</Label>
          <Input id="google-verify" value={seo.google_verification} onChange={set("google_verification")}
            placeholder="abc123xyz (content= value only)"
            className="bg-[#0a0a0d] border-white/[0.08] text-white/85 placeholder:text-white/20 h-8 text-[13px]" />
          <p className="text-[11px] text-white/30">
            In Search Console → "HTML tag" verification → paste only the <code className="bg-white/[0.05] px-1 rounded">content=</code> value
          </p>
        </CardContent>
      </Card>

      {requiresRepublish && syncStatus !== 'idle' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-300">
            <p className="font-semibold">SEO saved — re-publish to go live.</p>
            <p className="text-amber-400/80 mt-0.5">Click <strong>Publish</strong> in the editor toolbar to rebuild and deploy with the new SEO tags.</p>
          </div>
        </div>
      )}
    </div>
  );
};
