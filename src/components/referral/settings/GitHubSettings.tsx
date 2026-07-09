import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GitBranch, ExternalLink, RefreshCw, Unlink } from "lucide-react";
import { getApiServerUrl } from "@/config/external-api";

interface GitHubSettingsProps {
  projectId?: string;
}

interface RepoOption {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
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
  const [connected, setConnected] = useState<{ login: string; avatarUrl: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [branch, setBranch] = useState("main");
  const [linked, setLinked] = useState<{ fullName: string; branch: string } | null>(null);
  const [linking, setLinking] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [lastPushUrl, setLastPushUrl] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const status = await authedFetch("/status");
      setConnected(status.connected ? { login: status.login, avatarUrl: status.avatarUrl } : null);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load GitHub status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ghParam = searchParams.get("github");
    if (ghParam === "connected") toast.success("GitHub account connected");
    if (ghParam === "error") toast.error("Failed to connect GitHub account");
    if (ghParam) {
      const p = new URLSearchParams(searchParams);
      p.delete("github");
      setSearchParams(p, { replace: true });
    }
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!connected || !projectId) return;
    (async () => {
      try {
        const { link } = await authedFetch(`/${projectId}/link`);
        if (link) { setLinked(link); setSelectedRepo(link.fullName); setBranch(link.branch); }
      } catch { /* non-fatal */ }
      setReposLoading(true);
      try {
        const { repos: list } = await authedFetch("/repos");
        setRepos(list);
      } catch (e: any) {
        toast.error(e.message ?? "Failed to load repositories");
      } finally {
        setReposLoading(false);
      }
    })();
  }, [connected, projectId]);

  const handleConnect = async () => {
    setConnecting(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); setConnecting(false); return; }
    window.location.href = getApiServerUrl(`/api/v1/github/connect?token=${encodeURIComponent(session.access_token)}`);
  };

  const handleDisconnect = async () => {
    try {
      await authedFetch("/disconnect", { method: "DELETE" });
      setConnected(null);
      setRepos([]);
      setLinked(null);
      toast.success("GitHub account disconnected");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to disconnect");
    }
  };

  const handleLink = async () => {
    if (!projectId || !selectedRepo) return;
    setLinking(true);
    try {
      await authedFetch(`/${projectId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: selectedRepo, branch }),
      });
      setLinked({ fullName: selectedRepo, branch });
      toast.success(`Linked to ${selectedRepo}`);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to link repository");
    } finally {
      setLinking(false);
    }
  };

  const handlePush = async () => {
    if (!projectId) return;
    setPushing(true);
    setLastPushUrl(null);
    try {
      const result = await authedFetch(`/${projectId}/push`, { method: "POST" });
      setLastPushUrl(result.commitUrl);
      toast.success(`Pushed ${result.filesPushed} files to GitHub`);
    } catch (e: any) {
      toast.error(e.message ?? "Push failed");
    } finally {
      setPushing(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-white/45">Loading…</div>;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">GitHub</h2>
        <p className="text-sm text-white/45">Connect a GitHub account and push this project's code to a repository.</p>
      </div>

      <Card className="bg-[#0f0f12] border-white/[0.07]">
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
        <Card className="bg-[#0f0f12] border-white/[0.07]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-white/85">Repository</CardTitle>
            <CardDescription className="text-white/45 text-xs">Choose which repo and branch this project syncs to</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Repository</Label>
              <Select value={selectedRepo} onValueChange={(v) => {
                setSelectedRepo(v);
                const r = repos.find(r => r.fullName === v);
                if (r) setBranch(r.defaultBranch);
              }}>
                <SelectTrigger className="bg-[#0a0a0d] border-white/[0.08] text-white/70 h-8 text-[13px]">
                  <SelectValue placeholder={reposLoading ? "Loading repositories…" : "Select a repository"} />
                </SelectTrigger>
                <SelectContent>
                  {repos.map(r => (
                    <SelectItem key={r.id} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-white/60 text-xs">Branch</Label>
              <Input value={branch} onChange={e => setBranch(e.target.value)}
                className="bg-[#0a0a0d] border-white/[0.08] text-white/85 h-8 text-[13px]" />
            </div>

            <Button size="sm" onClick={handleLink} disabled={linking || !selectedRepo} className="h-8 px-4 text-[13px] bg-indigo-600 hover:bg-indigo-500 text-white">
              {linking ? "Linking…" : linked?.fullName === selectedRepo && linked.branch === branch ? "Linked" : "Link Repository"}
            </Button>

            {linked && (
              <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
                <p className="text-[12px] text-white/45">
                  Linked to <strong className="text-white/70">{linked.fullName}</strong> ({linked.branch})
                </p>
                <Button size="sm" onClick={handlePush} disabled={pushing} className="h-7 px-3 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white">
                  <RefreshCw className={`h-3 w-3 ${pushing ? 'animate-spin' : ''}`} />
                  {pushing ? "Pushing…" : "Push to GitHub"}
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
