import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Zap, ExternalLink, Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface ZapierSettingsContentProps {
  projectId?: string;
}

interface FieldState {
  keyName: string;
  label: string;
  placeholder: string;
  sensitive: boolean;
  preview: string | null;
  value: string;
}

// Zapier's MCP URL (https://mcp.zapier.com/mcp/YOUR-SECRET-KEY) already embeds
// the secret   a separate bearer token is only needed for MCP servers that
// require one, so it's kept optional here.
const FIELD_DEFS: Omit<FieldState, "preview" | "value">[] = [
  { keyName: "ECG_MCP_URL", label: "Zapier MCP URL", placeholder: "https://mcp.zapier.com/mcp/...", sensitive: true },
  { keyName: "ECG_MCP_TOKEN", label: "Bearer Token (optional)", placeholder: "Only if your MCP server requires one", sensitive: true },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const ZapierSettingsContent = ({ projectId }: ZapierSettingsContentProps) => {
  const [fields, setFields] = useState<FieldState[]>(FIELD_DEFS.map(f => ({ ...f, preview: null, value: "" })));
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const { data: previewRows, isLoading: loading } = useQuery({
    queryKey: ["zapier-connection", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_secrets")
        .select("key_name, key_preview")
        .eq("project_id", projectId!)
        .in("key_name", FIELD_DEFS.map(f => f.keyName));
      return data ?? [];
    },
  });

  // Only hydrate once   a background refetch mid-type would otherwise blank
  // a secret the user is still typing back to "".
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !previewRows) return;
    const previews = new Map(previewRows.map(r => [r.key_name, r.key_preview]));
    setFields(FIELD_DEFS.map(f => ({ ...f, preview: previews.get(f.keyName) ?? null, value: "" })));
    hydrated.current = true;
  }, [previewRows]);

  const setValue = (keyName: string, value: string) => {
    setFields(prev => prev.map(f => f.keyName === keyName ? { ...f, value } : f));
  };

  const handleSave = async () => {
    if (!projectId) return;
    const toSave = fields.filter(f => f.value.trim().length > 0);
    if (toSave.length === 0) { toast.error("Paste your Zapier MCP URL to connect."); return; }

    setSaving(true);
    try {
      for (const f of toSave) {
        const value = f.value.trim();
        const preview = value.length > 4 ? `****${value.slice(-4)}` : "****";
        // No UPDATE policy on project_secrets   replace via delete-then-insert.
        await supabase.from("project_secrets").delete().eq("project_id", projectId).eq("key_name", f.keyName);
        const { error } = await supabase
          .from("project_secrets")
          .insert({ project_id: projectId, key_name: f.keyName, key_value: value, key_preview: preview });
        if (error) throw error;
      }
      toast.success("Zapier connected.");
      setFields(prev => prev.map(f => {
        const saved = toSave.find(s => s.keyName === f.keyName);
        if (!saved) return f;
        const value = saved.value.trim();
        const preview = value.length > 4 ? `****${value.slice(-4)}` : "****";
        return { ...f, preview, value: "" };
      }));
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err, "Failed to save Zapier connection"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <SettingsSkeleton cards={2} />;

  const connected = fields.find(f => f.keyName === "ECG_MCP_URL")?.preview != null;

  return (
    <div className="space-y-6">
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white/85">
            <Zap className="h-4 w-4 text-amber-400" />
            How to connect
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-[13px] text-white/60">
          <ol className="list-decimal list-inside space-y-1.5">
            <li>In Zapier, add the tools/actions you want available to your AI agent.</li>
            <li>
              Click the <strong className="text-white/80">Connect</strong> tab at the top   Zapier gives you an MCP URL that
              looks like <code className="bg-workspace-surface-recessed px-1 py-0.5 rounded text-[11px]">https://mcp.zapier.com/mcp/YOUR-SECRET-KEY</code>.
            </li>
            <li>Copy that URL (treat it like a password   don't share it) and paste it below.</li>
          </ol>
          <a href="https://mcp.zapier.com" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 pt-1">
            Open Zapier MCP <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-white/85">Connection</CardTitle>
            {connected && <span className="text-[11px] font-medium text-emerald-400">● Connected</span>}
          </div>
          <CardDescription className="text-white/45 text-xs">
            Saved here   never displayed again in plaintext after saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map(f => (
            <div key={f.keyName} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-white/60 text-xs">{f.label}</Label>
                {f.preview && <span className="text-[11px] font-mono text-emerald-400/80">{f.preview} saved</span>}
              </div>
              <div className="relative">
                <Input
                  type={f.sensitive && !reveal[f.keyName] ? "password" : "text"}
                  value={f.value}
                  onChange={e => setValue(f.keyName, e.target.value)}
                  placeholder={f.preview ? "Leave blank to keep current value" : f.placeholder}
                  className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px] font-mono pr-8"
                />
                {f.sensitive && (
                  <button
                    type="button"
                    onClick={() => setReveal(r => ({ ...r, [f.keyName]: !r[f.keyName] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-white/45 hover:text-white/85"
                  >
                    {reveal[f.keyName] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            </div>
          ))}

          <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 px-4 text-[13px] bg-indigo-600 hover:bg-indigo-500 text-white">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            {saving ? "Connecting…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
