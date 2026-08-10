import { useState, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invokeFn } from "@/lib/tenant";
import { toast } from "sonner";
import { BillingTab } from "@/components/BillingTab";
import {
  ArrowLeft, Share2, Users, Newspaper, FileSpreadsheet,
  Plus, Trash2, Settings2, Link2, ExternalLink,
  Facebook, Instagram, Linkedin, Youtube, Twitter,
  MessageSquare, Globe, Save,
  Edit3, ChevronDown, ChevronUp,
  UserPlus,
  Search, FileUp,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Platform = "facebook" | "instagram" | "linkedin" | "youtube" | "twitter";

interface SocialAccount {
  id: string;
  client_id: string;
  platform: string;
  account_name: string;
  connected_at: string;
}

interface LeadForm {
  id: string;
  client_id: string;
  form_name: string;
  webhook_url: string | null;
  created_at: string;
}

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

interface ClientMember {
  id: string;
  status: "active" | "invited";
  email: string | null;
  fullName: string | null;
}

const BufferIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H17a3 3 0 0 1 0 6H7.5a1.5 1.5 0 0 0 0 3H17a3 3 0 0 1 0 6H6.5A2.5 2.5 0 0 1 4 16.5v-10Z" />
  </svg>
);

const platformConfig: Record<Platform, { label: string; icon: React.ElementType; color: string; dotColor: string }> = {
  facebook: { label: "Facebook", icon: Facebook, color: "bg-blue-600 text-white", dotColor: "bg-blue-600" },
  twitter: { label: "X (Twitter)", icon: Twitter, color: "bg-neutral-900 text-white", dotColor: "bg-neutral-900" },
  instagram: { label: "Instagram", icon: Instagram, color: "bg-pink-500 text-white", dotColor: "bg-pink-500" },
  linkedin: { label: "LinkedIn", icon: Linkedin, color: "bg-blue-700 text-white", dotColor: "bg-blue-700" },
  youtube: { label: "YouTube", icon: Youtube, color: "bg-red-600 text-white", dotColor: "bg-red-600" },
};

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  submitted: { label: "Submitted", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" },
  published: { label: "Published", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" },
  unpublished: { label: "Unpublished", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
};

function parseCSV(text: string): { url: string; outletName: string; uniqueVisits: number; totalVisits: number }[] {
  const normalizeCell = (value: string) => value.trim().replace(/^"|"$/g, "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstRow = lines[0].split(",").map((cell) => normalizeCell(cell).toLowerCase());
  const hasHeader = firstRow.includes("url");
  const rows = hasHeader ? lines.slice(1) : lines;

  return rows
    .map((line) => line.split(",").map(normalizeCell))
    .map(([url = "", outletName = "", uniqueVisits = "0", totalVisits = "0"]) => ({
      url,
      outletName,
      uniqueVisits: Number(uniqueVisits) || 0,
      totalVisits: Number(totalVisits) || 0,
    }))
    .filter((row) => row.url.trim().length > 0);
}

const ClientDetail = () => {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  // Buffer connect flow (via Agent Portal): paste the org's Buffer API key,
  // discover which platforms that Buffer account has channels for, pick the
  // ones to connect. The key is stored portal-side as an org connector —
  // never in this app's database.
  const [bufferToken, setBufferToken] = useState("");
  const [discoveredPlatforms, setDiscoveredPlatforms] = useState<string[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectStep, setConnectStep] = useState<"key" | "select">("key");

  const [leadFormDialog, setLeadFormDialog] = useState(false);
  const [editingLeadForm, setEditingLeadForm] = useState<LeadForm | null>(null);
  const [lfName, setLfName] = useState("");
  const [lfWebhook, setLfWebhook] = useState("");
  const [lfSheetUrl, setLfSheetUrl] = useState("");
  const [lfColStart, setLfColStart] = useState("A");
  const [lfColEnd, setLfColEnd] = useState("F");

  const [prDialog, setPrDialog] = useState(false);
  const [editingPr, setEditingPr] = useState<PressRelease | null>(null);
  const [prComment, setPrComment] = useState("");
  const [prStatus, setPrStatus] = useState("");
  const [expandedPrId, setExpandedPrId] = useState<string | null>(null);

  const [newPrUrl, setNewPrUrl] = useState("");
  const [newPrOutlet, setNewPrOutlet] = useState("");
  const [newPrUniqueVisits, setNewPrUniqueVisits] = useState(0);
  const [newPrTotalVisits, setNewPrTotalVisits] = useState(0);
  const [selectedPrUrlIds, setSelectedPrUrlIds] = useState<Set<string>>(new Set());
  const [prUrlSearch, setPrUrlSearch] = useState("");
  const csvPrInputRef = useRef<HTMLInputElement>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDialog, setInviteDialog] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; description: string; onConfirm: () => void } | null>(null);

  // ============= QUERIES =============
  // Every read/write below goes through invokeFn() -> a platform edge
  // function (src/lib/tenant.ts), never a direct table query.

  const { data: client } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => invokeFn<{ id: string; name: string; status: string }>("clients", { action: "get", id: clientId }),
    enabled: !!clientId,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["client-accounts", clientId],
    queryFn: () => invokeFn<SocialAccount[]>("social", { action: "listAccounts", clientId }),
    enabled: !!clientId,
  });

  const { data: leadForms = [] } = useQuery({
    queryKey: ["lead-forms", clientId],
    queryFn: () => invokeFn<LeadForm[]>("content", { action: "listLeadForms", clientId }),
    enabled: !!clientId,
  });

  const { data: releases = [] } = useQuery({
    queryKey: ["client-press-releases", clientId],
    queryFn: () => invokeFn<PressRelease[]>("content", { action: "listPressReleases", clientId }),
    enabled: !!clientId,
  });

  const releaseIds = releases.map((release) => release.id);
  const { data: allPrUrls = [] } = useQuery({
    queryKey: ["client-pr-urls", releaseIds.join(",")],
    queryFn: () => invokeFn<PressReleaseUrl[]>("content", { action: "listPressReleaseUrls", clientId, releaseIds }),
    enabled: releaseIds.length > 0,
  });

  const prUrlsByReleaseId = useMemo(() => {
    const map: Record<string, PressReleaseUrl[]> = {};
    allPrUrls.forEach((url) => {
      if (!map[url.press_release_id]) map[url.press_release_id] = [];
      map[url.press_release_id].push(url);
    });
    return map;
  }, [allPrUrls]);

  function getPrAggregatedStats(prId: string) {
    const urls = prUrlsByReleaseId[prId] || [];
    return {
      count: urls.length,
      uniqueVisits: urls.reduce((sum, url) => sum + url.unique_visits, 0),
      totalVisits: urls.reduce((sum, url) => sum + url.total_visits, 0),
    };
  }

  const filteredPrDialogUrls = useMemo(() => {
    const urls = editingPr ? (prUrlsByReleaseId[editingPr.id] || []) : [];
    if (!prUrlSearch.trim()) return urls;
    const query = prUrlSearch.toLowerCase();
    return urls.filter((url) => url.url.toLowerCase().includes(query) || (url.outlet_name || "").toLowerCase().includes(query));
  }, [editingPr, prUrlsByReleaseId, prUrlSearch]);

  const { data: clientMembers = [] } = useQuery({
    queryKey: ["client-members", clientId],
    queryFn: () => invokeFn<ClientMember[]>("clients", { action: "listMembers", clientId }),
    enabled: !!clientId,
  });

  const resetConnectDialog = () => {
    setBufferToken(""); setDiscoveredPlatforms([]); setSelectedPlatforms(new Set());
    setConnectStep("key");
  };

  // Ask the Agent Portal which platforms this Buffer API key has channels
  // for. Requires this dashboard to be linked to a Portal org (an
  // ECG_PORTAL_TOKEN was set at onboarding) -- the social edge function
  // reaches the Portal server-side via ecg.portal(), never from the browser.
  const discoverBufferPlatforms = useCallback(async () => {
    if (!bufferToken.trim()) return;
    setConnectLoading(true);
    try {
      const { apps } = await invokeFn<{ apps: string[] }>("social", { action: "discoverBuffer", apiKey: bufferToken.trim() });
      if (!apps || apps.length === 0) {
        toast.info("No connected channels found on this Buffer account. Connect channels at buffer.com first.");
        return;
      }
      setDiscoveredPlatforms(apps);
      setSelectedPlatforms(new Set(apps));
      setConnectStep("select");
    } catch (err: any) {
      toast.error(err.message || "Failed to validate the Buffer API key.");
    } finally {
      setConnectLoading(false);
    }
  }, [bufferToken]);

  const connectAllMutation = useMutation({
    mutationFn: async () => {
      const platforms = discoveredPlatforms.filter((p) => selectedPlatforms.has(p));
      if (platforms.length === 0) throw new Error("No platforms selected");
      return invokeFn<SocialAccount[]>("social", { action: "connectBuffer", clientId, apiKey: bufferToken.trim(), platforms });
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.success(`Connected ${rows.length} account${rows.length > 1 ? "s" : ""} via Buffer`);
      setAccountDialogOpen(false);
      resetConnectDialog();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteAccountMutation = useMutation({
    mutationFn: (id: string) => invokeFn("social", { action: "deleteAccount", clientId, id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.success("Account removed");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ============= LEAD FORMS MUTATIONS =============
  const saveLeadFormMutation = useMutation({
    mutationFn: async () => {
      const webhookUrl = lfSheetUrl.trim() ? JSON.stringify({
        type: "google_sheet",
        sheet_url: lfSheetUrl.trim(),
        col_start: lfColStart.toUpperCase() || "A",
        col_end: lfColEnd.toUpperCase() || "F",
      }) : (lfWebhook.trim() || null);
      if (editingLeadForm) {
        await invokeFn("content", { action: "updateLeadForm", clientId, id: editingLeadForm.id, formName: lfName.trim(), webhookUrl });
      } else {
        await invokeFn("content", { action: "createLeadForm", clientId, formName: lfName.trim(), webhookUrl });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lead-forms", clientId] });
      toast.success(editingLeadForm ? "Lead form updated" : "Lead form created");
      setLeadFormDialog(false); setEditingLeadForm(null); setLfName(""); setLfWebhook(""); setLfSheetUrl(""); setLfColStart("A"); setLfColEnd("F");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteLeadFormMutation = useMutation({
    mutationFn: (id: string) => invokeFn("content", { action: "deleteLeadForm", clientId, id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lead-forms", clientId] });
      toast.success("Lead form deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ============= PRESS RELEASES MUTATIONS =============
  const savePrMutation = useMutation({
    mutationFn: async () => {
      if (!editingPr) return;
      await invokeFn("content", {
        action: "updatePressRelease", clientId, id: editingPr.id,
        status: prStatus, adminComment: prComment.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-press-releases", clientId] });
      toast.success("Press release updated");
      setPrDialog(false); setEditingPr(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addPrUrlMutation = useMutation({
    mutationFn: async ({ pressReleaseId, urls }: { pressReleaseId: string; urls: { url: string; outletName: string; uniqueVisits: number; totalVisits: number }[] }) => {
      await invokeFn("content", { action: "addPressReleaseUrls", clientId, pressReleaseId, urls });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-pr-urls"] });
      toast.success("URLs added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deletePrUrlsMutation = useMutation({
    mutationFn: (ids: string[]) => invokeFn("content", { action: "deletePressReleaseUrls", clientId, ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-pr-urls"] });
      setSelectedPrUrlIds(new Set());
      toast.success("URLs deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ============= CLIENT MEMBERS MUTATIONS =============
  // No password is ever set here -- there is no admin API for cloud auth
  // reachable from an edge function (unlike the original Lovable-hosted
  // Supabase project, which had direct auth-admin access). Granting portal
  // access is invite-then-self-signup: the invited email is recorded now
  // and claimed automatically the first time that person signs up
  // (see edge-functions/auth-context.js).
  const inviteMemberMutation = useMutation({
    mutationFn: () => invokeFn("clients", { action: "inviteMember", clientId, email: inviteEmail.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-members", clientId] });
      toast.success("Invite recorded — they'll get access as soon as they sign up with this email.");
      setInviteDialog(false); setInviteEmail("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (id: string) => invokeFn("clients", { action: "removeMember", id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-members", clientId] });
      toast.success("Access removed");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openPrEdit(pr: PressRelease) {
    setEditingPr(pr);
    setPrComment(pr.admin_comment ?? ""); setPrStatus(pr.status);
    setSelectedPrUrlIds(new Set()); setNewPrUrl(""); setNewPrOutlet("");
    setNewPrUniqueVisits(0); setNewPrTotalVisits(0); setPrUrlSearch("");
    setPrDialog(true);
  }

  function handleAddPrUrl() {
    if (!newPrUrl.trim() || !editingPr) return;
    addPrUrlMutation.mutate({
      pressReleaseId: editingPr.id,
      urls: [{ url: newPrUrl.trim(), outletName: newPrOutlet.trim(), uniqueVisits: newPrUniqueVisits, totalVisits: newPrTotalVisits }],
    });
    setNewPrUrl(""); setNewPrOutlet(""); setNewPrUniqueVisits(0); setNewPrTotalVisits(0);
  }

  function handlePrCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !editingPr) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length === 0) { toast.error("No valid URLs found in CSV."); return; }
      setConfirmAction({
        title: "Import URLs",
        description: `Import ${parsed.length} URLs from CSV?`,
        onConfirm: () => addPrUrlMutation.mutate({ pressReleaseId: editingPr!.id, urls: parsed }),
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handlePrBulkDelete() {
    if (selectedPrUrlIds.size === 0) return;
    setConfirmAction({
      title: "Delete URLs",
      description: `Are you sure you want to delete ${selectedPrUrlIds.size} URL(s)? This action cannot be undone.`,
      onConfirm: () => deletePrUrlsMutation.mutate(Array.from(selectedPrUrlIds)),
    });
  }

  if (!client) {
    return <div className="flex items-center justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  const totalPublished = releases.filter((r) => r.status === "published").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/admin/clients")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h2 className="font-display text-2xl font-bold text-foreground">{client.name}</h2>
          <Badge className={client.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"}>
            {client.status === "active" ? "Active" : "Suspended"}
          </Badge>
        </div>
      </div>

      <Tabs defaultValue="social" className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="social" className="gap-1.5"><Share2 className="h-4 w-4" /> Social</TabsTrigger>
          <TabsTrigger value="leads" className="gap-1.5"><FileSpreadsheet className="h-4 w-4" /> Lead Forms</TabsTrigger>
          <TabsTrigger value="press" className="gap-1.5"><Newspaper className="h-4 w-4" /> Press</TabsTrigger>
          <TabsTrigger value="billing" className="gap-1.5"><CreditCard className="h-4 w-4" /> Billing</TabsTrigger>
          <TabsTrigger value="users" className="gap-1.5"><Users className="h-4 w-4" /> Users</TabsTrigger>
        </TabsList>

        {/* ===== SOCIAL CONNECTORS TAB ===== */}
        <TabsContent value="social" className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-bold text-lg text-foreground">Social Connectors</h3>
              <Button variant="hero" size="sm" onClick={() => setAccountDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add Account
              </Button>
            </div>

            {accounts.length === 0 ? (
              <div className="bg-card border border-border rounded-xl p-10 text-center">
                <Share2 className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm font-body">No social accounts connected.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {accounts.map((account) => (
                  <div key={account.id} className="bg-card border border-border rounded-xl p-4 flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-[#2C4BFF] text-white">
                      <BufferIcon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <p className="font-display font-semibold text-sm text-foreground">{account.account_name}</p>
                      <p className="text-xs text-muted-foreground">Publishing via Agent Portal · Buffer</p>
                      <Badge variant="outline" className="text-xs font-mono gap-1">
                        <Link2 className="h-3 w-3" />
                        {account.platform}
                      </Badge>
                    </div>
                    <Button variant="ghost" size="icon" className="shrink-0 text-destructive" title="Delete" onClick={() => deleteAccountMutation.mutate(account.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ===== LEAD FORMS TAB ===== */}
        <TabsContent value="leads" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-bold text-lg text-foreground">Lead Forms</h3>
            <Button variant="hero" size="sm" onClick={() => { setEditingLeadForm(null); setLfName(""); setLfWebhook(""); setLfSheetUrl(""); setLfColStart("A"); setLfColEnd("F"); setLeadFormDialog(true); }}>
              <Plus className="h-4 w-4 mr-1" /> Add Form
            </Button>
          </div>

          {leadForms.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm font-body">No lead forms configured.</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Form Name</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="w-[100px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leadForms.map((lf) => (
                    <TableRow key={lf.id}>
                      <TableCell className="font-display font-semibold text-sm">{lf.form_name}</TableCell>
                      <TableCell>
                        {(() => {
                          try {
                            const cfg = JSON.parse(lf.webhook_url || "");
                            if (cfg.type === "google_sheet") {
                              return (
                                <Badge variant="outline" className="text-xs gap-1">
                                  <FileSpreadsheet className="h-3 w-3 text-emerald-600" />
                                  Google Sheet · {cfg.col_start}–{cfg.col_end}
                                </Badge>
                              );
                            }
                          } catch {}
                          return lf.webhook_url ? (
                            <Badge variant="outline" className="text-xs font-mono gap-1">
                              <ExternalLink className="h-3 w-3" />
                              {lf.webhook_url.slice(0, 40)}…
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Not configured</span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => {
                            setEditingLeadForm(lf);
                            setLfName(lf.form_name);
                            try {
                              const cfg = JSON.parse(lf.webhook_url || "");
                              if (cfg.type === "google_sheet") {
                                setLfSheetUrl(cfg.sheet_url || "");
                                setLfColStart(cfg.col_start || "A");
                                setLfColEnd(cfg.col_end || "F");
                                setLfWebhook("");
                              } else {
                                setLfWebhook(lf.webhook_url ?? "");
                                setLfSheetUrl(""); setLfColStart("A"); setLfColEnd("F");
                              }
                            } catch {
                              setLfWebhook(lf.webhook_url ?? "");
                              setLfSheetUrl(""); setLfColStart("A"); setLfColEnd("F");
                            }
                            setLeadFormDialog(true);
                          }}>
                            <Settings2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => deleteLeadFormMutation.mutate(lf.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ===== PRESS RELEASES TAB ===== */}
        <TabsContent value="press" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-bold text-lg text-foreground">Press Releases</h3>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Globe className="h-4 w-4 text-emerald-600" /> {totalPublished} published</span>
            </div>
          </div>

          {releases.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <Newspaper className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm font-body">No press releases from this client yet.</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">URLs</TableHead>
                    <TableHead className="text-right">Unique</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releases.map((pr) => {
                    const prStats = getPrAggregatedStats(pr.id);
                    return (
                    <>
                      <TableRow key={pr.id} className="group">
                        <TableCell>
                          <button onClick={() => setExpandedPrId(expandedPrId === pr.id ? null : pr.id)} className="p-1 hover:bg-muted rounded">
                            {expandedPrId === pr.id ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                          </button>
                        </TableCell>
                        <TableCell className="font-display font-semibold text-sm max-w-[200px] truncate">{pr.title}</TableCell>
                        <TableCell><Badge className={statusConfig[pr.status]?.className ?? ""}>{statusConfig[pr.status]?.label ?? pr.status}</Badge></TableCell>
                        <TableCell className="text-right font-mono text-sm">{prStats.count}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{prStats.uniqueVisits.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{prStats.totalVisits.toLocaleString()}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => openPrEdit(pr)}><Edit3 className="h-4 w-4 text-muted-foreground" /></Button>
                        </TableCell>
                      </TableRow>
                      {expandedPrId === pr.id && (
                        <TableRow key={`${pr.id}-detail`}>
                          <TableCell colSpan={7} className="bg-muted/30 px-6 py-4">
                            <div className="grid md:grid-cols-2 gap-4 text-sm">
                              <div>
                                <p className="text-muted-foreground text-xs font-body uppercase tracking-wider mb-1">Content</p>
                                <p className="text-foreground font-body whitespace-pre-line line-clamp-6">{pr.content || "—"}</p>
                              </div>
                              <div className="space-y-3">
                                {pr.admin_comment && (
                                  <div>
                                    <p className="text-muted-foreground text-xs font-body uppercase tracking-wider mb-1 flex items-center gap-1"><MessageSquare className="h-3 w-3" /> Admin Comment</p>
                                    <p className="text-foreground font-body bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-sm border border-amber-200 dark:border-amber-800">{pr.admin_comment}</p>
                                  </div>
                                )}
                                <div className="flex gap-6">
                                  <div>
                                    <p className="text-muted-foreground text-xs font-body">Created</p>
                                    <p className="text-foreground text-xs">{new Date(pr.created_at).toLocaleDateString()}</p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ===== BILLING TAB ===== */}
        <TabsContent value="billing" className="space-y-4">
          <BillingTab clientId={clientId!} clientUsers={clientMembers} />
        </TabsContent>

        {/* ===== CLIENT USERS TAB ===== */}
        <TabsContent value="users" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-bold text-lg text-foreground">Client Users</h3>
            <Button variant="hero" size="sm" onClick={() => setInviteDialog(true)}>
              <UserPlus className="h-4 w-4 mr-1" /> Invite User
            </Button>
          </div>

          {clientMembers.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <Users className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm font-body">No users assigned to this client.</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[80px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientMembers.map((cu) => (
                    <TableRow key={cu.id}>
                      <TableCell className="font-body text-sm">{cu.email ?? "—"}</TableCell>
                      <TableCell className="font-body text-sm text-muted-foreground">{cu.fullName ?? "—"}</TableCell>
                      <TableCell className="font-body text-sm">
                        <Badge variant={cu.status === "active" ? "default" : "secondary"} className="text-xs">
                          {cu.status === "active" ? "Active" : "Invited"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" title="Remove access" onClick={() => {
                          setConfirmAction({
                            title: "Remove Access",
                            description: `Remove ${cu.email ?? "this user"}'s access to this client?`,
                            onConfirm: () => removeMemberMutation.mutate(cu.id),
                          });
                        }}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ===== DIALOGS ===== */}

      {/* Add Social Accounts via Buffer (Agent Portal connector) */}
      <Dialog open={accountDialogOpen} onOpenChange={(open) => {
        setAccountDialogOpen(open);
        if (!open) resetConnectDialog();
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Connect Social Accounts</DialogTitle>
          </DialogHeader>

          {connectStep === "key" ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="font-body">Buffer API Key</Label>
                <Input placeholder="Paste your Buffer API key" value={bufferToken} onChange={(e) => setBufferToken(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  Create one at{" "}
                  <a href="https://buffer.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">buffer.com</a>
                  {" → Settings → API. The key is stored securely in your Agent Portal org, never in this app."}
                </p>
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-400">
                  <strong>⚠️ Treat this key like a password.</strong> It grants publishing access to your Buffer channels.
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button variant="hero" onClick={discoverBufferPlatforms} disabled={!bufferToken.trim() || connectLoading}>
                  {connectLoading ? "Checking key…" : "Discover Channels"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="font-body">Connected Buffer Channels</Label>
                <p className="text-xs text-muted-foreground">Select the platforms you want to publish to.</p>
                <div className="space-y-2 max-h-[280px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
                  {discoveredPlatforms.map((platform) => {
                    const cfg = platformConfig[platform as Platform];
                    const Icon = cfg?.icon ?? Share2;
                    const isChecked = selectedPlatforms.has(platform);
                    return (
                      <label key={platform} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer">
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={(checked) => {
                            const next = new Set(selectedPlatforms);
                            if (checked) next.add(platform); else next.delete(platform);
                            setSelectedPlatforms(next);
                          }}
                        />
                        <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${cfg?.color ?? "bg-muted text-foreground"}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-body font-medium text-foreground truncate">{cfg?.label ?? platform}</p>
                        </div>
                        <Badge variant="secondary" className="text-xs shrink-0">via Buffer</Badge>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <button className="hover:text-foreground" onClick={() => {
                  if (selectedPlatforms.size === discoveredPlatforms.length) setSelectedPlatforms(new Set());
                  else setSelectedPlatforms(new Set(discoveredPlatforms));
                }}>
                  {selectedPlatforms.size === discoveredPlatforms.length ? "Deselect all" : "Select all"}
                </button>
                <span>{selectedPlatforms.size} of {discoveredPlatforms.length} selected</span>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConnectStep("key")}>Back</Button>
                <Button variant="hero" onClick={() => connectAllMutation.mutate()} disabled={selectedPlatforms.size === 0 || connectAllMutation.isPending}>
                  {connectAllMutation.isPending ? "Connecting…" : `Connect ${selectedPlatforms.size} Account${selectedPlatforms.size !== 1 ? "s" : ""}`}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Lead Form Dialog */}
      <Dialog open={leadFormDialog} onOpenChange={setLeadFormDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">{editingLeadForm ? "Edit Lead Form" : "New Lead Form"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">Form Name</Label>
              <Input placeholder="e.g. Facebook Lead Ads" value={lfName} onChange={(e) => setLfName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label className="font-body">Google Sheet URL</Label>
              <Input placeholder="https://docs.google.com/spreadsheets/d/..." value={lfSheetUrl} onChange={(e) => { setLfSheetUrl(e.target.value); if (e.target.value.trim()) setLfWebhook(""); }} />
              <p className="text-xs text-muted-foreground">Paste the Google Sheets share link. The sheet must be shared as "Anyone with the link".</p>
            </div>

            {lfSheetUrl.trim() && (
              <div className="flex gap-3">
                <div className="space-y-2 flex-1">
                  <Label className="font-body">Show from column</Label>
                  <Input placeholder="A" value={lfColStart} onChange={(e) => setLfColStart(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} maxLength={2} className="uppercase" />
                </div>
                <div className="space-y-2 flex-1">
                  <Label className="font-body">To column</Label>
                  <Input placeholder="F" value={lfColEnd} onChange={(e) => setLfColEnd(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} maxLength={2} className="uppercase" />
                </div>
              </div>
            )}

            {!lfSheetUrl.trim() && (
              <div className="space-y-2">
                <Label className="font-body text-muted-foreground">Or: Webhook URL</Label>
                <Input placeholder="https://example.com/webhooks/leads" value={lfWebhook} onChange={(e) => setLfWebhook(e.target.value)} />
                <p className="text-xs text-muted-foreground">Alternative: receive leads via an inbound webhook.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => saveLeadFormMutation.mutate()} disabled={!lfName.trim() || saveLeadFormMutation.isPending}>
              {saveLeadFormMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Press Release Edit Dialog — with URL management */}
      <Dialog open={prDialog} onOpenChange={setPrDialog}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">
              Manage Press Release
              {editingPr && <span className="text-muted-foreground text-sm font-body ml-2">— {editingPr.title}</span>}
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="details" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
              <TabsTrigger value="urls" className="flex-1">
                URLs ({editingPr ? (prUrlsByReleaseId[editingPr.id] || []).length : 0})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label className="font-body">Status</Label>
                <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={prStatus} onChange={(e) => setPrStatus(e.target.value)}>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="published">Published</option>
                  <option value="unpublished">Unpublished</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="font-body flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" /> Admin Comment</Label>
                <Textarea placeholder="Feedback for the client…" value={prComment} onChange={(e) => setPrComment(e.target.value)} rows={3} />
              </div>
            </TabsContent>

            <TabsContent value="urls" className="space-y-4 pt-2">
              <div className="border border-border rounded-lg p-4 space-y-3">
                <p className="text-sm font-display font-semibold">Add URL</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">URL *</Label>
                    <Input placeholder="https://..." value={newPrUrl} onChange={(e) => setNewPrUrl(e.target.value)} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Outlet Name</Label>
                    <Input placeholder="e.g. Forbes" value={newPrOutlet} onChange={(e) => setNewPrOutlet(e.target.value)} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unique Visits</Label>
                    <Input type="number" value={newPrUniqueVisits} onChange={(e) => setNewPrUniqueVisits(Number(e.target.value))} className="text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Total Visits</Label>
                    <Input type="number" value={newPrTotalVisits} onChange={(e) => setNewPrTotalVisits(Number(e.target.value))} className="text-sm" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddPrUrl} disabled={!newPrUrl.trim() || addPrUrlMutation.isPending}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => csvPrInputRef.current?.click()}>
                    <FileUp className="h-3.5 w-3.5 mr-1" /> Import CSV
                  </Button>
                   <input ref={csvPrInputRef} type="file" accept=".csv" className="hidden" onChange={handlePrCsvImport} />
                </div>
                <p className="text-xs text-muted-foreground">Expected CSV columns: url, outlet_name, unique_visits, total_visits</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="relative w-48">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input placeholder="Search…" value={prUrlSearch} onChange={(e) => setPrUrlSearch(e.target.value)} className="pl-8 h-8 text-xs" />
                  </div>
                  {selectedPrUrlIds.size > 0 && (
                    <Button size="sm" variant="destructive" onClick={handlePrBulkDelete} disabled={deletePrUrlsMutation.isPending}>
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete {selectedPrUrlIds.size}
                    </Button>
                  )}
                </div>
                <div className="border border-border rounded-lg overflow-hidden max-h-80 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={filteredPrDialogUrls.length > 0 && selectedPrUrlIds.size === filteredPrDialogUrls.length}
                            onCheckedChange={(checked) => {
                              if (checked) setSelectedPrUrlIds(new Set(filteredPrDialogUrls.map((u) => u.id)));
                              else setSelectedPrUrlIds(new Set());
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
                      {filteredPrDialogUrls.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                            No URLs yet. Add manually or import a CSV.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPrDialogUrls.map((u) => (
                          <TableRow key={u.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedPrUrlIds.has(u.id)}
                                onCheckedChange={(checked) => {
                                  const next = new Set(selectedPrUrlIds);
                                  if (checked) next.add(u.id); else next.delete(u.id);
                                  setSelectedPrUrlIds(next);
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
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => savePrMutation.mutate()} disabled={savePrMutation.isPending}>
              <Save className="h-4 w-4 mr-1" /> {savePrMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite User Dialog */}
      <Dialog open={inviteDialog} onOpenChange={setInviteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="font-display">Invite User</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">Email</Label>
              <Input placeholder="user@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                They'll get access to this client automatically the first time they sign up with this email.
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => inviteMemberMutation.mutate()} disabled={!inviteEmail.trim() || inviteMemberMutation.isPending}>
              <UserPlus className="h-4 w-4 mr-1" /> {inviteMemberMutation.isPending ? "Inviting…" : "Send Invite"}
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
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ClientDetail;
