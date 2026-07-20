import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CreditCard, ExternalLink, Loader2, Eye, EyeOff, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getApiServerUrl } from "@/config/external-api";
import { SettingsSkeleton } from "./SettingsSkeleton";

async function authedFetch(path: string, opts: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  const res = await fetch(getApiServerUrl(`/api/v1/stripe${path}`), {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${session.access_token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

interface StripeSettingsContentProps {
  projectId?: string;
}

interface FieldState {
  keyName: string;
  label: string;
  placeholder: string;
  sensitive: boolean; // masked-by-default input type; publishable keys aren't actually secret
  preview: string | null; // existing masked preview from the DB, or null if unset
  value: string; // new value being entered (empty = leave unchanged)
}

const FIELD_DEFS: Omit<FieldState, "preview" | "value">[] = [
  { keyName: "STRIPE_PUBLISHABLE_KEY", label: "Publishable Key", placeholder: "pk_live_...", sensitive: false },
  { keyName: "STRIPE_SECRET_KEY", label: "Secret Key", placeholder: "sk_live_...", sensitive: true },
  { keyName: "STRIPE_WEBHOOK_SECRET", label: "Webhook Signing Secret", placeholder: "whsec_...", sensitive: true },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const StripeSettingsContent = ({ projectId }: StripeSettingsContentProps) => {
  const [fields, setFields] = useState<FieldState[]>(FIELD_DEFS.map(f => ({ ...f, preview: null, value: "" })));
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; accountName?: string; mode?: string; error?: string } | null>(null);

  const { data: previewRows, isLoading: loading } = useQuery({
    queryKey: ["stripe-keys", projectId],
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
  // a key the user is still typing back to "".
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
    if (toSave.length === 0) { toast.error("Enter at least one key to save."); return; }

    setSaving(true);
    try {
      for (const f of toSave) {
        const value = f.value.trim();
        const preview = value.length > 4 ? `****${value.slice(-4)}` : "****";
        // No UPDATE policy on project_secrets   replace via delete-then-insert
        // instead of upsert, matching the generic Secrets panel's pattern.
        await supabase.from("project_secrets").delete().eq("project_id", projectId).eq("key_name", f.keyName);
        const { error } = await supabase
          .from("project_secrets")
          .insert({ project_id: projectId, key_name: f.keyName, key_value: value, key_preview: preview });
        if (error) throw error;
      }
      toast.success("Stripe keys saved.");
      setFields(prev => prev.map(f => {
        const saved = toSave.find(s => s.keyName === f.keyName);
        if (!saved) return f;
        const value = saved.value.trim();
        const preview = value.length > 4 ? `****${value.slice(-4)}` : "****";
        return { ...f, preview, value: "" };
      }));
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err, "Failed to save Stripe keys"));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!projectId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await authedFetch(`/${projectId}/test`, { method: "POST" });
      setTestResult(result);
      if (result.connected) toast.success(`Connected to ${result.accountName} (${result.mode} mode)`);
      else toast.error(result.error ?? "Connection test failed");
    } catch (e: any) {
      setTestResult({ connected: false, error: e.message });
      toast.error(e.message ?? "Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <SettingsSkeleton cards={1} />;

  const secretKeySaved = fields.find(f => f.keyName === "STRIPE_SECRET_KEY")?.preview != null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Stripe</h2>
        <p className="text-sm text-white/45">Accept payments and manage subscriptions via Stripe.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white/85">
            <CreditCard className="h-4 w-4 text-indigo-400" />
            How to connect
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-[13px] text-white/60">
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              In Stripe, go to <strong className="text-white/80">Developers → API keys</strong>.
            </li>
            <li>
              Copy the <strong className="text-white/80">Publishable key</strong> (starts <code className="bg-workspace-surface-recessed px-1 py-0.5 rounded text-[11px]">pk_</code>) and the
              {" "}<strong className="text-white/80">Secret key</strong> (starts <code className="bg-workspace-surface-recessed px-1 py-0.5 rounded text-[11px]">sk_</code>).
            </li>
            <li>Paste both into the fields below and click <strong className="text-white/80">Save Keys</strong>.</li>
            <li>Click <strong className="text-white/80">Test Connection</strong> to confirm Stripe accepts the key and see which account/mode (test or live) it's connected to.</li>
            <li>
              <em>Optional</em>   for the Webhook Signing Secret: in Stripe go to <strong className="text-white/80">Developers → Webhooks</strong>, click
              {" "}<strong className="text-white/80">Add endpoint</strong>, enter your webhook URL and pick the events to send, then open that endpoint and reveal its
              {" "}<strong className="text-white/80">Signing secret</strong> (starts <code className="bg-workspace-surface-recessed px-1 py-0.5 rounded text-[11px]">whsec_</code>).
            </li>
          </ol>
          <p className="text-[11px] text-white/35 pt-1">
            Use your <strong>test mode</strong> keys (from Stripe's test/live toggle) while building   switch to live keys only when you're ready to accept real payments.
            The Webhook Signing Secret is only useful once you have a webhook handler on your own endpoint to verify against   leave it blank until then.
          </p>
          <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 pt-1">
            Open Stripe API Keys <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base text-white/85">
              <CreditCard className="h-4 w-4 text-indigo-400" />
              API Keys
            </CardTitle>
            {secretKeySaved && (
              <span className="text-[11px] font-medium text-white/45">
                {testResult === null ? "Not tested yet" : testResult.connected
                  ? <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected {testResult.mode ? `(${testResult.mode})` : ""}</span>
                  : <span className="text-red-400 flex items-center gap-1"><XCircle className="h-3 w-3" /> Not connected</span>}
              </span>
            )}
          </div>
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

          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 px-4 text-[13px] bg-indigo-600 hover:bg-indigo-500 text-white">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              {saving ? "Saving…" : "Save Keys"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || !secretKeySaved} className="h-8 px-4 text-[13px]">
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              {testing ? "Testing…" : "Test Connection"}
            </Button>
          </div>
          {testResult && !testResult.connected && testResult.error && (
            <p className="text-[11px] text-red-400">{testResult.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
