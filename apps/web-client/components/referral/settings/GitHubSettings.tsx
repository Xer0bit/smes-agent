import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GitBranch, ExternalLink, RefreshCw, Unlink } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";
import { revisionService } from "@/services/revisionService";
import { SettingsSkeleton } from "./SettingsSkeleton";

interface GitHubSettingsProps {
  projectId?: string;
}

async function authedFetch(path: string, opts: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  const res = await fetch(getApiServerUrl(`/api/v1/github${path}`), {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${session.access_token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export const GitHubSettings = ({ projectId }: GitHubSettingsProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [lastPushUrl, setLastPushUrl] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["github-status"],
    queryFn: () => authedFetch("/status") as Promise<{ connected: boolean; login?: string; avatarUrl?: string | null }>,
  });
  const connected = status?.connected ? { login: status.login!, avatarUrl: status.avatarUrl ?? null } : null;

  const { data: linkData, isLoading: linkLoading } = useQuery({
    queryKey: ["github-link", projectId],
    enabled: !!connected && !!projectId,
    queryFn: () => authedFetch(`/${projectId}/link`) as Promise<{ link: { fullName: string; branch: string } | null }>,
  });
  const linked = linkData?.link ?? null;
  const loading = statusLoading || (!!connected && linkLoading);

  useEffect(() => {
    const ghParam = searchParams.get("github");
    if (ghParam === "connected") toast.success("GitHub account connected   name a repository below to save your project");
    if (ghParam === "error") toast.error("Failed to connect GitHub account");
    if (ghParam) {
      const p = new URLSearchParams(searchParams);
      p.delete("github");
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
    window.location.href = getApiServerUrl(`/api/v1/github/connect?${params.toString()}`);
  };

  const handleDisconnect = async () => {
    try {
      await authedFetch("/disconnect", { method: "DELETE" });
      queryClient.setQueryData(["github-status"], { connected: false });
      queryClient.setQueryData(["github-link", projectId], { link: null });
      toast.success("GitHub account disconnected");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to disconnect");
    }
  };

  // Shared by both "Create & Connect" (first push into a fresh repo) and the
  // "Commit to GitHub" button (subsequent pushes)   same commit logic either way.
  const pushCurrentCode = async () => {
    if (!projectId) return;
    const revisions = await revisionService.getRevisions(projectId, 1, 0);
    const latest = revisions[0];
    if (!latest) throw new Error("No revisions found   generate the project first.");
    const files = await revisionService.getRevisionFilesForExport(projectId, latest.id);
    if (files.length === 0) throw new Error("No files found in the latest revision.");

    const result = await authedFetch(`/${projectId}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    setLastPushUrl(result.commitUrl);
    return result;
  };

  const handleCreateRepo = async () => {
    if (!projectId || !newRepoName.trim()) return;
    setCreatingRepo(true);
    try {
      const result = await authedFetch(`/${projectId}/create-repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRepoName.trim(), private: visibility === "private" }),
      });
      queryClient.setQueryData(["github-link", projectId], { link: { fullName: result.fullName, branch: result.branch } });
      setNewRepoName("");
      toast.success(`Created ${result.fullName}   uploading your code…`);

      try {
        const pushResult = await pushCurrentCode();
        toast.success(`Uploaded ${pushResult.filesPushed} files to GitHub`);
      } catch (pushErr: any) {
        // Repo exists and is linked even if this first push failed   the user
        // can retry via "Commit to GitHub" without losing the connection.
        toast.error(pushErr.message ?? "Repository created, but the initial code upload failed");
      }
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create repository");
    } finally {
      setCreatingRepo(false);
    }
  };

  const handlePush = async () => {
    if (!projectId) return;
    setPushing(true);
    setLastPushUrl(null);
    try {
      const result = await pushCurrentCode();
      toast.success(`Committed ${result.filesPushed} files to GitHub`);
    } catch (e: any) {
      toast.error(e.message ?? "Commit failed");
    } finally {
      setPushing(false);
    }
  };

  if (loading) return <SettingsSkeleton cards={2} />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">GitHub</h2>
        <p className="text-sm text-white/45">Connect a GitHub account and push this project's code to a repository created just for it.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-indigo-400" />
            <CardTitle className="text-base text-white/85">Account</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {connected ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {connected.avatarUrl && (
                  <img src={connected.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
                )}
                <span className="text-sm text-white/80">Connected as <strong>{connected.login}</strong></span>
              </div>
              <Button size="sm" variant="outline" onClick={handleDisconnect} className="h-7 px-3 text-[11px] gap-1.5">
                <Unlink className="h-3 w-3" />
                Disconnect
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={handleConnect} disabled={connecting} className="h-8 px-4 text-[13px] gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white">
              {connecting ? "Redirecting…" : "Connect GitHub"}
            </Button>
          )}
        </CardContent>
      </Card>

      {connected && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-white/85">Repository</CardTitle>
            <CardDescription className="text-white/45 text-xs">
              This project only ever pushes to a repository created for it   not any of your other repos.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {linked ? (
              <div className="flex items-center justify-between">
                <p className="text-[12px] text-white/45">
                  Linked to <strong className="text-white/60">{linked.fullName}</strong> ({linked.branch})
                </p>
                <Button size="sm" onClick={handlePush} disabled={pushing} className="h-7 px-3 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white">
                  <RefreshCw className={`h-3 w-3 ${pushing ? 'animate-spin' : ''}`} />
                  {pushing ? "Committing…" : "Commit to GitHub"}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-white/60 text-xs">Repository name</Label>
                  <Input
                    value={newRepoName}
                    onChange={e => setNewRepoName(e.target.value)}
                    placeholder="my-project-name"
                    autoFocus
                    className="bg-workspace-surface-recessed border-white/[0.07] text-white/85 h-8 text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-white/60 text-xs">Visibility</Label>
                  <Select value={visibility} onValueChange={(v) => setVisibility(v as "private" | "public")}>
                    <SelectTrigger className="bg-workspace-surface-recessed border-white/[0.07] text-white/60 h-8 text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="public">Public</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" onClick={handleCreateRepo} disabled={creatingRepo || !newRepoName.trim()}
                  className="h-8 px-4 text-[13px] w-full bg-indigo-600 hover:bg-indigo-500 text-white">
                  {creatingRepo ? "Creating…" : "Create & Connect"}
                </Button>
              </div>
            )}

            {lastPushUrl && (
              <a href={lastPushUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300">
                <ExternalLink className="h-3 w-3" />
                View commit on GitHub
              </a>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
