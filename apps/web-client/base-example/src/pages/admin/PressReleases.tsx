import { useState, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useClientContext } from "@/hooks/useClientContext";
import { toast } from "sonner";
import {
  Newspaper, Plus, ExternalLink, Edit3, Save, ChevronDown, ChevronUp,
  Globe, Trash2, Send, Eye, Users, MessageSquare, CheckCircle, Clock, XCircle,
  Upload, Search, Link, FileUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import { RichTextEditor } from "@/components/RichTextEditor";

interface PressRelease {
  id: string;
  client_id: string;
  title: string;
  content: string;
  status: "draft" | "submitted" | "published" | "unpublished";
  published_url: string | null;
  unique_visits: number;
  total_visits: number;
  admin_comment: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PressReleaseUrl {
  id: string;
  press_release_id: string;
  url: string;
  outlet_name: string | null;
  unique_visits: number;
  total_visits: number;
  created_at: string;
}

function getUpcomingQuarters() {
  const now = new Date();
  const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const currentYear = now.getFullYear();
  const quarters: { label: string; key: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const sm = (qStartMonth + i * 3) % 12;
    const sy = currentYear + Math.floor((qStartMonth + i * 3) / 12);
    const q = Math.floor(sm / 3) + 1;
    quarters.push({ label: `Q${q}, ${sy}`, key: `${sy}-Q${q}` });
  }
  return quarters;
}

function getQuarterKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  unpublished: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Pending",
  published: "Published",
  unpublished: "Unpublished",
};

function parseCSV(text: string): { url: string; outlet_name: string; unique_visits: number; total_visits: number }[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const urlIdx = header.findIndex((h) => h === "url");
  if (urlIdx === -1) return [];
  const outletIdx = header.findIndex((h) => h.includes("outlet") || h.includes("name"));
  const uniqueIdx = header.findIndex((h) => h.includes("unique"));
  const totalIdx = header.findIndex((h) => h.includes("total"));

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return {
      url: cols[urlIdx] || "",
      outlet_name: outletIdx >= 0 ? cols[outletIdx] || "" : "",
      unique_visits: uniqueIdx >= 0 ? parseInt(cols[uniqueIdx]) || 0 : 0,
      total_visits: totalIdx >= 0 ? parseInt(cols[totalIdx]) || 0 : 0,
    };
  }).filter((r) => r.url.length > 0);
}

const PressReleases = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { clientId, isSuperAdmin, loading: selectorLoading } = useClientContext();

  const [editDialog, setEditDialog] = useState(false);
  const [editingRelease, setEditingRelease] = useState<PressRelease | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");

  const [adminDialog, setAdminDialog] = useState(false);
  const [adminRelease, setAdminRelease] = useState<PressRelease | null>(null);
  const [adminTitle, setAdminTitle] = useState("");
  const [adminContent, setAdminContent] = useState("");
  const [adminStatus, setAdminStatus] = useState<string>("draft");
  const [adminComment, setAdminComment] = useState("");

  // URL management in admin dialog
  const [adminUrls, setAdminUrls] = useState<PressReleaseUrl[]>([]);
  const [newUrlValue, setNewUrlValue] = useState("");
  const [newOutletName, setNewOutletName] = useState("");
  const [newUniqueVisits, setNewUniqueVisits] = useState(0);
  const [newTotalVisits, setNewTotalVisits] = useState(0);
  const [selectedUrlIds, setSelectedUrlIds] = useState<Set<string>>(new Set());
  const [urlSearch, setUrlSearch] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedUrlSearch, setExpandedUrlSearch] = useState("");

  const quarters = useMemo(() => getUpcomingQuarters(), []);

  const { data: releases = [], isLoading } = useQuery({
    queryKey: ["press-releases", clientId],
    queryFn: async () => {
      if (!clientId) return [];
      const { data, error } = await (supabase as any)
        .from("press_releases").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PressRelease[];
    },
    enabled: !!clientId,
  });

  // Fetch all URLs for press releases
  const releaseIds = releases.map((r) => r.id);
  const { data: allUrls = [] } = useQuery({
    queryKey: ["press-release-urls", releaseIds],
    queryFn: async () => {
      if (releaseIds.length === 0) return [];
      const { data, error } = await (supabase as any)
        .from("press_release_urls").select("*").in("press_release_id", releaseIds).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PressReleaseUrl[];
    },
    enabled: releaseIds.length > 0,
  });

  const urlsByReleaseId = useMemo(() => {
    const map: Record<string, PressReleaseUrl[]> = {};
    allUrls.forEach((u) => {
      if (!map[u.press_release_id]) map[u.press_release_id] = [];
      map[u.press_release_id].push(u);
    });
    return map;
  }, [allUrls]);

  const releasesByQuarter = useMemo(() => {
    const map: Record<string, PressRelease[]> = {};
    quarters.forEach((q) => { map[q.key] = []; });
    releases.forEach((r) => {
      const qk = getQuarterKey(r.created_at);
      if (map[qk]) map[qk].push(r);
    });
    return map;
  }, [releases, quarters]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editingRelease) {
        const { error } = await (supabase as any).from("press_releases").update({
          title: formTitle.trim(), content: formContent, updated_at: new Date().toISOString(),
        }).eq("id", editingRelease.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("press_releases").insert({
          title: formTitle.trim(), content: formContent, client_id: clientId, created_by: user?.id, status: "draft",
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["press-releases", clientId] });
      toast.success(editingRelease ? "Updated" : "Created");
      setEditDialog(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const submitMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("press_releases").update({ status: "submitted", updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["press-releases", clientId] }); toast.success("Submitted for review"); },
    onError: (err: Error) => toast.error(err.message),
  });

  const adminSaveMutation = useMutation({
    mutationFn: async () => {
      if (!adminRelease) return;
      const { error } = await (supabase as any).from("press_releases").update({
        title: adminTitle.trim(),
        content: adminContent,
        status: adminStatus,
        admin_comment: adminComment.trim() || null,
        updated_at: new Date().toISOString(),
      }).eq("id", adminRelease.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["press-releases", clientId] });
      toast.success("Press release updated");
      setAdminDialog(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("press_releases").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["press-releases", clientId] }); toast.success("Deleted"); },
    onError: (err: Error) => toast.error(err.message),
  });

  // URL mutations
  const addUrlMutation = useMutation({
    mutationFn: async ({ pressReleaseId, urls }: { pressReleaseId: string; urls: { url: string; outlet_name: string; unique_visits: number; total_visits: number }[] }) => {
      const rows = urls.map((u) => ({ press_release_id: pressReleaseId, ...u }));
      const { error } = await (supabase as any).from("press_release_urls").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["press-release-urls"] });
      toast.success("URLs added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteUrlsMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await (supabase as any).from("press_release_urls").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["press-release-urls"] });
      setSelectedUrlIds(new Set());
      toast.success("URLs deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openClientEdit(pr: PressRelease) { setEditingRelease(pr); setFormTitle(pr.title); setFormContent(pr.content); setEditDialog(true); }
  function openClientNew() { setEditingRelease(null); setFormTitle(""); setFormContent(""); setEditDialog(true); }
  function openAdminEdit(pr: PressRelease) {
    setAdminRelease(pr);
    setAdminTitle(pr.title);
    setAdminContent(pr.content);
    setAdminStatus(pr.status);
    setAdminComment(pr.admin_comment ?? "");
    setAdminUrls(urlsByReleaseId[pr.id] || []);
    setSelectedUrlIds(new Set());
    setNewUrlValue("");
    setNewOutletName("");
    setNewUniqueVisits(0);
    setNewTotalVisits(0);
    setUrlSearch("");
    setAdminDialog(true);
  }

  function handleAddUrl() {
    if (!newUrlValue.trim() || !adminRelease) return;
    addUrlMutation.mutate({
      pressReleaseId: adminRelease.id,
      urls: [{ url: newUrlValue.trim(), outlet_name: newOutletName.trim(), unique_visits: newUniqueVisits, total_visits: newTotalVisits }],
    });
    setNewUrlValue("");
    setNewOutletName("");
    setNewUniqueVisits(0);
    setNewTotalVisits(0);
  }

  function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !adminRelease) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length === 0) {
        toast.error("No valid URLs found in CSV. Ensure a 'url' column header exists.");
        return;
      }
      if (confirm(`Import ${parsed.length} URLs?`)) {
        addUrlMutation.mutate({ pressReleaseId: adminRelease!.id, urls: parsed });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const [confirmAction, setConfirmAction] = useState<{ title: string; description: string; onConfirm: () => void } | null>(null);

  function handleBulkDelete() {
    if (selectedUrlIds.size === 0) return;
    setConfirmAction({
      title: "Delete URLs",
      description: `Are you sure you want to delete ${selectedUrlIds.size} URL(s)? This action cannot be undone.`,
      onConfirm: () => deleteUrlsMutation.mutate(Array.from(selectedUrlIds)),
    });
  }

  const totalPublished = releases.filter((r) => r.status === "published").length;

  // Helper to get aggregated stats for a release
  function getAggregatedStats(prId: string) {
    const urls = urlsByReleaseId[prId] || [];
    return {
      count: urls.length,
      uniqueVisits: urls.reduce((sum, u) => sum + u.unique_visits, 0),
      totalVisits: urls.reduce((sum, u) => sum + u.total_visits, 0),
    };
  }

  // Filter admin URLs in dialog
  const filteredAdminUrls = useMemo(() => {
    const urls = adminRelease ? (urlsByReleaseId[adminRelease.id] || []) : [];
    if (!urlSearch.trim()) return urls;
    const q = urlSearch.toLowerCase();
    return urls.filter((u) => u.url.toLowerCase().includes(q) || (u.outlet_name || "").toLowerCase().includes(q));
  }, [adminRelease, urlsByReleaseId, urlSearch]);

  if (selectorLoading) {
    return <div className="flex items-center justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  if (!clientId) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <Newspaper className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <h3 className="font-display font-semibold text-foreground mb-1">{isSuperAdmin ? "Select a client" : "No client account linked"}</h3>
        <p className="text-muted-foreground text-sm font-body">{isSuperAdmin ? "Choose a client from the header." : "Ask your super admin to assign you."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-bold text-foreground">Press Releases</h2>
        <p className="text-muted-foreground font-body text-sm">
          {isSuperAdmin ? "Review and manage press releases." : "Manage press releases by quarter."} {totalPublished} published.
        </p>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading…</div>
      ) : (
        <div className="space-y-6">
          {quarters.map((quarter) => {
            const qReleases = releasesByQuarter[quarter.key] ?? [];
            const publishedCount = qReleases.filter((r) => r.status === "published").length;
            const pendingCount = qReleases.filter((r) => r.status !== "published").length;

            return (
              <Card key={quarter.key} className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="font-display text-lg">{quarter.label}</CardTitle>
                      <div className="flex gap-2">
                        {publishedCount > 0 && (
                          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs">
                            {publishedCount} Published
                          </Badge>
                        )}
                        {pendingCount > 0 && (
                          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-xs">
                            {pendingCount} Pending
                          </Badge>
                        )}
                      </div>
                    </div>
                    {!isSuperAdmin && (
                      <Button variant="outline" size="sm" onClick={openClientNew}>
                        <Plus className="h-4 w-4 mr-1" /> Add Press
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {qReleases.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm font-body border border-dashed border-border rounded-lg">
                      No press releases for this quarter yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {qReleases.map((pr) => {
                        const isPublished = pr.status === "published";
                        const isExpanded = expandedId === pr.id;
                        const stats = getAggregatedStats(pr.id);
                        const prUrls = urlsByReleaseId[pr.id] || [];
                        const filteredExpandedUrls = expandedUrlSearch.trim()
                          ? prUrls.filter((u) => u.url.toLowerCase().includes(expandedUrlSearch.toLowerCase()) || (u.outlet_name || "").toLowerCase().includes(expandedUrlSearch.toLowerCase()))
                          : prUrls;

                        return (
                          <Collapsible
                            key={pr.id}
                            open={isExpanded}
                            onOpenChange={() => { setExpandedId(isExpanded ? null : pr.id); setExpandedUrlSearch(""); }}
                          >
                            <div className={`rounded-lg border transition-colors ${isPublished ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-border bg-muted/30"}`}>
                              <div className="flex items-center gap-3 px-4 py-3">
                                <CollapsibleTrigger asChild>
                                  <button className="p-1 hover:bg-muted rounded shrink-0">
                                    {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                                  </button>
                                </CollapsibleTrigger>

                                <div className="flex-1 min-w-0">
                                  <p className="font-display font-semibold text-sm text-foreground truncate">{pr.title}</p>
                                  <p className="text-xs text-muted-foreground font-body mt-0.5">
                                    {format(new Date(pr.created_at), "MMM d, yyyy")}
                                  </p>
                                </div>

                                {/* Aggregated stats badges */}
                                {isPublished && stats.count > 0 && (
                                  <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1"><Link className="h-3 w-3" />{stats.count}</span>
                                    <span className="flex items-center gap-1"><Users className="h-3 w-3" />{stats.uniqueVisits.toLocaleString()}</span>
                                    <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{stats.totalVisits.toLocaleString()}</span>
                                  </div>
                                )}

                                <Badge className={statusStyles[pr.status] ?? ""}>
                                  {statusLabels[pr.status] ?? pr.status}
                                </Badge>

                                <div className="flex items-center gap-1 shrink-0">
                                  {isSuperAdmin && (
                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openAdminEdit(pr)} title="Manage">
                                      <Edit3 className="h-4 w-4" />
                                    </Button>
                                  )}
                                  {!isSuperAdmin && !isPublished && (
                                    <>
                                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openClientEdit(pr)} title="Edit">
                                        <Edit3 className="h-4 w-4" />
                                      </Button>
                                      {(pr.status === "draft" || pr.status === "unpublished") && (
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => submitMutation.mutate(pr.id)} title="Submit">
                                          <Send className="h-4 w-4" />
                                        </Button>
                                      )}
                                      <Button
                                        variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                                        onClick={() => setConfirmAction({
                                          title: "Delete Press Release",
                                          description: `Are you sure you want to delete "${pr.title}"? This action cannot be undone.`,
                                          onConfirm: () => deleteMutation.mutate(pr.id),
                                        })}
                                        title="Delete"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </div>

                              <CollapsibleContent>
                                <div className={`border-t px-4 py-4 space-y-4 ${isPublished ? "border-emerald-200 dark:border-emerald-800" : "border-border"}`}>
                                  {/* Aggregated summary bar */}
                                  {isPublished && stats.count > 0 && (
                                    <div className="grid grid-cols-3 gap-4">
                                      <div className="bg-background rounded-lg p-3 border border-border text-center">
                                        <div className="flex items-center justify-center gap-1.5 text-muted-foreground mb-1">
                                          <Link className="h-3.5 w-3.5" />
                                          <span className="text-xs font-body">URLs</span>
                                        </div>
                                        <p className="text-xl font-display font-bold text-foreground">{stats.count.toLocaleString()}</p>
                                      </div>
                                      <div className="bg-background rounded-lg p-3 border border-border text-center">
                                        <div className="flex items-center justify-center gap-1.5 text-muted-foreground mb-1">
                                          <Users className="h-3.5 w-3.5" />
                                          <span className="text-xs font-body">Unique Visits</span>
                                        </div>
                                        <p className="text-xl font-display font-bold text-foreground">{stats.uniqueVisits.toLocaleString()}</p>
                                      </div>
                                      <div className="bg-background rounded-lg p-3 border border-border text-center">
                                        <div className="flex items-center justify-center gap-1.5 text-muted-foreground mb-1">
                                          <Eye className="h-3.5 w-3.5" />
                                          <span className="text-xs font-body">Total Visits</span>
                                        </div>
                                        <p className="text-xl font-display font-bold text-foreground">{stats.totalVisits.toLocaleString()}</p>
                                      </div>
                                    </div>
                                  )}

                                  {/* URL table */}
                                  {isPublished && prUrls.length > 0 && (
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <p className="text-xs text-muted-foreground font-body uppercase tracking-wider">Syndicated URLs</p>
                                        <div className="relative w-48">
                                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                          <Input
                                            placeholder="Search URLs…"
                                            value={expandedUrlSearch}
                                            onChange={(e) => setExpandedUrlSearch(e.target.value)}
                                            className="pl-8 h-8 text-xs"
                                          />
                                        </div>
                                      </div>
                                      <div className="border border-border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                                        <Table>
                                          <TableHeader>
                                            <TableRow>
                                              <TableHead className="text-xs">Outlet</TableHead>
                                              <TableHead className="text-xs">URL</TableHead>
                                              <TableHead className="text-xs text-right w-24">Unique</TableHead>
                                              <TableHead className="text-xs text-right w-24">Total</TableHead>
                                            </TableRow>
                                          </TableHeader>
                                          <TableBody>
                                            {filteredExpandedUrls.map((u) => (
                                              <TableRow key={u.id}>
                                                <TableCell className="text-xs font-medium">{u.outlet_name || "—"}</TableCell>
                                                <TableCell className="text-xs max-w-[300px] truncate">
                                                  <a href={u.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{u.url}</a>
                                                </TableCell>
                                                <TableCell className="text-xs text-right">{u.unique_visits.toLocaleString()}</TableCell>
                                                <TableCell className="text-xs text-right">{u.total_visits.toLocaleString()}</TableCell>
                                              </TableRow>
                                            ))}
                                          </TableBody>
                                        </Table>
                                      </div>
                                    </div>
                                  )}

                                  {pr.content && (
                                    <div>
                                      <p className="text-xs text-muted-foreground font-body uppercase tracking-wider mb-1">Content</p>
                                      <div
                                        className="prose prose-sm dark:prose-invert max-w-none text-foreground font-body line-clamp-6"
                                        dangerouslySetInnerHTML={{ __html: pr.content }}
                                      />
                                    </div>
                                  )}

                                  {pr.admin_comment && (
                                    <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
                                      <p className="text-xs text-muted-foreground font-body uppercase tracking-wider mb-1 flex items-center gap-1">
                                        <MessageSquare className="h-3 w-3" /> Admin Feedback
                                      </p>
                                      <p className="text-sm text-foreground font-body">{pr.admin_comment}</p>
                                    </div>
                                  )}

                                  <div className="flex gap-6 text-xs text-muted-foreground">
                                    <span>Created: {format(new Date(pr.created_at), "MMM d, yyyy")}</span>
                                    <span>Updated: {format(new Date(pr.updated_at), "MMM d, yyyy")}</span>
                                  </div>
                                </div>
                              </CollapsibleContent>
                            </div>
                          </Collapsible>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Client Create/Edit Dialog */}
      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">{editingRelease ? "Edit Press Release" : "New Press Release"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">Title</Label>
              <Input placeholder="Press release title" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label className="font-body">Content</Label>
              <RichTextEditor content={formContent} onChange={setFormContent} clientId={clientId} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={() => saveMutation.mutate()} disabled={!formTitle.trim() || saveMutation.isPending}>
              <Save className="h-4 w-4 mr-1" />{saveMutation.isPending ? "Saving…" : editingRelease ? "Save Changes" : "Save Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin Manage Dialog — with URL management */}
      <Dialog open={adminDialog} onOpenChange={setAdminDialog}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Manage Press Release</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="details" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
              <TabsTrigger value="urls" className="flex-1">
                URLs ({adminRelease ? (urlsByReleaseId[adminRelease.id] || []).length : 0})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label className="font-body">Title</Label>
                <Input value={adminTitle} onChange={(e) => setAdminTitle(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label className="font-body">Content</Label>
                <RichTextEditor content={adminContent} onChange={setAdminContent} clientId={clientId} />
              </div>
              <div className="space-y-2">
                <Label className="font-body">Status</Label>
                <Select value={adminStatus} onValueChange={setAdminStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft"><span className="flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Draft</span></SelectItem>
                    <SelectItem value="submitted"><span className="flex items-center gap-2"><Send className="h-3.5 w-3.5" /> Pending</span></SelectItem>
                    <SelectItem value="published"><span className="flex items-center gap-2"><CheckCircle className="h-3.5 w-3.5" /> Published</span></SelectItem>
                    <SelectItem value="unpublished"><span className="flex items-center gap-2"><XCircle className="h-3.5 w-3.5" /> Unpublished</span></SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-body">Admin Comment / Feedback</Label>
                <Textarea
                  placeholder="Leave a comment for the client…"
                  value={adminComment}
                  onChange={(e) => setAdminComment(e.target.value)}
                  rows={3}
                />
              </div>
            </TabsContent>

            <TabsContent value="urls" className="space-y-4 pt-2">
              {/* Add URL */}
              <div className="border border-border rounded-lg p-4 space-y-3">
                <p className="text-sm font-display font-semibold">Add URL</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">URL *</Label>
                    <Input placeholder="https://..." value={newUrlValue} onChange={(e) => setNewUrlValue(e.target.value)} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Outlet Name</Label>
                    <Input placeholder="e.g. Forbes" value={newOutletName} onChange={(e) => setNewOutletName(e.target.value)} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unique Visits</Label>
                    <Input type="number" value={newUniqueVisits} onChange={(e) => setNewUniqueVisits(Number(e.target.value))} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Total Visits</Label>
                    <Input type="number" value={newTotalVisits} onChange={(e) => setNewTotalVisits(Number(e.target.value))} className="text-sm" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddUrl} disabled={!newUrlValue.trim() || addUrlMutation.isPending}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => csvInputRef.current?.click()}>
                    <FileUp className="h-3.5 w-3.5 mr-1" /> Import CSV
                  </Button>
                   <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleCSVImport} />
                </div>
                <p className="text-xs text-muted-foreground">Expected CSV columns: url, outlet_name, unique_visits, total_visits</p>
              </div>

              {/* URL list */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="relative w-48">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input placeholder="Search…" value={urlSearch} onChange={(e) => setUrlSearch(e.target.value)} className="pl-8 h-8 text-xs" />
                  </div>
                  {selectedUrlIds.size > 0 && (
                    <Button size="sm" variant="destructive" onClick={handleBulkDelete} disabled={deleteUrlsMutation.isPending}>
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete {selectedUrlIds.size}
                    </Button>
                  )}
                </div>
                <div className="border border-border rounded-lg overflow-hidden max-h-80 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={filteredAdminUrls.length > 0 && selectedUrlIds.size === filteredAdminUrls.length}
                            onCheckedChange={(checked) => {
                              if (checked) setSelectedUrlIds(new Set(filteredAdminUrls.map((u) => u.id)));
                              else setSelectedUrlIds(new Set());
                            }}
                          />
                        </TableHead>
                        <TableHead className="text-xs">Outlet</TableHead>
                        <TableHead className="text-xs">URL</TableHead>
                        <TableHead className="text-xs text-right w-24">Unique</TableHead>
                        <TableHead className="text-xs text-right w-24">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAdminUrls.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                            No URLs yet. Add manually or import a CSV.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredAdminUrls.map((u) => (
                          <TableRow key={u.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedUrlIds.has(u.id)}
                                onCheckedChange={(checked) => {
                                  const next = new Set(selectedUrlIds);
                                  if (checked) next.add(u.id); else next.delete(u.id);
                                  setSelectedUrlIds(next);
                                }}
                              />
                            </TableCell>
                            <TableCell className="text-xs font-medium">{u.outlet_name || "—"}</TableCell>
                            <TableCell className="text-xs max-w-[250px] truncate">
                              <a href={u.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{u.url}</a>
                            </TableCell>
                            <TableCell className="text-xs text-right">{u.unique_visits.toLocaleString()}</TableCell>
                            <TableCell className="text-xs text-right">{u.total_visits.toLocaleString()}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button
              variant="outline" className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => setConfirmAction({
                title: "Delete Press Release",
                description: `Are you sure you want to delete "${adminRelease?.title}"? This action cannot be undone.`,
                onConfirm: () => { deleteMutation.mutate(adminRelease!.id); setAdminDialog(false); },
              })}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Delete
            </Button>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={() => adminSaveMutation.mutate()} disabled={!adminTitle.trim() || adminSaveMutation.isPending}>
              <Save className="h-4 w-4 mr-1" />{adminSaveMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { confirmAction?.onConfirm(); setConfirmAction(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default PressReleases;
