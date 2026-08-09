import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BillingTab } from "@/components/BillingTab";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft, Share2, Users, Newspaper, FileSpreadsheet,
  Plus, Trash2, Settings2, Link2, ExternalLink,
  Facebook, Instagram, Linkedin, Youtube, Twitter,
  Eye, TrendingUp, MessageSquare, Globe, Save,
  Edit3, X, ChevronDown, ChevronUp,
  UserPlus, KeyRound,
  Building2, Search, FileUp, Link,
  Receipt, CreditCard, Loader2, Download, Send,
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Platform = "facebook" | "instagram" | "linkedin" | "youtube" | "twitter";

interface ChannelConfig {
  platform: Platform;
  name: string;
  channel_url: string;
}

interface SocialAccount {
  id: string;
  client_id: string;
  platform: string;
  account_name: string;
  webhook_url: string | null;
  connected_at: string;
  user_id: string;
  mcp_url?: string | null;
  mcp_tool_name?: string | null;
  page_config?: Record<string, any> | null;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
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

interface ClientUser {
  id: string;
  user_id: string;
  client_id: string;
  profiles?: { email: string | null; full_name: string | null } | null;
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

const allPlatforms: Platform[] = ["facebook", "twitter", "linkedin", "youtube", "instagram"];

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  submitted: { label: "Submitted", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" },
  published: { label: "Published", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" },
  unpublished: { label: "Unpublished", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
};

function parseCSV(text: string): { url: string; outlet_name: string; unique_visits: number; total_visits: number }[] {
  const normalizeCell = (value: string) => value.trim().replace(/^"|"$/g, "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstRow = lines[0].split(",").map((cell) => normalizeCell(cell).toLowerCase());
  const hasHeader = firstRow.includes("url");
  const rows = hasHeader ? lines.slice(1) : lines;

  return rows
    .map((line) => line.split(",").map(normalizeCell))
    .map(([url = "", outlet_name = "", unique_visits = "0", total_visits = "0"]) => ({
      url,
      outlet_name,
      unique_visits: Number(unique_visits) || 0,
      total_visits: Number(total_visits) || 0,
    }))
    .filter((row) => row.url.trim().length > 0);
}

const getChannelsFromConfig = (pageConfig: Record<string, any> | null | undefined): ChannelConfig[] => {
  const channels = Array.isArray(pageConfig?.channels) ? pageConfig.channels : [];
  if (channels.length === 0) {
    return allPlatforms.map((platform) => ({ platform, name: "", channel_url: "" }));
  }
  return allPlatforms.map((platform) => {
    const existing = channels.find((channel: ChannelConfig) => channel.platform === platform);
    return existing ?? { platform, name: "", channel_url: "" };
  });
};

const getConfiguredChannels = (pageConfig: Record<string, any> | null | undefined): ChannelConfig[] => {
  return getChannelsFromConfig(pageConfig).filter((channel) => channel.channel_url.trim() !== "");
};

const ClientDetail = () => {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [newPlatform, setNewPlatform] = useState<Platform>("linkedin");
  const [newAccountName, setNewAccountName] = useState("");
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [selectedMcpTool, setSelectedMcpTool] = useState<string>("");
  const [selectedMcpToolNames, setSelectedMcpToolNames] = useState<Set<string>>(new Set());
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpStep, setMcpStep] = useState<"url" | "select">("url");

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

  const [userEmail, setUserEmail] = useState("");
  const [newUserDialog, setNewUserDialog] = useState(false);
  const [newUserFullName, setNewUserFullName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [resetPwDialog, setResetPwDialog] = useState(false);
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ title: string; description: string; onConfirm: () => void } | null>(null);

  const { data: client } = useQuery({
    queryKey: ["client", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("clients").select("*").eq("id", clientId).single();
      if (error) throw error;
      return data as { id: string; name: string; status: string; created_at: string };
    },
    enabled: !!clientId,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["client-accounts", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("social_accounts").select("*").eq("client_id", clientId).order("connected_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SocialAccount[];
    },
    enabled: !!clientId,
  });

  const { data: leadForms = [] } = useQuery({
    queryKey: ["lead-forms", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("lead_forms").select("*").eq("client_id", clientId).order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as LeadForm[];
    },
    enabled: !!clientId,
  });

  const { data: releases = [] } = useQuery({
    queryKey: ["client-press-releases", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("press_releases").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PressRelease[];
    },
    enabled: !!clientId,
  });

  const releaseIds = releases.map((release) => release.id);
  const { data: allPrUrls = [] } = useQuery({
    queryKey: ["client-pr-urls", releaseIds],
    queryFn: async () => {
      if (releaseIds.length === 0) return [];
      const { data, error } = await (supabase as any)
        .from("press_release_urls").select("*").in("press_release_id", releaseIds).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PressReleaseUrl[];
    },
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

  const { data: clientUsers = [] } = useQuery({
    queryKey: ["client-users", clientId],
    queryFn: async () => {
      const { data: mappings, error: mappingsError } = await (supabase as any)
        .from("client_users")
        .select("id, user_id, client_id")
        .eq("client_id", clientId);

      if (mappingsError) throw mappingsError;

      const rows = (mappings ?? []) as ClientUser[];
      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];

      if (userIds.length === 0) return rows;

      const [profilesRes, rolesRes] = await Promise.all([
        (supabase as any).from("profiles").select("id, email, full_name").in("id", userIds),
        (supabase as any).from("user_roles").select("user_id, role").in("user_id", userIds),
      ]);

      const profileMap = new Map(
        ((profilesRes.data ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>).map((p) => [
          p.id,
          { email: p.email, full_name: p.full_name },
        ])
      );

      const roleMap = new Map<string, string[]>();
      for (const r of (rolesRes.data ?? []) as Array<{ user_id: string; role: string }>) {
        const existing = roleMap.get(r.user_id) || [];
        existing.push(r.role);
        roleMap.set(r.user_id, existing);
      }

      return rows.map((row) => ({
        ...row,
        profiles: profileMap.get(row.user_id) ?? null,
        roles: roleMap.get(row.user_id) ?? [],
      }));
    },
    enabled: !!clientId,
  });

  const utilityToolPatterns = ["get_configuration_url", "list_tools", "get_setup"];

  const filteredMcpTools = mcpTools.filter(
    (tool) => !utilityToolPatterns.some((pattern) => tool.name.toLowerCase().includes(pattern))
  );

  const platformKeywords: Record<string, string[]> = {
    linkedin: ["linkedin"],
    facebook: ["facebook", "fb_"],
    instagram: ["instagram", "ig_"],
    youtube: ["youtube", "yt_"],
    twitter: ["twitter", "x_", "_x_"],
  };

  const detectPlatform = (toolName: string): Platform => {
    const name = toolName.toLowerCase();
    for (const [platform, keywords] of Object.entries(platformKeywords)) {
      if (keywords.some((keyword) => name.includes(keyword))) return platform as Platform;
    }
    return "linkedin";
  };

  const generateAccountName = (toolName: string, platform: Platform): string => {
    const cfg = platformConfig[platform];
    const cleanName = toolName.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
    return `${cfg.label} - ${cleanName}`;
  };

  useEffect(() => {
    if (!selectedMcpTool) return;
    setNewPlatform(detectPlatform(selectedMcpTool));
  }, [selectedMcpTool]);

  const discoverMcpTools = useCallback(async () => {
    if (!newMcpUrl.trim()) return;
    setMcpLoading(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/mcp-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ action: "initialize", mcp_url: newMcpUrl.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!res.ok) throw new Error("Failed to discover tools");
      const tools = data.tools ?? [];
      setMcpTools(tools);

      if (tools.length === 0) {
        await (supabase as any).from("social_accounts").delete().eq("client_id", clientId);
        queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
        toast.info("No connectors found. Existing connectors have been removed.");
        setMcpStep("url");
        return;
      }

      setMcpStep("select");
      const actionTools = tools.filter(
        (tool: McpTool) => !utilityToolPatterns.some((pattern) => tool.name.toLowerCase().includes(pattern))
      );
      setSelectedMcpToolNames(new Set(actionTools.map((tool: McpTool) => tool.name)));
      if (actionTools.length > 0) setSelectedMcpTool(actionTools[0].name);
      else if (tools.length > 0) setSelectedMcpTool(tools[0].name);
    } catch (err: any) {
      await (supabase as any).from("social_accounts").delete().eq("client_id", clientId);
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.error(err.message || "Failed to connect to MCP server. Existing connectors removed.");
    } finally {
      setMcpLoading(false);
    }
  }, [newMcpUrl, clientId, queryClient]);

  const connectAllMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const toolsToConnect = filteredMcpTools.filter((t) => selectedMcpToolNames.has(t.name));
      if (toolsToConnect.length === 0) throw new Error("No tools selected");
      
      await (supabase as any).from("social_accounts").delete().eq("client_id", clientId);

      const rows = toolsToConnect.map((tool) => {
        const platform = detectPlatform(tool.name);
        return {
          client_id: clientId,
          platform,
          account_name: generateAccountName(tool.name, platform),
          webhook_url: null,
          mcp_url: newMcpUrl.trim(),
          mcp_tool_name: tool.name,
          user_id: user!.id,
        };
      });
      const { error } = await (supabase as any).from("social_accounts").insert(rows);
      if (error) throw error;
      return toolsToConnect.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.success(`Connected ${count} account${count > 1 ? "s" : ""}`);
      setAccountDialogOpen(false);
      setNewAccountName(""); setNewWebhookUrl(""); setNewMcpUrl("");
      setMcpTools([]); setSelectedMcpTool(""); setSelectedMcpToolNames(new Set()); setMcpStep("url");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addAccountMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await (supabase as any).from("social_accounts").insert({
        client_id: clientId, platform: newPlatform, account_name: newAccountName.trim(),
        webhook_url: newWebhookUrl.trim() || null, mcp_url: newMcpUrl.trim() || null,
        mcp_tool_name: selectedMcpTool || null, user_id: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.success("Account connected");
      setAccountDialogOpen(false);
      setNewAccountName(""); setNewWebhookUrl(""); setNewMcpUrl("");
      setMcpTools([]); setSelectedMcpTool(""); setMcpStep("url");
    },
    onError: (err: Error) => toast.error(err.message),
  });


  const deleteAccountMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("social_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-accounts", clientId] });
      toast.success("Account removed");
    },
    onError: (err: Error) => toast.error(err.message),
  });


  // ============= LEAD FORMS MUTATIONS =============
  const saveLeadFormMutation = useMutation({
    mutationFn: async () => {
      const sheetConfig = lfSheetUrl.trim() ? JSON.stringify({
        type: "google_sheet",
        sheet_url: lfSheetUrl.trim(),
        col_start: lfColStart.toUpperCase() || "A",
        col_end: lfColEnd.toUpperCase() || "F",
      }) : (lfWebhook.trim() || null);
      const payload = { form_name: lfName.trim(), webhook_url: sheetConfig, client_id: clientId };
      if (editingLeadForm) {
        const { error } = await (supabase as any).from("lead_forms").update(payload).eq("id", editingLeadForm.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("lead_forms").insert(payload);
        if (error) throw error;
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
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("lead_forms").delete().eq("id", id);
      if (error) throw error;
    },
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
      const payload: any = {
        status: prStatus,
        admin_comment: prComment.trim() || null, updated_at: new Date().toISOString(),
      };
      const { error } = await (supabase as any).from("press_releases").update(payload).eq("id", editingPr.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-press-releases", clientId] });
      toast.success("Press release updated");
      setPrDialog(false); setEditingPr(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // URL mutations for press releases
  const addPrUrlMutation = useMutation({
    mutationFn: async ({ pressReleaseId, urls }: { pressReleaseId: string; urls: { url: string; outlet_name: string; unique_visits: number; total_visits: number }[] }) => {
      const rows = urls.map((u) => ({ press_release_id: pressReleaseId, ...u }));
      const { error } = await (supabase as any).from("press_release_urls").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-pr-urls"] });
      toast.success("URLs added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deletePrUrlsMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await (supabase as any).from("press_release_urls").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-pr-urls"] });
      setSelectedPrUrlIds(new Set());
      toast.success("URLs deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ============= CLIENT USERS MUTATIONS =============
  const createUserMutation = useMutation({
    mutationFn: async () => {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/manage-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: "create_user", email: userEmail.trim().toLowerCase(), password: newUserPassword, full_name: newUserFullName.trim(), client_id: clientId }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to create user");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-users", clientId] });
      toast.success("User created and assigned to client");
      setNewUserDialog(false); setUserEmail(""); setNewUserFullName(""); setNewUserPassword("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async () => {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/manage-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: "reset_password", user_id: resetPwUserId, new_password: resetPwValue }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to reset password");
    },
    onSuccess: () => {
      toast.success("Password updated");
      setResetPwDialog(false); setResetPwUserId(null); setResetPwValue("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/manage-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: "delete_user", user_id: userId }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to delete user");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-users", clientId] });
      toast.success("User deleted");
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
      urls: [{ url: newPrUrl.trim(), outlet_name: newPrOutlet.trim(), unique_visits: newPrUniqueVisits, total_visits: newPrTotalVisits }],
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
          {/* Connector Section */}
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
                {accounts.map((account) => {
                  const configuredChannels = getConfiguredChannels(account.page_config);
                  return (
                    <div key={account.id} className="bg-card border border-border rounded-xl p-4 flex items-start gap-4">
                      {/* Buffer icon */}
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-[#2C4BFF] text-white">
                        <BufferIcon className="h-5 w-5" />
                      </div>

                      {/* Account info */}
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <p className="font-display font-semibold text-sm text-foreground">{account.account_name}</p>
                        <p className="text-xs text-muted-foreground">Buffer Create Idea</p>
                        {account.mcp_tool_name && (
                          <Badge variant="outline" className="text-xs font-mono gap-1">
                            <Link2 className="h-3 w-3" />
                            {account.mcp_tool_name.replace(/_/g, " ")}
                          </Badge>
                        )}
                        {/* Show configured channel icons */}
                        {configuredChannels.length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap pt-1">
                            {configuredChannels.map((ch) => {
                              const cfg = platformConfig[ch.platform];
                              if (!cfg) return null;
                              const Icon = cfg.icon;
                              return (
                                <div key={ch.platform} className="flex items-center gap-1.5" title={`${cfg.label}: ${ch.name}`}>
                                  <div className={`w-6 h-6 rounded-md flex items-center justify-center ${cfg.color}`}>
                                    <Icon className="h-3 w-3" />
                                  </div>
                                  {ch.name && <span className="text-xs text-muted-foreground">{ch.name}</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {configuredChannels.length === 0 && (
                          <p className="text-xs text-muted-foreground/60 italic">No channels configured — click Edit to set up</p>
                        )}
                      </div>

                      {/* Actions */}
                      <Button variant="ghost" size="icon" className="shrink-0 text-destructive" title="Delete" onClick={() => deleteAccountMutation.mutate(account.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
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
          <BillingTab clientId={clientId!} clientUsers={clientUsers} />
        </TabsContent>

        {/* ===== CLIENT USERS TAB ===== */}
        <TabsContent value="users" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-bold text-lg text-foreground">Client Users</h3>
            <Button variant="hero" size="sm" onClick={() => setNewUserDialog(true)}>
              <UserPlus className="h-4 w-4 mr-1" /> Create User
            </Button>
          </div>

          {clientUsers.length === 0 ? (
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
                    <TableHead>Role</TableHead>
                    <TableHead className="w-[120px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientUsers.map((cu) => (
                    <TableRow key={cu.id}>
                      <TableCell className="font-body text-sm">{cu.profiles?.email ?? cu.user_id}</TableCell>
                      <TableCell className="font-body text-sm text-muted-foreground">{cu.profiles?.full_name ?? "—"}</TableCell>
                      <TableCell className="font-body text-sm">
                        {(cu as any).roles?.length > 0
                          ? (cu as any).roles.map((r: string) => (
                              <span key={r} className="inline-block bg-primary/10 text-primary text-xs font-medium rounded px-2 py-0.5 mr-1">
                                {r.replace("_", " ")}
                              </span>
                            ))
                          : <span className="text-muted-foreground">user</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" title="Reset password" onClick={() => { setResetPwUserId(cu.user_id); setResetPwValue(""); setResetPwDialog(true); }}>
                            <KeyRound className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" title="Delete user" onClick={() => {
                            setConfirmAction({
                              title: "Delete User",
                              description: `Are you sure you want to delete user ${cu.profiles?.email ?? cu.user_id}? This cannot be undone.`,
                              onConfirm: () => deleteUserMutation.mutate(cu.user_id),
                            });
                          }}>
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
      </Tabs>

      {/* ===== DIALOGS ===== */}

      {/* Add Social Account via MCP */}
      <Dialog open={accountDialogOpen} onOpenChange={(open) => {
        setAccountDialogOpen(open);
        if (!open) { setMcpStep("url"); setMcpTools([]); setSelectedMcpTool(""); setSelectedMcpToolNames(new Set()); setNewMcpUrl(""); setNewAccountName(""); setNewPlatform("linkedin"); }
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Connect Social Accounts</DialogTitle>
          </DialogHeader>

          {mcpStep === "url" ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="font-body">Zapier MCP URL (with token)</Label>
                <Input placeholder="https://mcp.zapier.com/api/v1/connect?token=..." value={newMcpUrl} onChange={(e) => setNewMcpUrl(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  Go to{" "}
                  <a href="https://mcp.zapier.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">mcp.zapier.com</a>
                  {" → Connect → copy the \"Full URL\" (Option 2: URL with token)."}
                </p>
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-400">
                  <strong>⚠️ Treat this URL like a password.</strong> It contains your connection token.
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button variant="hero" onClick={discoverMcpTools} disabled={!newMcpUrl.trim() || mcpLoading}>
                  {mcpLoading ? "Discovering…" : "Discover Connectors"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="font-body">Discovered Actions</Label>
                <p className="text-xs text-muted-foreground">Select the pages/actions you want to connect.</p>
                {filteredMcpTools.length === 0 ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">No social media actions found.</p>
                    {mcpTools.length > 0 && <p className="text-xs text-muted-foreground italic">{mcpTools.length} utility tool(s) hidden.</p>}
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[280px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
                    {filteredMcpTools.map((tool) => {
                      const platform = detectPlatform(tool.name);
                      const cfg = platformConfig[platform];
                      if (!cfg) return null;
                      const Icon = cfg.icon;
                      const isChecked = selectedMcpToolNames.has(tool.name);
                      return (
                        <label key={tool.name} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer">
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={(checked) => {
                              const next = new Set(selectedMcpToolNames);
                              if (checked) next.add(tool.name); else next.delete(tool.name);
                              setSelectedMcpToolNames(next);
                            }}
                          />
                          <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${cfg.color}`}>
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-body font-medium text-foreground truncate">{tool.name.replace(/_/g, " ")}</p>
                            {tool.description && <p className="text-xs text-muted-foreground truncate">{tool.description}</p>}
                          </div>
                          <Badge variant="secondary" className="text-xs shrink-0">{cfg.label}</Badge>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              {filteredMcpTools.length > 0 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <button className="hover:text-foreground" onClick={() => {
                    if (selectedMcpToolNames.size === filteredMcpTools.length) setSelectedMcpToolNames(new Set());
                    else setSelectedMcpToolNames(new Set(filteredMcpTools.map(t => t.name)));
                  }}>
                    {selectedMcpToolNames.size === filteredMcpTools.length ? "Deselect all" : "Select all"}
                  </button>
                  <span>{selectedMcpToolNames.size} of {filteredMcpTools.length} selected</span>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setMcpStep("url")}>Back</Button>
                <Button variant="hero" onClick={() => connectAllMutation.mutate()} disabled={selectedMcpToolNames.size === 0 || connectAllMutation.isPending}>
                  {connectAllMutation.isPending ? "Connecting…" : `Connect ${selectedMcpToolNames.size} Account${selectedMcpToolNames.size !== 1 ? "s" : ""}`}
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
                <Label className="font-body text-muted-foreground">Or: Zapier Webhook URL</Label>
                <Input placeholder="https://hooks.zapier.com/hooks/catch/..." value={lfWebhook} onChange={(e) => setLfWebhook(e.target.value)} />
                <p className="text-xs text-muted-foreground">Alternative: receive leads via Zapier webhook.</p>
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
              {/* Add URL */}
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

              {/* URL list */}
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

      {/* Create User Dialog */}
      <Dialog open={newUserDialog} onOpenChange={setNewUserDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="font-display">Create New User</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">Email</Label>
              <Input placeholder="user@company.com" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label className="font-body">Full Name</Label>
              <Input placeholder="John Doe" value={newUserFullName} onChange={(e) => setNewUserFullName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label className="font-body">Password</Label>
              <Input type="password" placeholder="Min 6 characters" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => createUserMutation.mutate()} disabled={!userEmail.trim() || !newUserPassword || newUserPassword.length < 6 || createUserMutation.isPending}>
              <UserPlus className="h-4 w-4 mr-1" /> {createUserMutation.isPending ? "Creating…" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetPwDialog} onOpenChange={setResetPwDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="font-display">Reset Password</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">New Password</Label>
              <Input type="password" placeholder="Min 6 characters" value={resetPwValue} onChange={(e) => setResetPwValue(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => resetPasswordMutation.mutate()} disabled={!resetPwValue || resetPwValue.length < 6 || resetPasswordMutation.isPending}>
              <KeyRound className="h-4 w-4 mr-1" /> {resetPasswordMutation.isPending ? "Updating…" : "Update Password"}
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
