import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { getApiServerUrl } from '@/config/external-api';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, Zap, Send, PlayCircle, AlertTriangle, Loader2, Check, X, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

interface ConnectedProject {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'suspended';
  templateId: string | null;
  createdAt: string;
}

interface PlannedPost {
  id: string;
  agentName: string | null;
  platform: string;
  content: string;
  scheduledAt: string | null;
  status: 'pending' | 'approved' | 'rejected';
  postedAt: string | null;
  postUrl: string | null;
  createdAt: string;
}

interface Run {
  id: string;
  agentName: string | null;
  status: 'succeeded' | 'failed';
  startedAt: string;
  completedAt: string;
}

interface Summary {
  activeAgents: number;
  pendingPosts: number;
  runsToday: number;
  failedRuns: number;
}

async function ecgFetch<T>(path: string, projectId: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const res = await fetch(getApiServerUrl(`/api/v1/ecg-proxy${path}${path.includes('?') ? '&' : '?'}projectId=${projectId}`), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

function statusBadgeClass(status: string) {
  if (status === 'active' || status === 'approved' || status === 'succeeded') return 'bg-emerald-500/15 text-emerald-500';
  if (status === 'paused' || status === 'pending') return 'bg-amber-500/15 text-amber-500';
  return 'bg-destructive/15 text-destructive';
}

export default function EcgAgentsPage() {
  const [connectedProjects, setConnectedProjects] = useState<ConnectedProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [loadingProjects, setLoadingProjects] = useState(true);

  const [loadingData, setLoadingData] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [plannedPosts, setPlannedPosts] = useState<PlannedPost[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoadingProjects(true);
      try {
        const { data } = await supabase
          .from('project_secrets')
          .select('project_id, projects(id, name)')
          .eq('key_name', 'ECG_PORTAL_TOKEN');
        const projects = (data || [])
          .map((row: any) => row.projects)
          .filter(Boolean) as ConnectedProject[];
        setConnectedProjects(projects);
        if (projects.length > 0) setSelectedProjectId(projects[0].id);
      } catch (error) {
        console.error('Failed to load eCG Agent connections:', error);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, []);

  const loadData = useCallback(async (projectId: string) => {
    setLoadingData(true);
    try {
      const [summaryData, agentsData, postsData, runsData] = await Promise.all([
        ecgFetch<Summary>('/summary', projectId),
        ecgFetch<Agent[]>('/agents', projectId),
        ecgFetch<PlannedPost[]>('/planned-posts', projectId),
        ecgFetch<Run[]>('/runs', projectId),
      ]);
      setSummary(summaryData);
      setAgents(agentsData);
      setPlannedPosts(postsData);
      setRuns(runsData);
    } catch (error: any) {
      console.error('Failed to load eCG Agent data:', error);
      toast.error(error?.message || 'Failed to load eCG Agent data');
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) loadData(selectedProjectId);
  }, [selectedProjectId, loadData]);

  const handleAgentStatus = async (agentId: string, status: 'active' | 'paused') => {
    if (!selectedProjectId) return;
    setActingId(agentId);
    try {
      await ecgFetch(`/agents/${agentId}/status`, selectedProjectId, { method: 'PATCH', body: JSON.stringify({ status }) });
      setAgents(prev => prev.map(a => a.id === agentId ? { ...a, status } : a));
      toast.success(status === 'active' ? 'Agent resumed' : 'Agent paused');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update agent');
    } finally {
      setActingId(null);
    }
  };

  const handlePostDecision = async (postId: string, status: 'approved' | 'rejected') => {
    if (!selectedProjectId) return;
    setActingId(postId);
    try {
      await ecgFetch(`/planned-posts/${postId}`, selectedProjectId, { method: 'PATCH', body: JSON.stringify({ status }) });
      setPlannedPosts(prev => prev.map(p => p.id === postId ? { ...p, status } : p));
      toast.success(status === 'approved' ? 'Post approved' : 'Post rejected');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update post');
    } finally {
      setActingId(null);
    }
  };

  if (loadingProjects) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="eCG Agents"
        description="Manage the eCG Agents Portal automations connected to your projects."
      />

      {connectedProjects.length === 0 ? (
        <Card className="rounded-xl border-dashed border-border/60 bg-card/40">
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-display text-xl font-semibold text-foreground">No project connected to eCG Agents Portal</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Launch a dashboard from the eCG Agents Portal's Dashboard Creator to link a project here.
              Once connected, its agents, planned posts, and run history show up on this page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-6 flex items-center gap-3">
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger className="w-64 rounded-full border-border/60 bg-card/60"><SelectValue /></SelectTrigger>
              <SelectContent>
                {connectedProjects.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadingData && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {summary && (
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Active agents', value: summary.activeAgents, icon: Bot },
                { label: 'Pending posts', value: summary.pendingPosts, icon: Send },
                { label: 'Runs today', value: summary.runsToday, icon: PlayCircle },
                { label: 'Failed runs today', value: summary.failedRuns, icon: AlertTriangle },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-border/60 bg-card/60 p-4">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <stat.icon className="h-3.5 w-3.5" />
                    <span className="text-xs">{stat.label}</span>
                  </div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{stat.value}</p>
                </div>
              ))}
            </div>
          )}

          <Tabs defaultValue="agents">
            <TabsList className="rounded-full border border-border/60 bg-card/40 p-1">
              <TabsTrigger value="agents" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Agents</TabsTrigger>
              <TabsTrigger value="posts" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Planned Posts</TabsTrigger>
              <TabsTrigger value="runs" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Runs</TabsTrigger>
            </TabsList>

            <TabsContent value="agents" className="mt-5 space-y-2.5">
              {agents.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No agents yet.</p>
              ) : agents.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(i, 8) * 0.03 }}
                  className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 px-4 py-3"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                    <p className="text-xs text-muted-foreground">Created {new Date(agent.createdAt).toLocaleDateString()}</p>
                  </div>
                  <Badge className={`${statusBadgeClass(agent.status)} rounded-full capitalize`}>{agent.status}</Badge>
                  {agent.status !== 'suspended' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      disabled={actingId === agent.id}
                      onClick={() => handleAgentStatus(agent.id, agent.status === 'active' ? 'paused' : 'active')}
                    >
                      {actingId === agent.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : agent.status === 'active' ? 'Pause' : 'Resume'}
                    </Button>
                  )}
                </motion.div>
              ))}
            </TabsContent>

            <TabsContent value="posts" className="mt-5 space-y-2.5">
              {plannedPosts.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No planned posts yet.</p>
              ) : plannedPosts.map((post, i) => (
                <motion.div
                  key={post.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(i, 8) * 0.03 }}
                  className="rounded-xl border border-border/60 bg-card/60 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="rounded-full capitalize">{post.platform}</Badge>
                        <span className="text-xs text-muted-foreground">{post.agentName || 'Unknown agent'}</span>
                      </div>
                      <p className="mt-2 text-sm text-foreground line-clamp-3">{post.content}</p>
                    </div>
                    <Badge className={`${statusBadgeClass(post.status)} shrink-0 rounded-full capitalize`}>{post.status}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                    <p className="text-xs text-muted-foreground">
                      {post.scheduledAt ? `Scheduled ${new Date(post.scheduledAt).toLocaleString()}` : 'Not scheduled'}
                      {post.postUrl && (
                        <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-primary hover:underline">
                          View post <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </p>
                    {post.status === 'pending' && (
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs" disabled={actingId === post.id} onClick={() => handlePostDecision(post.id, 'rejected')}>
                          <X className="mr-1 h-3.5 w-3.5" /> Reject
                        </Button>
                        <Button size="sm" className="h-8 rounded-full px-3 text-xs" disabled={actingId === post.id} onClick={() => handlePostDecision(post.id, 'approved')}>
                          {actingId === post.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Check className="mr-1 h-3.5 w-3.5" /> Approve</>}
                        </Button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </TabsContent>

            <TabsContent value="runs" className="mt-5 space-y-2">
              {runs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
              ) : runs.map((run, i) => (
                <motion.div
                  key={run.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.02 }}
                  className="flex items-center gap-4 rounded-lg border border-border/60 bg-card/60 px-4 py-2.5"
                >
                  <Zap className={`h-4 w-4 shrink-0 ${run.status === 'succeeded' ? 'text-emerald-500' : 'text-destructive'}`} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{run.agentName || 'Unknown agent'}</span>
                  <span className="text-xs text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span>
                  <Badge className={`${statusBadgeClass(run.status)} shrink-0 rounded-full capitalize`}>{run.status}</Badge>
                </motion.div>
              ))}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
