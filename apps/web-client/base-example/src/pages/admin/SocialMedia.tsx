import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useClientContext } from "@/hooks/useClientContext";
import { toast } from "sonner";
import {
  Share2, Plus, Trash2, Clock, FileEdit, Send,
  Facebook, Instagram, Linkedin, Youtube, Twitter,
  Image as ImageIcon, X, Edit3, MoreVertical, ExternalLink,
  Eye, Heart, MessageCircle, Repeat2, BarChart3,
  Link2, MapPin, Users, Globe, Hash, Sparkles,
  ThumbsUp, MousePointerClick, TrendingUp, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { format, formatDistanceToNow } from "date-fns";

// ============= TYPES =============

type Platform = "facebook" | "twitter" | "instagram" | "linkedin" | "youtube";
type PostStatus = "draft" | "scheduled" | "published" | "failed";
type StatusTab = "queue" | "drafts" | "approvals" | "sent";

interface SocialAccount {
  id: string;
  platform: string;
  account_name: string;
  webhook_url: string | null;
  connected_at: string;
  client_id: string;
  mcp_url?: string | null;
  mcp_tool_name?: string | null;
  page_config?: Record<string, any> | null;
}

interface PlatformData {
  [platform: string]: {
    link_url?: string;
    cta?: string;
    location?: string;
    visibility?: string;
    hashtags?: string[];
    video_title?: string;
    video_tags?: string[];
    video_category?: string;
    first_comment?: string;
    alt_texts?: string[];
  };
}

interface SocialPost {
  id: string;
  user_id: string;
  content: string;
  platforms: Platform[];
  status: PostStatus;
  scheduled_at: string | null;
  published_at: string | null;
  media_urls: string[];
  created_at: string;
  updated_at: string;
  account_id: string | null;
  client_id: string | null;
  external_post_id?: string | null;
  platform_data?: PlatformData;
}

interface PostAnalytics {
  id: string;
  post_id: string;
  platform: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  fetched_at: string;
}

// ============= PLATFORM CONFIG =============

const platformConfig: Record<Platform, {
  label: string;
  icon: React.ElementType;
  dotColor: string;
  color: string;
  charLimit: number;
  features: string[];
}> = {
  facebook: {
    label: "Facebook",
    icon: Facebook,
    dotColor: "bg-blue-600",
    color: "bg-blue-600 text-white",
    charLimit: 63206,
    features: ["images", "video", "link", "cta", "location", "targeting", "schedule"],
  },
  twitter: {
    label: "X (Twitter)",
    icon: Twitter,
    dotColor: "bg-neutral-900",
    color: "bg-neutral-900 text-white",
    charLimit: 280,
    features: ["images", "link", "hashtags", "schedule"],
  },
  linkedin: {
    label: "LinkedIn",
    icon: Linkedin,
    dotColor: "bg-blue-700",
    color: "bg-blue-700 text-white",
    charLimit: 3000,
    features: ["images", "video", "link", "visibility", "schedule"],
  },
  youtube: {
    label: "YouTube",
    icon: Youtube,
    dotColor: "bg-red-600",
    color: "bg-red-600 text-white",
    charLimit: 5000,
    features: ["video", "tags", "category", "schedule"],
  },
  instagram: {
    label: "Instagram",
    icon: Instagram,
    dotColor: "bg-pink-500",
    color: "bg-pink-500 text-white",
    charLimit: 2200,
    features: ["images", "video", "hashtags", "location", "schedule"],
  },
};

// ============= STAT ICON MAPPING =============

const statIcons: Record<string, React.ElementType> = {
  reactions: ThumbsUp, likes: Heart, comments: MessageCircle, replies: MessageCircle,
  shares: Repeat2, retweets: Repeat2, reach: Users, impressions: Eye,
  clicks: MousePointerClick, profileVisits: Users, engagement: TrendingUp,
  views: Eye, saves: Heart, watchTime: Clock, ctr: MousePointerClick,
};

// ============= HELPERS =============

const getConnectedPlatforms = (accounts: SocialAccount[]): Platform[] => {
  const platforms = new Set<Platform>();
  for (const acc of accounts) {
    if (platformConfig[acc.platform as Platform]) {
      platforms.add(acc.platform as Platform);
    }
  }
  return ["facebook", "twitter", "linkedin", "youtube", "instagram"].filter(p => platforms.has(p as Platform)) as Platform[];
};

// ============= COMPONENT =============

const SocialMedia = () => {
  const { user } = useAuth();
  const { clientId, isSuperAdmin, loading: selectorLoading } = useClientContext();
  const queryClient = useQueryClient();

  const [selectedPlatform, setSelectedPlatform] = useState<Platform | "all">("all");
  const [statusTab, setStatusTab] = useState<StatusTab>("queue");
  const [postDialogOpen, setPostDialogOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<SocialPost | null>(null);

  // Post form state
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<PostStatus>("draft");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [refreshingStats, setRefreshingStats] = useState<string | null>(null);

  // Platform-specific fields
  const [linkUrl, setLinkUrl] = useState("");
  const [ctaType, setCtaType] = useState("");
  const [location, setLocation] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [hashtags, setHashtags] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [videoTags, setVideoTags] = useState("");
  const [videoCategory, setVideoCategory] = useState("");
  const [firstComment, setFirstComment] = useState("");
  const [expandedStatsId, setExpandedStatsId] = useState<string | null>(null);

  // ============= QUERIES =============

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["social-accounts", clientId],
    queryFn: async () => {
      if (!clientId) return [];
      const { data, error } = await (supabase as any)
        .from("social_accounts").select("*").eq("client_id", clientId).order("connected_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SocialAccount[];
    },
    enabled: !!clientId,
  });

  const { data: posts = [], isLoading: postsLoading } = useQuery({
    queryKey: ["social-media-posts", clientId],
    queryFn: async () => {
      if (!clientId) return [];
      const { data, error } = await (supabase as any)
        .from("social_media_posts").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SocialPost[];
    },
    enabled: !!clientId,
  });

  // Fetch analytics for all posts
  const { data: analyticsMap = {} } = useQuery({
    queryKey: ["post-analytics", clientId],
    queryFn: async () => {
      if (!clientId) return {};
      const postIds = posts.filter(p => p.status === "published").map(p => p.id);
      if (postIds.length === 0) return {};
      const { data, error } = await (supabase as any)
        .from("post_analytics")
        .select("*")
        .in("post_id", postIds);
      if (error) {
        console.error("Failed to fetch analytics:", error);
        return {};
      }
      const map: Record<string, PostAnalytics> = {};
      for (const row of (data ?? [])) {
        map[row.post_id] = row as PostAnalytics;
      }
      return map;
    },
    enabled: !!clientId && posts.length > 0,
  });

  // ============= DERIVED STATE =============

  const connectedPlatforms = getConnectedPlatforms(accounts);

  const filteredAccounts = selectedPlatform === "all"
    ? accounts
    : accounts.filter((a) => a.platform === selectedPlatform);
  const filteredAccountIds = new Set(filteredAccounts.map((a) => a.id));

  const statusFilter: Record<StatusTab, PostStatus[]> = {
    queue: ["scheduled"],
    drafts: ["draft"],
    approvals: ["scheduled"],
    sent: ["published"],
  };

  const filteredPosts = posts.filter((p) => {
    const matchesAccount = selectedPlatform === "all" || filteredAccountIds.has(p.account_id ?? "");
    return matchesAccount && statusFilter[statusTab].includes(p.status);
  });

  const allVisiblePosts = posts.filter((p) =>
    selectedPlatform === "all" || filteredAccountIds.has(p.account_id ?? "")
  );
  const tabCounts: Record<StatusTab, number> = {
    queue: allVisiblePosts.filter((p) => p.status === "scheduled").length,
    drafts: allVisiblePosts.filter((p) => p.status === "draft").length,
    approvals: allVisiblePosts.filter((p) => p.status === "scheduled").length,
    sent: allVisiblePosts.filter((p) => p.status === "published").length,
  };

  // ============= REFRESH STATS =============

  const refreshStats = async (post: SocialPost) => {
    const account = accounts.find((a) => a.id === post.account_id);
    if (!account?.mcp_url) {
      toast.error("No MCP connector configured for this account.");
      return;
    }
    if (!post.external_post_id) {
      toast.error("No LinkedIn URN found. Stats can only be fetched for posts published through the app.");
      return;
    }

    setRefreshingStats(post.id);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/fetch-linkedin-analytics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          post_id: post.id,
          mcp_url: account.mcp_url,
        }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        toast.success("Analytics refreshed!");
        queryClient.invalidateQueries({ queryKey: ["post-analytics", clientId] });
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to fetch analytics.");
    } finally {
      setRefreshingStats(null);
    }
  };

  // ============= MUTATIONS =============

  const saveMutation = useMutation({
    mutationFn: async (post: Partial<SocialPost> & { id?: string }) => {
      let mediaUrls: string[] = editingPost?.media_urls ?? [];
      if (mediaFiles.length > 0) {
        setUploading(true);
        for (const file of mediaFiles) {
          const ext = file.name.split(".").pop();
          const path = `${crypto.randomUUID()}.${ext}`;
          const { error: uploadError } = await supabase.storage.from("social-media").upload(path, file);
          if (uploadError) throw uploadError;
          const { data: urlData } = supabase.storage.from("social-media").getPublicUrl(path);
          mediaUrls = [...mediaUrls, urlData.publicUrl];
        }
        setUploading(false);
      }

      const account = accounts.find((a) => a.id === selectedAccountId);
      const pType = account?.platform as Platform | undefined;

      // Build platform_data from form fields
      const platformDataObj: PlatformData = {};
      if (pType) {
        const pd: PlatformData[string] = {};
        if (linkUrl) pd.link_url = linkUrl;
        if (ctaType && ctaType !== "none") pd.cta = ctaType;
        if (location) pd.location = location;
        if (visibility && visibility !== "public") pd.visibility = visibility;
        if (hashtags.trim()) pd.hashtags = hashtags.trim().split(/\s+/);
        if (videoTitle) pd.video_title = videoTitle;
        if (videoTags.trim()) pd.video_tags = videoTags.trim().split(/,\s*/);
        if (videoCategory) pd.video_category = videoCategory;
        if (firstComment) pd.first_comment = firstComment;
        if (Object.keys(pd).length > 0) platformDataObj[pType] = pd;
      }

      const payload = {
        content: post.content,
        platforms: account ? [account.platform] : post.platforms || [],
        status: post.status,
        scheduled_at: post.scheduled_at || null,
        media_urls: mediaUrls,
        user_id: user!.id,
        account_id: selectedAccountId,
        client_id: clientId,
        updated_at: new Date().toISOString(),
        platform_data: platformDataObj,
      };
      if (post.id) {
        const { error } = await (supabase as any).from("social_media_posts").update(payload).eq("id", post.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("social_media_posts").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social-media-posts", clientId] });
      toast.success(editingPost ? "Post updated" : "Post created");
      closePostDialog();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("social_media_posts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social-media-posts", clientId] });
      toast.success("Post deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const publishPost = async (post: SocialPost) => {
    const account = accounts.find((a) => a.id === post.account_id);
    if (!account) { toast.error("Account not found."); return; }
    const hasMcp = account.mcp_url && account.mcp_tool_name;
    const hasWebhook = account.webhook_url;
    if (!hasMcp && !hasWebhook) { toast.error("No MCP connector or webhook configured."); return; }

    setPublishing(true);
    try {
      let externalPostId: string | null = null;

      if (hasMcp) {
        const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
        const res = await fetch(`https://${projectId}.supabase.co/functions/v1/mcp-proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({
            action: "invoke", mcp_url: account.mcp_url, tool_name: account.mcp_tool_name,
            tool_args: {
              content: post.content,
              media_urls: post.media_urls,
              platform: account.platform,
              account_name: account.account_name,
              scheduled_at: post.scheduled_at,
            },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "MCP invocation failed");

        // Try to extract LinkedIn share URN from MCP response
        try {
          const result = data.result;
          if (result?.content) {
            for (const item of (Array.isArray(result.content) ? result.content : [])) {
              if (item?.type === "text" && item.text) {
                const parsed = JSON.parse(item.text);
                // LinkedIn returns the share URN in various places
                externalPostId = parsed?.id || parsed?.activity || parsed?.updateUrl || parsed?.urn || null;
                if (externalPostId) break;
              }
            }
          }
          if (!externalPostId && result?.id) {
            externalPostId = result.id;
          }
        } catch {
          // Non-critical - just means we can't track this post's analytics
          console.warn("Could not extract external post ID from MCP response");
        }

        toast.success("Published via Zapier MCP connector.");
      } else {
        await fetch(account.webhook_url!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          mode: "no-cors",
          body: JSON.stringify({
            content: post.content, media_urls: post.media_urls, platform: account.platform,
            account_name: account.account_name, scheduled_at: post.scheduled_at,
            timestamp: new Date().toISOString(), triggered_from: window.location.origin,
          }),
        });
        toast.success("Request sent to Zapier — check your Zap history.");
      }

      // Update post status and store external_post_id if available
      const updatePayload: any = {
        status: "published",
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (externalPostId) {
        updatePayload.external_post_id = externalPostId;
      }

      await (supabase as any).from("social_media_posts").update(updatePayload).eq("id", post.id);
      queryClient.invalidateQueries({ queryKey: ["social-media-posts", clientId] });
    } catch (err: any) {
      toast.error(err.message || "Failed to publish.");
    } finally {
      setPublishing(false);
    }
  };

  // ============= DIALOG HELPERS =============

  const resetFormFields = () => {
    setLinkUrl(""); setCtaType(""); setLocation(""); setVisibility("public");
    setHashtags(""); setVideoTitle(""); setVideoTags(""); setVideoCategory("");
    setFirstComment("");
  };

  const openNewPost = () => {
    setEditingPost(null); setContent(""); setStatus("draft"); setScheduledAt(""); setMediaFiles([]);
    resetFormFields();
    if (filteredAccounts.length > 0) setSelectedAccountId(filteredAccounts[0].id);
    setPostDialogOpen(true);
  };

  const openEditPost = (post: SocialPost) => {
    setEditingPost(post); setContent(post.content); setStatus(post.status);
    setScheduledAt(post.scheduled_at ? post.scheduled_at.slice(0, 16) : "");
    setMediaFiles([]); setSelectedAccountId(post.account_id);
    resetFormFields();
    // Populate platform-specific fields from stored platform_data
    const account = accounts.find(a => a.id === post.account_id);
    const pType = account?.platform as Platform | undefined;
    if (pType && post.platform_data?.[pType]) {
      const pd = post.platform_data[pType];
      if (pd.link_url) setLinkUrl(pd.link_url);
      if (pd.cta) setCtaType(pd.cta);
      if (pd.location) setLocation(pd.location);
      if (pd.visibility) setVisibility(pd.visibility);
      if (pd.hashtags) setHashtags(pd.hashtags.join(" "));
      if (pd.video_title) setVideoTitle(pd.video_title);
      if (pd.video_tags) setVideoTags(pd.video_tags.join(", "));
      if (pd.video_category) setVideoCategory(pd.video_category);
      if (pd.first_comment) setFirstComment(pd.first_comment);
    }
    setPostDialogOpen(true);
  };

  const closePostDialog = () => {
    setPostDialogOpen(false); setEditingPost(null); setMediaFiles([]);
    resetFormFields();
  };

  const handleSave = () => {
    if (!content.trim()) return toast.error("Content is required");
    if (!selectedAccountId) return toast.error("Select an account first");
    if (status === "scheduled" && !scheduledAt) return toast.error("Pick a schedule date");
    saveMutation.mutate({
      id: editingPost?.id, content, status,
      scheduled_at: status === "scheduled" ? new Date(scheduledAt).toISOString() : null,
    });
  };

  // Get selected account's platform for conditional fields
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const selectedPlatformType = selectedAccount?.platform as Platform | undefined;
  const selectedPlatformCfg = selectedPlatformType ? platformConfig[selectedPlatformType] : null;

  // ============= LOADING / EMPTY STATES =============

  if (selectorLoading) {
    return <div className="flex items-center justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  if (!clientId && !isSuperAdmin) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <Share2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <h3 className="font-display font-semibold text-foreground mb-1">No client account linked</h3>
        <p className="text-muted-foreground text-sm font-body">Ask your super admin to assign you to a client account.</p>
      </div>
    );
  }

  if (!clientId) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <Share2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <h3 className="font-display font-semibold text-foreground mb-1">Select a client</h3>
        <p className="text-muted-foreground text-sm font-body">Choose a client from the header to manage their social media.</p>
      </div>
    );
  }

  // Group posts by date
  const groupedPosts: Record<string, SocialPost[]> = {};
  filteredPosts.forEach((post) => {
    const dateKey = format(new Date(post.created_at), "EEEE, MMMM d");
    if (!groupedPosts[dateKey]) groupedPosts[dateKey] = [];
    groupedPosts[dateKey].push(post);
  });

  // ============= RENDER =============

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-foreground">Social Media</h2>
          <p className="text-muted-foreground font-body text-sm">Create, schedule, and publish posts to connected accounts.</p>
        </div>
        {connectedPlatforms.length > 0 && (
          <Button variant="hero" size="sm" onClick={openNewPost}>
            <Plus className="h-4 w-4 mr-1" /> New Post
          </Button>
        )}
      </div>

      {accountsLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading accounts…</div>
      ) : connectedPlatforms.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Share2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <h3 className="font-display font-semibold text-foreground mb-1">No social accounts connected</h3>
          <p className="text-muted-foreground text-sm font-body">
            {isSuperAdmin ? "Go to the client detail page to connect Zapier MCP connectors." : "Ask your super admin to connect social media accounts."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Platform filter bar */}
          <div className="flex items-center gap-4 border-b border-border pb-3 flex-wrap">
            {(["facebook", "twitter", "linkedin", "youtube", "instagram"] as Platform[]).map((p) => {
              const cfg = platformConfig[p];
              const isConnected = connectedPlatforms.includes(p);
              const isActive = selectedPlatform === p;
              const Icon = cfg.icon;
              return (
                <button
                  key={p}
                  onClick={() => isConnected && setSelectedPlatform(isActive ? "all" : p)}
                  disabled={!isConnected}
                  className={`flex items-center gap-2 px-1 py-1 text-sm font-body transition-colors ${
                    !isConnected
                      ? "opacity-30 cursor-not-allowed"
                      : isActive
                        ? "text-foreground font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? cfg.dotColor : "bg-muted-foreground/30"}`} />
                  {cfg.label}
                </button>
              );
            })}
            {selectedPlatform !== "all" && (
              <button onClick={() => setSelectedPlatform("all")} className="text-xs text-muted-foreground hover:text-foreground ml-auto">
                Show all
              </button>
            )}
          </div>

          {/* Status tabs */}
          <div className="flex items-center gap-6 flex-wrap">
            {(["queue", "drafts", "approvals", "sent"] as StatusTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setStatusTab(tab)}
                className={`text-sm font-body pb-1 border-b-2 transition-colors flex items-center gap-1.5 ${
                  statusTab === tab
                    ? "border-primary text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab === "queue" ? "Queue" : tab === "drafts" ? "Drafts" : tab === "approvals" ? (
                  <><Sparkles className="h-3.5 w-3.5" /> Approvals</>
                ) : "Sent"}
                <span className="text-xs opacity-60">{tabCounts[tab]}</span>
              </button>
            ))}
          </div>

          {/* Post feed */}
          {postsLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading…</div>
          ) : filteredPosts.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <FileEdit className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <h3 className="font-display font-semibold text-foreground mb-1">
                No {statusTab === "queue" ? "queued" : statusTab === "drafts" ? "draft" : statusTab === "approvals" ? "pending" : "sent"} posts
              </h3>
              <p className="text-muted-foreground text-sm font-body">
                {statusTab === "approvals" ? "Posts awaiting review will appear here." : "Create a post to get started."}
              </p>
            </div>
          ) : (
            <div className="space-y-6 max-w-2xl">
              {Object.entries(groupedPosts).map(([dateLabel, datePosts]) => (
                <div key={dateLabel}>
                  <p className="text-xs font-body text-muted-foreground mb-3 uppercase tracking-wider">{dateLabel}</p>
                  <div className="space-y-4">
                    {datePosts.map((post) => {
                      const account = accounts.find((a) => a.id === post.account_id);
                      const pType = account?.platform as Platform;
                      const cfg = pType ? platformConfig[pType] : null;
                      const Icon = cfg?.icon ?? Share2;
                      const timeStr = format(new Date(post.created_at), "h:mm a");
                      const agoStr = formatDistanceToNow(new Date(post.created_at), { addSuffix: true });
                      const analytics = analyticsMap[post.id] as PostAnalytics | undefined;
                      const hasAnalytics = !!analytics;
                      const isExpanded = expandedStatsId === post.id;
                      const isRefreshing = refreshingStats === post.id;

                      return (
                        <div key={post.id} className="flex gap-3">
                          <div className="text-xs text-muted-foreground font-body pt-4 w-16 shrink-0 text-right">
                            {timeStr}
                          </div>
                          <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden">
                            {/* Card header */}
                            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg?.color ?? "bg-muted text-muted-foreground"}`}>
                                <Icon className="h-4 w-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="font-display font-semibold text-sm text-foreground truncate">{account?.account_name ?? "Unknown"}</p>
                              </div>
                              {/* Real stats in header for published posts */}
                              {hasAnalytics && (
                                <button
                                  onClick={() => setExpandedStatsId(isExpanded ? null : post.id)}
                                  className="flex items-center gap-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> {analytics.impressions}</span>
                                  <span className="flex items-center gap-1"><Heart className="h-3 w-3" /> {analytics.likes}</span>
                                  <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {analytics.comments}</span>
                                  <BarChart3 className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "text-primary" : ""}`} />
                                </button>
                              )}
                              {/* Refresh stats button for published LinkedIn posts */}
                              {post.status === "published" && pType === "linkedin" && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  disabled={isRefreshing}
                                  onClick={() => refreshStats(post)}
                                  title="Refresh LinkedIn analytics"
                                >
                                  <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
                                </Button>
                              )}
                            </div>

                            {/* Card body */}
                            <div className="px-4 py-3">
                              <p className="text-sm font-body text-foreground whitespace-pre-line line-clamp-4">
                                {post.content}
                              </p>
                              {post.content.length > 280 && (
                                <button className="text-xs text-primary hover:underline mt-1">see more</button>
                              )}
                              {/* Platform metadata badges */}
                              {(() => {
                                const pd = post.platform_data;
                                if (!pd) return null;
                                const pData = pType ? pd[pType] : null;
                                if (!pData) return null;
                                return (
                                  <div className="flex flex-wrap gap-1.5 mt-2">
                                    {pData.location && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><MapPin className="h-2.5 w-2.5" />{pData.location}</Badge>
                                    )}
                                    {pData.hashtags && pData.hashtags.length > 0 && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><Hash className="h-2.5 w-2.5" />{pData.hashtags.length} tags</Badge>
                                    )}
                                    {pData.link_url && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><Link2 className="h-2.5 w-2.5" />Link</Badge>
                                    )}
                                    {pData.cta && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><MousePointerClick className="h-2.5 w-2.5" />{pData.cta.replace(/_/g, " ")}</Badge>
                                    )}
                                    {pData.visibility && pData.visibility !== "public" && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><Globe className="h-2.5 w-2.5" />{pData.visibility}</Badge>
                                    )}
                                    {pData.first_comment && (
                                      <Badge variant="outline" className="text-[10px] gap-1"><MessageCircle className="h-2.5 w-2.5" />1st comment</Badge>
                                    )}
                                    {pData.video_title && (
                                      <Badge variant="outline" className="text-[10px] gap-1">🎬 {pData.video_title}</Badge>
                                    )}
                                  </div>
                                );
                              })()}
                              {post.media_urls && post.media_urls.length > 0 && (
                                <div className="flex gap-2 mt-3 flex-wrap">
                                  {post.media_urls.map((url, i) => (
                                    <img key={i} src={url} alt="" className="h-20 w-20 rounded-lg object-cover border border-border" />
                                  ))}
                                </div>
                              )}
                              {post.status === "published" && (
                                <div className="mt-2">
                                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                                </div>
                              )}
                            </div>

                            {/* Expanded stats panel — real data */}
                            {hasAnalytics && isExpanded && (() => {
                              const totalEngagements = (analytics.likes || 0) + (analytics.comments || 0) + (analytics.shares || 0) + (analytics.clicks || 0);
                              const engagementRate = analytics.impressions > 0 ? (totalEngagements / analytics.impressions) * 100 : 0;
                              const ctr = analytics.impressions > 0 ? ((analytics.clicks || 0) / analytics.impressions) * 100 : 0;
                              const engagementLabel = engagementRate > 5 ? "High" : engagementRate > 2 ? "Good" : "Low";
                              const engagementColor = engagementRate > 5 ? "text-green-600 bg-green-500/10 border-green-500/20" : engagementRate > 2 ? "text-yellow-600 bg-yellow-500/10 border-yellow-500/20" : "text-red-500 bg-red-500/10 border-red-500/20";

                              const statItems = [
                                { key: "impressions", value: analytics.impressions, icon: Eye, barPct: 100 },
                                { key: "likes", value: analytics.likes, icon: Heart, barPct: analytics.impressions > 0 ? (analytics.likes / analytics.impressions) * 100 : 0 },
                                { key: "comments", value: analytics.comments, icon: MessageCircle, barPct: analytics.impressions > 0 ? (analytics.comments / analytics.impressions) * 100 : 0 },
                                { key: "shares", value: analytics.shares, icon: Repeat2, barPct: analytics.impressions > 0 ? (analytics.shares / analytics.impressions) * 100 : 0 },
                                { key: "clicks", value: analytics.clicks, icon: MousePointerClick, barPct: analytics.impressions > 0 ? (analytics.clicks / analytics.impressions) * 100 : 0 },
                              ];

                              return (
                                <div className="px-4 py-3 border-t border-border bg-muted/20 space-y-3">
                                  {/* Header */}
                                  <div className="flex items-center gap-1.5">
                                    <BarChart3 className="h-3.5 w-3.5 text-primary" />
                                    <p className="text-xs font-display font-semibold text-foreground">Performance Analytics</p>
                                    <Badge variant="outline" className="text-[10px] ml-1">LinkedIn</Badge>
                                    <span className={`text-[10px] font-semibold ml-2 px-1.5 py-0.5 rounded border ${engagementColor}`}>{engagementLabel}</span>
                                  </div>

                                  {/* Computed metrics row */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-2">
                                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Engagement Rate</p>
                                      <p className="text-lg font-bold text-primary">{engagementRate.toFixed(2)}%</p>
                                      <p className="text-[10px] text-muted-foreground">{totalEngagements.toLocaleString()} total interactions</p>
                                    </div>
                                    <div className="rounded-lg bg-accent/50 border border-accent px-3 py-2">
                                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Click-Through Rate</p>
                                      <p className="text-lg font-bold text-foreground">{ctr.toFixed(2)}%</p>
                                      <p className="text-[10px] text-muted-foreground">{(analytics.clicks || 0).toLocaleString()} clicks</p>
                                    </div>
                                  </div>

                                  {/* Raw stats with progress bars */}
                                  <div className="grid grid-cols-5 gap-2">
                                    {statItems.map(({ key, value, icon: StatIcon, barPct }) => (
                                      <div key={key} className="space-y-1">
                                        <div className="flex items-center gap-1">
                                          <StatIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                                          <p className="text-[10px] text-muted-foreground capitalize">{key}</p>
                                        </div>
                                        <p className="text-sm font-bold text-foreground">{value.toLocaleString()}</p>
                                        <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
                                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(barPct, 100)}%` }} />
                                        </div>
                                      </div>
                                    ))}
                                  </div>

                                  {/* Footer */}
                                  <div className="flex items-center justify-between pt-1 border-t border-border/50">
                                    <span className="text-[10px] text-muted-foreground">
                                      Updated {formatDistanceToNow(new Date(analytics.fetched_at), { addSuffix: true })}
                                    </span>
                                    <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-primary" onClick={() => refreshStats(post)}>
                                      <RefreshCw className="h-3 w-3" /> Refresh
                                    </Button>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* No analytics yet message for published posts */}
                            {post.status === "published" && !hasAnalytics && isExpanded && (
                              <div className="px-4 py-3 border-t border-border bg-muted/20 text-center">
                                <p className="text-xs text-muted-foreground">
                                  No analytics yet. {pType === "linkedin" ? "Click the refresh button to fetch stats from LinkedIn." : "Analytics are available for LinkedIn posts only."}
                                </p>
                              </div>
                            )}

                            {/* Card footer */}
                            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/30">
                              <p className="text-xs text-muted-foreground font-body">
                                You created this {agoStr}
                              </p>
                              <div className="flex items-center gap-1">
                                {(post.status === "draft" || post.status === "scheduled") && (
                                  <Button variant="outline" size="sm" className="text-xs gap-1" disabled={publishing} onClick={() => publishPost(post)}>
                                    <Send className="h-3 w-3" /> Publish Now
                                  </Button>
                                )}
                                {post.status === "published" && !hasAnalytics && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs gap-1"
                                    onClick={() => setExpandedStatsId(isExpanded ? null : post.id)}
                                  >
                                    <BarChart3 className="h-3 w-3" /> Stats
                                  </Button>
                                )}
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditPost(post)}>
                                  <Edit3 className="h-3.5 w-3.5 text-muted-foreground" />
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-7 w-7">
                                      <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem className="text-destructive" onClick={() => deleteMutation.mutate(post.id)}>
                                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ============= POST CREATION / EDIT DIALOG ============= */}
      <Dialog open={postDialogOpen} onOpenChange={setPostDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              {editingPost ? "Edit Post" : "Create New Post"}
              {selectedPlatformCfg && (
                <Badge className={`${selectedPlatformCfg.color} text-xs`}>
                  {selectedPlatformCfg.label}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Account selector */}
            <div className="space-y-2">
              <Label className="font-body">Account</Label>
              <Select value={selectedAccountId ?? ""} onValueChange={setSelectedAccountId}>
                <SelectTrigger><SelectValue placeholder="Select account…" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => {
                    const cfg = platformConfig[a.platform as Platform];
                    const AccountIcon = cfg?.icon ?? Share2;
                    return (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2"><AccountIcon className="h-4 w-4" /> {a.account_name}</span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Content */}
            <div className="space-y-2">
              <Label className="font-body">Content</Label>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What do you want to share?"
                rows={5}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{content.length} characters</span>
                {selectedPlatformCfg && (
                  <span className={content.length > selectedPlatformCfg.charLimit ? "text-destructive font-semibold" : ""}>
                    Max: {selectedPlatformCfg.charLimit.toLocaleString()}
                  </span>
                )}
              </div>
            </div>

            {/* Link URL — Facebook, LinkedIn, Twitter */}
            {selectedPlatformType && ["facebook", "linkedin", "twitter"].includes(selectedPlatformType) && (
              <div className="space-y-2">
                <Label className="font-body flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5" /> Link URL</Label>
                <Input placeholder="https://example.com/article" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
                <p className="text-xs text-muted-foreground">Attach a link preview to your post.</p>
              </div>
            )}

            {/* CTA — Facebook only */}
            {selectedPlatformType === "facebook" && (
              <div className="space-y-2">
                <Label className="font-body">Call to Action</Label>
                <Select value={ctaType} onValueChange={setCtaType}>
                  <SelectTrigger><SelectValue placeholder="Select CTA (optional)…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No CTA</SelectItem>
                    <SelectItem value="LEARN_MORE">Learn More</SelectItem>
                    <SelectItem value="SHOP_NOW">Shop Now</SelectItem>
                    <SelectItem value="SIGN_UP">Sign Up</SelectItem>
                    <SelectItem value="BOOK_NOW">Book Now</SelectItem>
                    <SelectItem value="CONTACT_US">Contact Us</SelectItem>
                    <SelectItem value="GET_QUOTE">Get Quote</SelectItem>
                    <SelectItem value="APPLY_NOW">Apply Now</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Visibility — LinkedIn only */}
            {selectedPlatformType === "linkedin" && (
              <div className="space-y-2">
                <Label className="font-body flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Visibility</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public — Anyone on LinkedIn</SelectItem>
                    <SelectItem value="connections">Connections Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Hashtags — Twitter, Instagram, LinkedIn */}
            {selectedPlatformType && ["twitter", "instagram", "linkedin"].includes(selectedPlatformType) && (
              <div className="space-y-2">
                <Label className="font-body flex items-center gap-1.5"><Hash className="h-3.5 w-3.5" /> Hashtags</Label>
                <Input placeholder="#marketing #socialmedia #growth" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
                <p className="text-xs text-muted-foreground">Separate with spaces. These will be appended to your content.</p>
              </div>
            )}

            {/* Location — Facebook, Instagram */}
            {selectedPlatformType && ["facebook", "instagram"].includes(selectedPlatformType) && (
              <div className="space-y-2">
                <Label className="font-body flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> Location</Label>
                <Input placeholder="e.g. Los Angeles, CA" value={location} onChange={(e) => setLocation(e.target.value)} />
              </div>
            )}

            {/* Video fields — YouTube */}
            {selectedPlatformType === "youtube" && (
              <>
                <div className="space-y-2">
                  <Label className="font-body">Video Title</Label>
                  <Input placeholder="Enter video title" value={videoTitle} onChange={(e) => setVideoTitle(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label className="font-body">Tags</Label>
                  <Input placeholder="tag1, tag2, tag3" value={videoTags} onChange={(e) => setVideoTags(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label className="font-body">Category</Label>
                  <Select value={videoCategory} onValueChange={setVideoCategory}>
                    <SelectTrigger><SelectValue placeholder="Select category…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="education">Education</SelectItem>
                      <SelectItem value="howto">How-to & Style</SelectItem>
                      <SelectItem value="science">Science & Technology</SelectItem>
                      <SelectItem value="entertainment">Entertainment</SelectItem>
                      <SelectItem value="news">News & Politics</SelectItem>
                      <SelectItem value="business">Business</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {/* First comment — Instagram */}
            {selectedPlatformType === "instagram" && (
              <div className="space-y-2">
                <Label className="font-body">First Comment</Label>
                <Textarea
                  value={firstComment}
                  onChange={(e) => setFirstComment(e.target.value)}
                  placeholder="Add hashtags or context as a first comment…"
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">Posted as the first comment after publishing.</p>
              </div>
            )}

            {/* Status */}
            <div className="space-y-2">
              <Label className="font-body">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as PostStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft"><span className="flex items-center gap-1.5"><FileEdit className="h-3.5 w-3.5" /> Draft</span></SelectItem>
                  <SelectItem value="scheduled"><span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Scheduled</span></SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Schedule */}
            {status === "scheduled" && (
              <div className="space-y-2">
                <Label className="font-body">Schedule Date & Time</Label>
                <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              </div>
            )}

            {/* Media */}
            <div className="space-y-2">
              <Label className="font-body">Media</Label>
              <div className="flex gap-2 flex-wrap">
                {editingPost?.media_urls?.map((url, i) => (
                  <img key={i} src={url} alt="" className="h-16 w-16 rounded-lg object-cover border border-border" />
                ))}
                {mediaFiles.map((f, i) => (
                  <div key={i} className="relative h-16 w-16 rounded-lg border border-border flex items-center justify-center bg-muted text-xs text-muted-foreground overflow-hidden">
                    {f.type.startsWith("image/") ? (
                      <img src={URL.createObjectURL(f)} alt="" className="h-full w-full object-cover" />
                    ) : f.name.slice(0, 8)}
                    <button
                      type="button"
                      className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5"
                      onClick={() => setMediaFiles((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              <label className="inline-flex items-center gap-1.5 text-sm text-primary cursor-pointer hover:underline">
                <ImageIcon className="h-4 w-4" /> Add media
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { if (e.target.files) setMediaFiles((prev) => [...prev, ...Array.from(e.target.files!)]); }}
                />
              </label>
              {selectedPlatformType && (
                <p className="text-xs text-muted-foreground">
                  {selectedPlatformType === "instagram" ? "Supports images and reels (video)." :
                   selectedPlatformType === "youtube" ? "Upload your video file." :
                   selectedPlatformType === "twitter" ? "Up to 4 images or 1 video." :
                   "Images and video supported."}
                </p>
              )}
            </div>

            {/* Platform capabilities summary */}
            {selectedPlatformCfg && (
              <div className="bg-muted/30 border border-border rounded-lg p-3">
                <p className="text-xs font-display font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  MCP Capabilities — {selectedPlatformCfg.label}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedPlatformCfg.features.map(f => (
                    <Badge key={f} variant="secondary" className="text-[10px] capitalize">{f}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={handleSave} disabled={saveMutation.isPending || uploading}>
              {saveMutation.isPending || uploading ? "Saving…" : editingPost ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SocialMedia;
