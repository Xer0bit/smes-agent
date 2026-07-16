import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRightLeft, Plus, Trash2, Loader2 } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { lovableCloud } from "@/integrations/supabase/client";

interface Redirect {
  id: string;
  from_path: string;
  to_path: string;
  status_code: number;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
}

export const RedirectSettings = ({ projectId }: { projectId?: string }) => {
  const queryClient = useQueryClient();
  const [fromPath, setFromPath] = useState("");
  const [toPath, setToPath] = useState("");
  const [statusCode, setStatusCode] = useState<"301" | "302">("301");

  const { data, isLoading } = useQuery({
    queryKey: ["seo-redirects", projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<Redirect[]> => {
      const headers = await authHeaders();
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/redirects`), { headers });
      if (!res.ok) throw new Error("Failed to load redirects");
      const json = await res.json();
      return json.redirects ?? [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/redirects`), {
        method: "POST",
        headers,
        body: JSON.stringify({ from_path: fromPath.trim(), to_path: toPath.trim(), status_code: Number(statusCode) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to add redirect");
      return json.redirect;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["seo-redirects", projectId] });
      setFromPath("");
      setToPath("");
      toast.success("Redirect added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const headers = await authHeaders();
      const res = await fetch(getApiServerUrl(`/api/v1/seo/${projectId}/redirects/${id}`), {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("Failed to delete redirect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["seo-redirects", projectId] });
      toast.success("Redirect removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleAdd = () => {
    const from = fromPath.trim();
    const to = toPath.trim();
    if (!from || !to) { toast.error("Both paths are required"); return; }
    if (!from.startsWith("/") || !to.startsWith("/")) {
      toast.error('Paths must start with "/"');
      return;
    }
    if (from === to) { toast.error("From and to paths can't be the same"); return; }
    addMutation.mutate();
  };

  const redirects = data ?? [];

  return (
    <Card className="bg-workspace-surface border-white/[0.07]">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-indigo-400" />
          <CardTitle className="text-base text-white/85">Redirects</CardTitle>
        </div>
        <CardDescription className="text-white/45 text-xs">
          Send visitors and search engines from an old page to a new one. Use 301 for permanent moves, 302 for temporary.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-white/30 text-xs">Loading…</p>}
        {!isLoading && redirects.length === 0 && (
          <p className="text-white/30 text-xs">No redirects configured yet.</p>
        )}

        {redirects.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-workspace-surface-recessed/50 px-3 py-2">
            <code className="text-[12px] text-white/60 font-mono truncate flex-1">{r.from_path}</code>
            <ArrowRightLeft className="h-3 w-3 text-white/30 shrink-0" />
            <code className="text-[12px] text-indigo-300 font-mono truncate flex-1">{r.to_path}</code>
            <span className="text-[10px] text-white/30 shrink-0 tabular-nums">{r.status_code}</span>
            <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(r.id)}
              className="h-6 w-6 p-0 text-white/30 hover:text-red-400 hover:bg-red-500/10 shrink-0">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}

        <div className="flex gap-2 items-center pt-1">
          <Input value={fromPath} onChange={(e) => setFromPath(e.target.value)} placeholder="/old-page"
            className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px] flex-1" />
          <Input value={toPath} onChange={(e) => setToPath(e.target.value)} placeholder="/new-page"
            className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 placeholder:text-white/20 h-8 text-[13px] flex-1" />
          <Select value={statusCode} onValueChange={(v) => setStatusCode(v as "301" | "302")}>
            <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 text-[13px] w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="301">301</SelectItem>
              <SelectItem value="302">302</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleAdd} disabled={addMutation.isPending} className="h-8 px-3 text-[12px] bg-indigo-600 hover:bg-indigo-500 gap-1.5 shrink-0">
            {addMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
