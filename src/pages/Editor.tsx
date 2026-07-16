import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useUsage } from "@/contexts/UsageContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { revisionService } from "@/services/revisionService";
import { RevisionPanel } from "@/components/RevisionPanel";
import { VersionHistoryPanel } from "@/components/VersionHistoryPanel";
import { WorkspaceLoader } from "@/components/WorkspaceLoader";
import { CodeEditorPanel } from "@/components/CodeEditorPanel";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { MultiDevicePreview } from "@/components/MultiDevicePreview";
import type { ActivityType } from "@/components/ProjectActivityIndicator";
import { AgentChatPanel } from "@/components/chat/_ui_/AgentChatPanel";
import { SettingsDialog } from "@/components/referral/settings/SettingsDialog";
import { buildPreviewNavigationUrl, normalizePreviewRoute } from "@/utils/previewNavigation";
import { getApiServerUrl } from "@/config/external-api";

import {
  Settings,
  Search,
  RotateCcw,
  Minimize2,
  Monitor,
  Smartphone,
  Tablet,
  Github,
  Cloud,
  Bot,
  Globe,
  Paperclip,
  Edit,
  FileCode,
  ExternalLink,
  Copy,
  ChevronDown,
  Navigation,
  History,
  Link,
  Eye,
  Database,
  ArrowUpRight,
  MousePointerClick,
} from "lucide-react";
import ecgLogo from "@/assets/ecg-logo.png";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { toast } from "sonner";
import { promptService } from "@/eCG/UserPrompt";
import { messageService } from "@/eCG/UserPrompt/messageService";
import { generatePreview } from "@/eCG/Preview/previewGenerator";
import { checkPreviewHealth, updateDockerPreview, getPreviewUrl, handlePreviewSessionExpired } from "@/services/previewHealthService";
import { validateAndFixFiles, getFixedContent } from "@/services/fileValidationService";
import { QuotaLimitDialog } from "@/components/QuotaLimitDialog";
import { useSubscription } from "@/contexts/SubscriptionContext"; // single source — hasFeature/tier/tierLabel now on context
import { domainService } from "@/eCG/Publish";
import type { DomainConfiguration, DomainStatus } from "@/eCG/Publish/types";
import { countNonEmptyLines } from "@/utils/ecoCounter";
import { checkAndIncrementPublishLines, showLimitToast } from "@/services/subscriptionService";

const Editor = ({ projectId: propProjectId }: { projectId?: string }) => {
  type BuilderTab = 'brief' | 'generate' | 'code' | 'preview' | 'revisions' | 'publish';
  const BUILDER_TABS: BuilderTab[] = ['brief', 'generate', 'code', 'preview', 'revisions', 'publish'];
  const params = useParams();
  let projectId = propProjectId || params.projectId;
  if (projectId === 'undefined') {
    projectId = undefined;
  }
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentOrganizationId, refreshOrganization, setCurrentOrganizationId } = useOrganization();
  const { ensureWithinLimit, refreshUsage, applyUsageDelta, usageRecord, getUsagePercentage, getUsageLimit } = useUsage();
  const { subscribed, hasFeature, tierLabel, tier } = useSubscription();

  // Workspace integration
  const {
    files: workspaceFiles,
    setFiles: setWorkspaceFiles,
    undo: undoWorkspace,
    writeFile: writeFileWorkspace,
    deleteFile: deleteFileWorkspace,
    saveToDatabase: saveWorkspaceToDb,
    loadFromDatabase: loadWorkspaceFromDb,
    isLoading: isWorkspaceLoading,
  } = useWorkspace();

  // Track if initial workspace load has completed (for preview refresh)
  const [hasInitialLoadCompleted, setHasInitialLoadCompleted] = useState(false);
  const [previewFirstPaint, setPreviewFirstPaint] = useState(false);
  const prevWorkspaceLoadingRef = useRef(true);
  const [prompt, setPrompt] = useState("");
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const codeEditorSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewStatusResetRef = useRef<NodeJS.Timeout | null>(null);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant', content: string }>>([]);
  const [generatedCode, setGeneratedCode] = useState("");
  const [generatedFiles, setGeneratedFiles] = useState<Array<{ path: string; content: string }>>([]);
  const lastAgentEcoRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);
  const [workflowComplete, setWorkflowComplete] = useState(false);
  const [project, setProject] = useState<any>(null);
  const [viewMode, setViewMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [chatWidth, setChatWidth] = useState(380);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showCloudDialog, setShowCloudDialog] = useState(false);
  const [customDomain, setCustomDomain] = useState("");
  const [publishMode, setPublishMode] = useState<'subdomain' | 'custom'>('subdomain');
  const [customDomainConfig, setCustomDomainConfig] = useState<DomainConfiguration | null>(null);
  const [customDomainStatus, setCustomDomainStatus] = useState<DomainStatus | null>(null);
  const [customDomainActivated, setCustomDomainActivated] = useState(false);
  const [hostingDeployUrl, setHostingDeployUrl] = useState<string | null>(null);
  const [dbCustomDomain, setDbCustomDomain] = useState<string | null>(null);
  const [dnsCheckResult, setDnsCheckResult] = useState<{
    pointingOk: boolean;
    txtOk: boolean;
    aRecord?: { expected: string; found: string[]; ok: boolean };
    cnameRecord?: { expected: string; found: string[]; ok: boolean };
    txtRecord?: { expected: string; host: string; found: string[]; ok: boolean };
    checkedAt: string;
  } | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);

  // ── Chat panel drag-to-resize ──────────────────────────────────────────────
  const startChatResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only respond to primary button (left click)
    if (e.button !== 0) return;
    e.preventDefault();

    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    const startX = e.clientX;
    const startWidth = chatPanelRef.current?.offsetWidth ?? 380;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const cleanup = (finalX?: number) => {
      if (typeof finalX === 'number') {
        const next = Math.min(560, Math.max(280, startWidth + finalX - startX));
        setChatWidth(next);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.releasePointerCapture(pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
    };
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(560, Math.max(280, startWidth + ev.clientX - startX));
      if (chatPanelRef.current) chatPanelRef.current.style.width = `${next}px`;
    };
    const onUp = (ev: PointerEvent) => cleanup(ev.clientX);
    const onCancel = () => cleanup();
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  }, []);
                                                                                                                                                                                                                                                                                                                                                      
  const canPublishToEcomDomain = hasFeature('hosting');
  const canUseCustomDomain = hasFeature('custom_domains') && hasFeature('hosting');
  const canExportCode = tier === 'professional' || tier === 'enterprise';
  // ── Subdomain publish state ──────────────────────────────────────────────
  const [publishSlug, setPublishSlug] = useState("");
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [slugChecking, setSlugChecking] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isEditingSlug, setIsEditingSlug] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [generationStage, setGenerationStage] = useState<'core' | 'complete'>('core');
  const [showExpandButton, setShowExpandButton] = useState(false);
  const [showCodeViewer, setShowCodeViewer] = useState(false);
  const [previewFileOverride, setPreviewFileOverride] = useState<{
    content: string;
    path: string;
  } | null>(null);
  const [showQuotaLimitDialog, setShowQuotaLimitDialog] = useState(false);
  const [quotaResetAt, setQuotaResetAt] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  const requestedTab = searchParams.get('tab');
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  const activeBuilderTab: BuilderTab = BUILDER_TABS.includes(requestedTab as BuilderTab)
    ? (requestedTab as BuilderTab)
    : 'preview';
  const topMenuTabs: BuilderTab[] = [];
  const visibleBuilderTabs = topMenuTabs;

  const setActiveBuilderTab = useCallback((tab: BuilderTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const formatResetDateTime = useCallback((resetAt: string | null | undefined) => {
    if (!resetAt) return null;
    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, []);

  const showQuotaReachedPrompt = useCallback(() => {
    const resetValue = usageRecord?.ai_gens_reset_at ?? null;
    setQuotaResetAt(resetValue);
    setShowQuotaLimitDialog(true);

    const resetText = formatResetDateTime(resetValue);
    if (resetText) {
      toast.message(`Eco quota resets on ${resetText}`);
    }
  }, [formatResetDateTime, usageRecord?.ai_gens_reset_at]);

  // Global Activity State
  const [activityType, setActivityType] = useState<ActivityType>('idle');
  const [activityMessage, setActivityMessage] = useState('');
  const [activityDetails, setActivityDetails] = useState<string | undefined>();


  const extractErrorMeta = (message: string) => {
    const fileMatch = message.match(/((?:[A-Za-z]:)?[^\s:]+\.(?:tsx|ts|jsx|js))/);
    const locMatch = message.match(/\((\d+):(\d+)\)/);
    if (!fileMatch) return null;

    let filePath = fileMatch[1];
    const projectRootMarker = `/preview-service/projects/${projectId}/`;
    if (filePath.includes(projectRootMarker)) {
      filePath = filePath.split(projectRootMarker)[1];
    }
    filePath = filePath.replace(/^\//, '');

    return {
      filePath,
      line: locMatch ? Number(locMatch[1]) : undefined,
      column: locMatch ? Number(locMatch[2]) : undefined,
      raw: message,
    };
  };

  const extractInvalidSourceFiles = (errorMessage?: string): string[] => {
    if (!errorMessage) return [];

    const matches = errorMessage.matchAll(/([A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js)):\d+:\d+/g);
    const files = new Set<string>();

    for (const match of matches) {
      const normalized = (match[1] || '').replace(/^\//, '');
      if (normalized) files.add(normalized);
    }

    return Array.from(files);
  };

  const buildRetryFilesWithFallback = (
    candidateFiles: Array<{ path: string; content: string }>,
    previousFilesMap: Map<string, { path: string; content: string }>,
    invalidFilePaths: string[]
  ) => {
    if (invalidFilePaths.length === 0) return null;

    const invalidSet = new Set(invalidFilePaths.map(p => p.replace(/^\//, '')));
    const previousByPath = new Map<string, { path: string; content: string }>();

    previousFilesMap.forEach((value, key) => {
      previousByPath.set(key.replace(/^\//, ''), { path: value.path, content: value.content });
    });

    const criticalFiles = new Set(['index.html', 'src/main.tsx', 'src/App.tsx']);
    const missingFallbackPaths: string[] = [];
    const invalidCriticalWithoutFallback: string[] = [];

    let replaced = 0;
    let removed = 0;
    const files: Array<{ path: string; content: string }> = [];

    for (const file of candidateFiles) {
      const normalizedPath = file.path.replace(/^\//, '');
      if (!invalidSet.has(normalizedPath)) {
        files.push(file);
        continue;
      }

      const fallback = previousByPath.get(normalizedPath);
      if (fallback) {
        files.push({ path: file.path, content: fallback.content });
        replaced++;
      } else {
        // No previous version — keep the file as-is and let the preview service
        // handle it. Never replace with a generated fallback placeholder.
        files.push(file);
        missingFallbackPaths.push(normalizedPath);
        if (criticalFiles.has(normalizedPath)) {
          invalidCriticalWithoutFallback.push(normalizedPath);
        }
        removed++;
      }
    }

    const safeToRetry = removed === 0 && invalidCriticalWithoutFallback.length === 0;
    const reason = !safeToRetry
      ? (
        invalidCriticalWithoutFallback.length > 0
          ? `Critical file(s) invalid without fallback: ${invalidCriticalWithoutFallback.join(', ')}`
          : `Invalid file(s) have no fallback: ${missingFallbackPaths.join(', ')}`
      )
      : undefined;

    return { files, replaced, removed, safeToRetry, reason };
  };

  const buildSafeFilesAfterValidation = (
    candidateFiles: Array<{ path: string; content: string }>,
    previousFilesMap: Map<string, { path: string; content: string }>,
    validationErrors: Array<{ file: string; severity: 'error' | 'warning' }>
  ) => {
    const blockingFiles = new Set(
      validationErrors
        .filter((error) => error.severity === 'error')
        .map((error) => (error.file || '').replace(/^\//, ''))
        .filter(Boolean)
    );

    if (blockingFiles.size === 0) {
      return {
        files: candidateFiles,
        rolledBack: 0,
        removed: 0,
        unresolved: [] as string[],
        blocking: [] as string[],
      };
    }

    const previousByPath = new Map<string, { path: string; content: string }>();
    previousFilesMap.forEach((value, key) => {
      previousByPath.set(key.replace(/^\//, ''), { path: value.path, content: value.content });
    });

    let rolledBack = 0;
    let removed = 0;
    const unresolved: string[] = [];
    const files: Array<{ path: string; content: string }> = [];

    for (const file of candidateFiles) {
      const normalizedPath = file.path.replace(/^\//, '');
      if (!blockingFiles.has(normalizedPath)) {
        files.push(file);
        continue;
      }

      const fallback = previousByPath.get(normalizedPath);
      if (fallback) {
        files.push({ path: file.path, content: fallback.content });
        rolledBack++;
      } else {
        // No previous version available — keep the current file as-is and let
        // the preview service handle validation. Never replace with a generated
        // "temporarily recovered" placeholder — that confuses users.
        files.push(file);
        removed++;
        unresolved.push(normalizedPath);
      }
    }

    return {
      files,
      rolledBack,
      removed,
      unresolved,
      blocking: Array.from(blockingFiles),
    };
  };


  // Listen for logs from preview iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Derive the expected preview origin the same way previewHealthService does,
      // so the check works even when VITE_PREVIEW_SERVICE_URL is not explicitly set.
      const previewServiceBase =
        (import.meta.env.VITE_PREVIEW_SERVICE_URL as string | undefined) ||
        (import.meta.env.PROD ? 'https://preview.ecomgear.app' : 'http://localhost:3001');
      const isAllowedOrigin =
        event.origin === window.location.origin ||
        event.origin === new URL(previewServiceBase).origin;
      if (!isAllowedOrigin) return;

      if (event.data?.type === 'PREVIEW_LOG' && event.data.log) {
        const { type, message, source } = event.data.log;

        // Check if this is actually a navigation event wrapped as a log
        if (type === 'navigation') {
          lastUserNavigationAtRef.current = Date.now();
          const path = typeof message === 'string' ? message : message?.pathname;
          if (path) setPreviewPath(normalizePreviewRoute(path));
          return;
        }

        const msgString = typeof message === 'object' ? JSON.stringify(message) : String(message);

        // Auto-trigger repair when a runtime error with a file location arrives.
        // The chat panel's own isGenerating guard prevents double-firing.
        // Only switch tab if this browser tab is in the foreground — prevents
        // background tabs from stealing focus away from the user's active tab.
        if (type === 'error') {
          const meta = event.data.log?.meta;
          if (meta?.filePath) {
            const now = Date.now();
            const cooldownOk = now - lastAutoRepairAtRef.current > AUTO_REPAIR_COOLDOWN_MS;
            const underLimit = consecutiveRepairsRef.current < MAX_CONSECUTIVE_REPAIRS;
            const agentIdle = !isAgentRunningRef.current;
            if (cooldownOk && underLimit && agentIdle) {
              lastAutoRepairAtRef.current = now;
              consecutiveRepairsRef.current += 1;
              isAgentRunningRef.current = true;
              pendingAutoRepairRef.current = true;
              const loc = meta.line ? ` at line ${meta.line}` : '';
              setRepairPrompt(`Fix the error in ${meta.filePath.replace(/^\//, '')}${loc}: ${meta.raw || msgString}. Keep changes minimal.`);
              if (document.visibilityState === 'visible') {
                setIsMinimized(false);
              }
            }
          }
        }
      } else if (event.data?.type === 'navigation') {
        lastUserNavigationAtRef.current = Date.now();
        setPreviewPath(normalizePreviewRoute(event.data.pathname));
      } else if (event.data?.type === 'PREVIEW_BLANK') {
        const now = Date.now();
        const cooldownOk = now - lastAutoRepairAtRef.current > AUTO_REPAIR_COOLDOWN_MS;
        const underLimit = consecutiveRepairsRef.current < MAX_CONSECUTIVE_REPAIRS;
        const agentIdle = !isAgentRunningRef.current;
        // Skip auto-repair if the blank screen arrived shortly after a user-initiated
        // navigation — this is a missing route (404), not a code error.
        const afterUserNav = now - lastUserNavigationAtRef.current < NAV_BLANK_GRACE_MS;
        if (cooldownOk && underLimit && agentIdle && !afterUserNav && document.visibilityState === 'visible') {
          lastAutoRepairAtRef.current = now;
          consecutiveRepairsRef.current += 1;
          isAgentRunningRef.current = true;
          pendingAutoRepairRef.current = true;
          setRepairPrompt(
            'The preview screen is completely blank/white with no visible content. Investigate and fix the root cause — check for React rendering errors, a missing root element mount, white-on-white CSS, or an uncaught exception that prevented the app from mounting.'
          );
          setIsMinimized(false);
        }
      } else if (event.data?.type === 'preview-session-expired' && event.data?.projectId) {
        // The preview iframe's session expired — renew and reload iframe
        const expiredProjectId = event.data.projectId as string;
        handlePreviewSessionExpired(expiredProjectId).then(newUrl => {
          if (newUrl) {
            setPreviewUrl(newUrl);
            transitionPreviewStatus('ready', { message: 'Preview Ready' });
          }
        });
      } else if (event.data?.type === 'ecg-element-selected') {
        // Click-to-select from inspect mode — scope the chat input to the
        // clicked element so the next prompt has context (Lovable/v0 parity).
        const { selector, tagName, text } = event.data;
        const label = text ? `"${text.slice(0, 60)}"` : selector;
        setInspectTarget({ selector, tagName: tagName || '', label: label || '' });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Preview URL state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fallbackPreviewUrl, setFallbackPreviewUrl] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'pending' | 'building' | 'ready' | 'failed'>('pending');
  const [latestPreviewUrl, setLatestPreviewUrl] = useState<string | null>(null);
  // Click-to-select inspect mode
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<{ selector: string; tagName: string; label: string } | null>(null);
  const sharePreviewUrl = useMemo(() => {
    const candidate = latestPreviewUrl || previewUrl;
    if (!candidate) return null;

    try {
      const parsed = new URL(candidate);
      // Remove cache-busting timestamp from share links.
      parsed.searchParams.delete('t');
      return parsed.toString();
    } catch {
      return candidate;
    }
  }, [latestPreviewUrl, previewUrl]);
  // Local preview HTML (generated from workspace files)
  const [localPreviewHtml, setLocalPreviewHtml] = useState<string | null>(null);

  // Track current path from preview iframe — initialised from URL so refresh restores it
  const [previewPath, setPreviewPath] = useState<string>(() => searchParams.get('page') || '/');
  const previewPathRef = useRef(previewPath);
  useEffect(() => { previewPathRef.current = previewPath; }, [previewPath]);

  // Ref so onGenerationComplete (stale closure) can check whether a preview URL
  // exists before switching to the preview tab — avoids showing a blank tab.
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => { previewUrlRef.current = previewUrl; }, [previewUrl]);

  // Auto-repair loop guards — all refs so they stay current inside the message handler closure.
  // lastAutoRepairAtRef:       timestamp of the last auto-repair trigger (ms)
  // consecutiveRepairsRef:     how many auto-repairs have fired back-to-back without a clean render
  // isAgentRunningRef:         true while an agent generation is in progress
  // pendingAutoRepairRef:      true when the currently-running generation was auto-triggered (not user)
  //                            Used to prevent resetting consecutiveRepairsRef on repair completions.
  const lastAutoRepairAtRef = useRef<number>(0);
  const consecutiveRepairsRef = useRef<number>(0);
  const isAgentRunningRef = useRef<boolean>(false);
  const pendingAutoRepairRef = useRef<boolean>(false);
  const lastUserNavigationAtRef = useRef<number>(0); // timestamp of last user-initiated route change
  const AUTO_REPAIR_COOLDOWN_MS = 60_000; // 60 s between auto-repairs
  const MAX_CONSECUTIVE_REPAIRS = 2;      // stop looping after 2 back-to-back attempts
  // How long after a user-initiated navigation to suppress blank-screen auto-repair.
  // Covers slow initial loads on new routes (SPA hydration + lazy chunks).
  // If users report missed repairs after navigating, lower this value.
  const NAV_BLANK_GRACE_MS = 8_000;

  // Route navigation state
  const [currentRoutePath, setCurrentRoutePath] = useState<string>(() => searchParams.get('page') || '/');

  // Sync address bar + browser URL with iframe navigation
  useEffect(() => {
    setCurrentRoutePath(previewPath);
    // Keep the ?page= param in sync so the browser URL reflects the current preview page
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (previewPath && previewPath !== '/') {
        next.set('page', previewPath);
      } else {
        next.delete('page');
      }
      return next;
    }, { replace: true });
  }, [previewPath]);
  const [showRouteDropdown, setShowRouteDropdown] = useState(false);
  const [repairPrompt, setRepairPrompt] = useState<string | null>(null);
  const [agentStreamText, setAgentStreamText] = useState<string>('');

  const handleAgentStreamText = useCallback((chunk: string) => {
    setAgentStreamText(prev => prev + chunk);
  }, []);

  const handleAgentStreamClear = useCallback(() => {
    setAgentStreamText('');
  }, []);

  const transitionPreviewStatus = useCallback(
    (
      status: 'pending' | 'building' | 'ready' | 'failed',
      options?: { message?: string; details?: string }
    ) => {
      setPreviewStatus(status);

      if (previewStatusResetRef.current) {
        clearTimeout(previewStatusResetRef.current);
        previewStatusResetRef.current = null;
      }

      if (status === 'building') {
        setActivityType('building');
        setActivityMessage(options?.message || 'Building preview...');
        setActivityDetails(options?.details);
        return;
      }

      if (status === 'ready') {
        setActivityType('preview-ready');
        setActivityMessage(options?.message || 'Preview Ready');
        setActivityDetails(options?.details);
        previewStatusResetRef.current = setTimeout(() => {
          setActivityType('idle');
          setActivityMessage('');
          setActivityDetails(undefined);
        }, 3000);
        return;
      }

      if (status === 'failed') {
        setActivityType('error');
        setActivityMessage(options?.message || 'Preview Failed');
        setActivityDetails(options?.details);
        return;
      }

      setActivityType('idle');
      setActivityMessage(options?.message || '');
      setActivityDetails(options?.details);
    },
    []
  );

  // Extract routes from workspace files (React Router patterns)
  const detectedRoutes = useMemo(() => {
    const routes: { path: string; name: string }[] = [{ path: '/', name: 'Home' }];
    const seen = new Set<string>(['/']);

    // Patterns to match React Router routes
    const routePatterns = [
      /<Route[^>]+path=["']([^"']+)["']/gi,      // <Route path="/about" />
      /path:\s*["']([^"']+)["']/gi,              // { path: '/about' }
      /to=["']([^"']+)["']/gi,                   // <Link to="/about">
      /navigate\(["']([^"']+)["']/gi,           // navigate('/about')
    ];

    workspaceFiles.forEach((file) => {
      if (file.path.endsWith('.tsx') || file.path.endsWith('.jsx') || file.path.endsWith('.ts') || file.path.endsWith('.js')) {
        routePatterns.forEach(pattern => {
          let match;
          const content = file.content;
          const regex = new RegExp(pattern.source, pattern.flags);
          while ((match = regex.exec(content)) !== null) {
            const path = match[1];
            if (path && typeof path === 'string' && path.startsWith('/') && !seen.has(path) && !path.includes(':') && !path.includes('*')) {
              seen.add(path);
              // Generate a readable name from path
              const name = path === '/' ? 'Home' : path.split('/').filter(Boolean).map(s =>
                s.charAt(0).toUpperCase() + s.slice(1)
              ).join(' / ');
              routes.push({ path: String(path), name: String(name) });
            }
          }
        });
      }
    });

    return routes.sort((a, b) => a.path.localeCompare(b.path));
  }, [workspaceFiles]);

  // Edit project name
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const [updatingProjectName, setUpdatingProjectName] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('project-settings');

  const openSettings = useCallback((section = 'project-settings') => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);



  // GitHub status — used by the header's GitHub button to decide whether to
  // open the quick-details popover or send the user to the connect screen.
  // Shares a query key with GitHubSettings.tsx so both read from the same
  // cache instead of each hitting the API independently.
  const [githubPopoverOpen, setGithubPopoverOpen] = useState(false);

  const { data: githubStatus } = useQuery({
    queryKey: ["github-status"],
    enabled: !!projectId,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { connected: false };
      const res = await fetch(getApiServerUrl("/api/v1/github/status"), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      return res.json().catch(() => ({ connected: false })) as Promise<{ connected: boolean; login?: string; avatarUrl?: string | null }>;
    },
  });

  const { data: githubLinkData } = useQuery({
    queryKey: ["github-link", projectId],
    enabled: !!projectId && !!githubStatus?.connected,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { link: null };
      const res = await fetch(getApiServerUrl(`/api/v1/github/${projectId}/link`), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      return res.json().catch(() => ({ link: null })) as Promise<{ link: { fullName: string; branch: string } | null }>;
    },
  });
  const githubLink = githubLinkData?.link ?? null;

  const effectivePreviewUrl = previewUrl || latestPreviewUrl || fallbackPreviewUrl || null;
  const hasLoadedCode = workspaceFiles.size > 0 || generatedFiles.length > 0 || generatedCode.trim().length > 0;
  const hasRenderablePreview = Boolean(
    effectivePreviewUrl ||
    localPreviewHtml ||
    previewFileOverride ||
    (generatedFiles.length === 1 && generatedFiles[0]?.path === 'index.html' && generatedCode)
  );
  const showPreviewChrome = hasLoadedCode || hasRenderablePreview || isLoading || previewStatus === 'building';
  const canUsePreviewViewport = hasLoadedCode || hasRenderablePreview || isLoading || previewStatus === 'building';
  const canToggleCodeViewer = hasLoadedCode;
  const showRouteNavigator = showPreviewChrome && !showCodeViewer && hasRenderablePreview;
  const isAlreadyPublished = Boolean(project?.published_url || project?.published_subdomain || publishedUrl || dbCustomDomain);
  const hasCustomDomain = customDomainActivated || Boolean(customDomain) || Boolean(dbCustomDomain) ||
    Boolean(project?.published_url && !project.published_url.includes('ecomgear.app'));
  const canShowPublishActions = hasLoadedCode || isAlreadyPublished || Boolean(sharePreviewUrl);
  const canRenderProjectActions = Boolean(projectId);
  const canInteractWithPublishActions = canRenderProjectActions && canShowPublishActions;
  const isVersionPublishable = previewStatus === 'ready';

  // Guest mode state
  const [isGuest, setIsGuest] = useState(false);
  const [promptCount, setPromptCount] = useState(0);
  const [guestFingerprint, setGuestFingerprint] = useState<string | undefined>(undefined);

  // Chat scroll ref
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesLoadedRef = useRef(false);
  const generationProgressRef = useRef<NodeJS.Timeout | null>(null);
  const sentMessagesRef = useRef<Set<string>>(new Set());
  const previewSyncQueueRef = useRef(Promise.resolve());
  const previewSyncSequenceRef = useRef(0);
  const lastSuccessfulPreviewFilesRef = useRef<Map<string, { path: string; content: string }>>(new Map());

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (generationProgressRef.current) {
        clearInterval(generationProgressRef.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (codeEditorSyncTimeoutRef.current) {
        clearTimeout(codeEditorSyncTimeoutRef.current);
      }
      if (previewStatusResetRef.current) {
        clearTimeout(previewStatusResetRef.current);
      }
    };
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Helper to add system status messages to chat (optimistic update)
  const addSystemMessage = async (content: string) => {
    // Check if this message was already sent to prevent duplicates
    if (sentMessagesRef.current.has(content)) {
      return;
    }

    sentMessagesRef.current.add(content);

    const systemMessage = {
      role: 'assistant' as const,
      content
    };
    // Optimistic update - add to local state immediately
    setMessages(prev => [...prev, systemMessage]);

    // Save to database in background (skip for guests — no DB project row)
    if (!isGuest) {
      try {
        await supabase.from("messages").insert({
          project_id: projectId,
          role: 'assistant',
          content,
        });
      } catch (err) {
        console.error('Failed to save message:', err);
      }
    }
  };

  const scheduleWorkspaceSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveWorkspaceToDb().catch((error) => {
        console.error('[Editor] Workspace autosave failed:', error);
        toast.error('Failed to save workspace changes');
      });
    }, 1000);
  }, [saveWorkspaceToDb]);

  const enqueuePreviewSync = useCallback(async (
    reason: string,
    task: () => Promise<void>,
    options?: { coalesce?: boolean }
  ) => {
    const queueSeq = ++previewSyncSequenceRef.current;

    previewSyncQueueRef.current = previewSyncQueueRef.current
      .then(async () => {
        if (options?.coalesce && queueSeq !== previewSyncSequenceRef.current) {
          console.log(`[Editor] Preview sync skipped as stale: ${reason}`);
          return;
        }

        console.log(`[Editor] Preview sync queued: ${reason}`);
        await task();
      })
      .catch((error) => {
        console.error(`[Editor] Preview sync failed (${reason}):`, error);
      });

    return previewSyncQueueRef.current;
  }, []);

  useEffect(() => {
    // Only load messages once on mount to prevent race conditions
    const initializeEditor = async () => {
      if (!messagesLoadedRef.current) {
        if (isGuest) {
          // Guests: skip DB loads — no project row, no messages, no user
          setProject({ id: projectId, name: 'Guest Project', status: 'active' } as any);
          setMessages([]);
          setCurrentUser(null);
        } else {
          await loadProject();
          await loadMessages();
          await loadCurrentUser();
        }
        messagesLoadedRef.current = true;
      }
    };
    initializeEditor();
  }, [projectId, isGuest]);



  // Handle real-time updates from background jobs or other users
  useEffect(() => {
    const handleRevisionCreated = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.projectId !== projectId) return;

      console.log('[Editor] Real-time update received:', detail);
      toast.success('New update received from Active Engineer');

      // Optionally auto-load if it's a "fix" job
      if (detail.type === 'auto-fix') {
        await loadLatestCode();
      }
    };

    window.addEventListener('revision:created', handleRevisionCreated);
    return () => window.removeEventListener('revision:created', handleRevisionCreated);
  }, [projectId]);

  const loadCurrentUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUser(user);
    await refreshOrganization(user);
  };

  // Handle initial prompt from navigation state
  useEffect(() => {
    const state = location.state as any;

    // Detect guest mode
    if (state?.isGuest === true || projectId?.startsWith('guest-')) {
      setIsGuest(true);
      let fp = state?.fingerprint;
      if (!fp) {
        fp = localStorage.getItem('ecg_guest_fp');
        if (!fp) {
          // Generate a new fingerprint if missing
          fp = crypto.randomUUID();
          localStorage.setItem('ecg_guest_fp', fp);
        }
      }
      setGuestFingerprint(fp);
      console.log('[Editor] Guest mode detected');
    }

    if (state?.initialPrompt && state?.shouldGenerate) {
      // Clear the navigation state to prevent re-triggering
      window.history.replaceState({}, document.title);

      // Set the prompt in the UI so user can see what they typed
      setPrompt(state.initialPrompt);

      // Defer by one tick so React can flush the setPrompt update first.
      const timerId = setTimeout(() => {
        handleGenerateWithContext(state.initialPrompt, state.fileContext);
      }, 100);
      return () => clearTimeout(timerId);
    }
  }, [location.state]);

  const loadProject = async () => {
    // Explicit column list — excludes latest_generated_code, which duplicates
    // the entire project's file contents as a JSON-stringified blob (can be
    // tens of MB) and is write-only (kept for backwards compat, never read).
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, status, created_at, updated_at, organization_id, slug, description, visibility, created_by, message_count, user_id, total_storage_bytes, revision_count, latest_revision_size, storage_warning_shown, org_id, docker_path, server_path, preview_port, template_type, node_version, published_subdomain, published_url, published_at, website_name, website_description, meta_image_url, favicon_url, custom_system_prompt, context_notes, thumbnail_url")
      .eq("id", projectId)
      .single();

    if (error) {
      // If project doesn't exist, create it
      if (error.code === 'PGRST116') {
        console.log("Project not found, creating...");
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
          const { data: newProject, error: createError } = await supabase
            .from("projects")
            .insert({
              id: projectId,
              user_id: user.id,
              name: "My Project",
              description: "Created automatically",
              status: 'active'
            })
            .select()
            .single();

          if (createError) {
            console.error("Error creating project:", createError);
            toast.error("Failed to create project");
            return;
          }

          setProject(newProject);
          toast.success("Project initialized");
          return;
        }
      }

      console.error("Error loading project:", error);
      toast.error("Failed to load project");
      return;
    }

    // Verify access rights via has_project_access() RPC
    try {
      const { data: hasAccess, error: accessError } = await supabase.rpc(
        'has_project_access',
        { p_project_id: data.id }
      );

      if (accessError) {
        console.error('Error checking project access:', accessError);
      } else if (hasAccess === false) {
        toast.error('You do not have access to this project');
        navigate('/dashboard/projects');
        return;
      }
    } catch (accessErr) {
      console.error('Failed to verify project access:', accessErr);
      // Don't block on access check failure — fall through
    }

    setProject(data);
    if (data?.organization_id) {
      setCurrentOrganizationId(data.organization_id);
    }
    setEditProjectName(data?.name || '');
    // Restore published state from DB so Publish button shows correct status
    if (data?.published_url) {
      setPublishedUrl(data.published_url);
      if (data.published_subdomain) setPublishSlug(data.published_subdomain);
    }
    // Load active custom domain from DB so the Update button shows correctly for old projects
    supabase
      .from('project_custom_domains')
      .select('domain')
      .eq('project_id', data.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
      .then(({ data: domainRow }) => {
        if (domainRow?.domain) setDbCustomDomain(domainRow.domain);
        else setDbCustomDomain(null);
      });
  };

  // Re-sync domain state when the user navigates back from the settings page
  useEffect(() => {
    if (!projectId) return;
    const syncDomainState = async () => {
      const { data: domainRow } = await supabase
        .from('project_custom_domains')
        .select('domain')
        .eq('project_id', projectId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      setDbCustomDomain(domainRow?.domain ?? null);
      const { data: proj } = await supabase
        .from('projects')
        .select('published_url, published_subdomain')
        .eq('id', projectId)
        .maybeSingle();
      if (proj) {
        setProject(prev => prev ? { ...prev, published_url: proj.published_url, published_subdomain: proj.published_subdomain } : prev);
        if (proj.published_url) setPublishedUrl(proj.published_url);
        if (proj.published_subdomain) setPublishSlug(proj.published_subdomain);
      }
    };
    window.addEventListener('focus', syncDomainState);
    return () => window.removeEventListener('focus', syncDomainState);
  }, [projectId]);

  const normalizeProjectFiles = (files: any[]) => {
    const sanitizePath = (rawPath: unknown): string | null => {
      if (typeof rawPath !== 'string') return null;

      // Repair common malformed AI output (quoted/comma suffixed paths)
      const path = rawPath
        .trim()
        .replace(/^[\"'`,\s]+|[\"'`,\s]+$/g, '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/');

      if (!path) return null;
      if (path.includes('..')) return null;
      if (/[^A-Za-z0-9._/@\-\s]/.test(path)) return null;

      return path;
    };

    // Clone/sanitize to avoid mutation of original objects and drop invalid paths
    const normalizedSeed = files
      .map((f) => {
        const nextPath = sanitizePath(f?.path);
        if (!nextPath) {
          console.warn('[Editor] Dropping invalid file path during normalization:', f?.path);
          return null;
        }

        return {
          ...f,
          path: nextPath,
          content: typeof f?.content === 'string' ? f.content : '',
        };
      })
      .filter((f): f is { path: string; content: string; [key: string]: any } => Boolean(f));

    // De-duplicate by path, latest entry wins
    const byPath = new Map<string, any>();
    normalizedSeed.forEach((f) => byPath.set(f.path, f));
    const normalized = Array.from(byPath.values());

    const hasPath = (target: string) => normalized.some(f => f.path === target);
    const upsert = (path: string, content: string) => {
      if (hasPath(path)) return;
      normalized.push({ path, content });
    };

    // Check for entry point
    const mainIndex = normalized.findIndex(f => f.path === 'src/main.tsx' || f.path === 'src/main.jsx');
    const indexIndex = normalized.findIndex(f => f.path === 'src/index.tsx' || f.path === 'src/index.jsx');
    const appIndex = normalized.findIndex(f => f.path === 'src/App.tsx' || f.path === 'src/App.jsx');

    if (mainIndex === -1) {
      if (indexIndex !== -1) {
        // Rename index to main
        console.log('[Editor] Normalizing: Renaming index.tsx to main.tsx');
        normalized[indexIndex].path = 'src/main.tsx';
      } else if (appIndex !== -1) {
        // Create main.tsx
        console.log('[Editor] Normalizing: Creating default main.tsx');
        normalized.push({
          path: 'src/main.tsx',
          content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`
        });
      }
    }

    upsert('index.html', `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`);

    upsert('src/App.tsx', `function App() {
  return <div className="p-6">Preview Ready</div>;
}

export default App;
`);

    upsert('src/main.tsx', `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`);

    upsert('src/index.css', `@tailwind base;
@tailwind components;
@tailwind utilities;
`);

    upsert('package.json', JSON.stringify({
      name: 'preview-app',
      private: true,
      version: '0.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview'
      },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1'
      },
      devDependencies: {
        '@types/react': '^18.3.5',
        '@types/react-dom': '^18.3.0',
        '@vitejs/plugin-react': '^4.3.1',
        autoprefixer: '^10.4.20',
        postcss: '^8.4.47',
        tailwindcss: '^3.4.13',
        typescript: '^5.5.3',
        vite: '^5.4.1'
      }
    }, null, 2));

    upsert('postcss.config.js', `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`);

    upsert('tailwind.config.ts', `import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
`);

    upsert('vite.config.ts', `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`);

    upsert('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'Bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: 'react-jsx',
        strict: false
      },
      include: ['src']
    }, null, 2));

    upsert('tsconfig.node.json', JSON.stringify({
      compilerOptions: {
        composite: true,
        skipLibCheck: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowSyntheticDefaultImports: true,
        strict: true,
        noEmit: true
      },
      include: ['vite.config.ts']
    }, null, 2));

    return normalized;
  };

  // buildPreviewNavigationUrl is imported from @/utils/previewNavigation

  const loadLatestCode = async (): Promise<boolean> => {
    try {
      // Load latest revision from database
      const revisions = await revisionService.getRevisions(projectId!, 1, 0);
      if (revisions && revisions.length > 0) {
        const latestRevision = revisions[0];

        // Set latest preview URL for sharing
        if (latestRevision.preview_url) {
          setLatestPreviewUrl(latestRevision.preview_url);
        }

        // Full file content is fetched on demand for just this one revision —
        // getRevisions() above intentionally omits generated_files/generated_code
        // (can be tens of MB per row) since list callers only need metadata.
        const latestFiles = await revisionService.getRevisionFiles(projectId!, latestRevision.id);

        if (latestFiles.length > 0) {
          console.log('[Editor] Loading revision with JSONB files:', latestFiles.length);
          let files = latestFiles.map((file: any) => ({
            path: file.path,
            content: file.content,
            type: file.type,
            operation: file.operation,
          }));

          // Drop obviously corrupt source files (e.g., .tsx containing markdown/config content)
          files = files.filter((f: any) => {
            if (/\.(tsx?|jsx?)$/.test(f.path) && typeof f.content === 'string') {
              const trimmed = f.content.trimStart();
              // Markdown/config files start with # but valid JSX never does
              if (/^#\s/.test(trimmed)) {
                console.warn(`[Editor] Dropping corrupt revision file: ${f.path} (contains non-JSX content)`);
                return false;
              }
            }
            return true;
          });

          // Normalize files (ensure entry point)
          files = normalizeProjectFiles(files);

          setGeneratedFiles(files);
          const htmlFile = files.find(f => f.path === 'index.html' || f.path.endsWith('.html')) || files[0];
          setGeneratedCode(htmlFile?.content || '');

          // Sync to workspace for local preview

          files.forEach((file: any) => {
            writeFileWorkspace(file.path, file.content, 'ai');
          });



          // Always re-sync revision files into preview service.
          // A stale preview URL can still return HTTP 200 while only serving
          // the default placeholder app after preview service restarts.
          try {
            transitionPreviewStatus('building', {
              message: 'Building preview...',
              details: `${files.length} files`,
            });

            const health = await checkPreviewHealth(projectId!);
            if (!health.isDockerAvailable) {
              throw new Error(health.error || 'Preview service unavailable');
            }

            const filesToUpdate = files.map((f: any) => ({ path: f.path, content: f.content }));
            const result = await updateDockerPreview(projectId!, filesToUpdate);

            if (!result.success) {
              throw new Error(result.error || 'Failed to sync preview files');
            }

            const baseUrl = getPreviewUrl(projectId!);
            const separator = baseUrl.includes('?') ? '&' : '?';
            setPreviewUrl(`${baseUrl}${separator}t=${Date.now()}`);
            setLatestPreviewUrl(baseUrl);
            transitionPreviewStatus('ready', { message: 'Preview Ready' });
            console.log('[Editor] Preview synced from latest revision files');
          } catch (syncError) {
            console.warn('[Editor] Preview sync from latest revision failed:', syncError);

            // Fallback to previously saved URL if available, otherwise fallback build path.
            if (latestRevision.preview_url) {
              setPreviewUrl(latestRevision.preview_url);
              transitionPreviewStatus(latestRevision.preview_status || 'pending');
            } else {
              // Pass filesToUpdate explicitly to avoid stale workspaceFiles/generatedFiles closure.
              // At this point React state updates from writeFileWorkspace haven't flushed yet,
              // so reading workspaceFiles or generatedFiles from the closure returns old values.
              const filesToUpdate = files.map((f: any) => ({ path: f.path, content: f.content }));
              await buildPreviewNow(filesToUpdate);
            }
          }
        } else {
          // Fallback to old format
          const code = await revisionService.getLegacyGeneratedCode(latestRevision.id);
          setGeneratedCode(code);
          setGeneratedFiles([{ path: 'index.html', content: code }]);
        }
        return true;
      }
    } catch (error) {
      console.error('Error loading latest revision:', error);
    }
    return false;
  };

  useEffect(() => {
    if (projectId) {
      // Load from Storage first — one small request per file, and it's what
      // every active project already has fully populated. This used to be the
      // "slow" fallback, with the single revisions.generated_files row treated
      // as the fast path — but that row holds the FULL content of every file
      // in the project inlined into one JSONB column, with no way to fetch it
      // partially. For any project that's accumulated enough files/history,
      // that single "fast" query balloons into a multi-MB (sometimes 40MB+)
      // payload on every editor load. Only fall back to the heavy revision
      // blob if Storage is genuinely empty (true legacy projects that
      // predate Storage-based file sync) — never load it just because a
      // revision happens to exist.
      loadWorkspaceFromDb().then(hasStorageFiles => {
        if (!hasStorageFiles) {
          loadLatestCode().catch(err => {
            console.warn('[Editor] Failed to load latest revision as fallback:', err);
          });
        } else {
          setHasInitialLoadCompleted(true);
        }
      }).catch(err => {
        console.warn('[Editor] Failed to load workspace from Storage, falling back to revision:', err);
        loadLatestCode().catch(fallbackErr => {
          console.warn('[Editor] Fallback revision load also failed:', fallbackErr);
        });
      });
    }
  }, [projectId, loadWorkspaceFromDb]);

  // Generate local preview from workspace files when no cloud URL
  useEffect(() => {
    // Only generate local preview if:
    // 1. No cloud preview URL is available
    // 2. Workspace has files
    // 3. Not currently loading (both component and workspace)
    // 4. Workspace has finished loading (hasInitialLoadCompleted)
    const workspaceFilesList = Array.from(workspaceFiles.values()).map(f => ({
      path: f.path,
      content: f.content,
    }));

    if (!previewUrl && workspaceFilesList.length > 0 && !isLoading && !isWorkspaceLoading && hasInitialLoadCompleted) {
      // Local preview disabled for security isolation
      // console.log('[Editor] Local preview disabled.');
      setLocalPreviewHtml(null);
    }
  }, [workspaceFiles, previewUrl, isLoading, isWorkspaceLoading, hasInitialLoadCompleted]);



  // Define buildPreviewNow at component level
  const buildPreviewNow = useCallback(async (
    overrideFiles?: Array<{ path: string; content: string }>,
    targetPath?: string
  ) => {
    // Guard: if something non-array is accidentally passed (e.g. a MouseEvent from an
    // onClick handler), treat it as "no override" so we fall back to workspace state.
    const safeOverride = Array.isArray(overrideFiles) ? overrideFiles : undefined;

    // When overrideFiles is provided (e.g. immediately after generation), use it directly
    // to avoid a stale-snapshot race with async React state updates from writeFileWorkspace.
    const filesSnapshot = safeOverride ?? (
      Array.from(workspaceFiles.values()).length > 0
        ? Array.from(workspaceFiles.values()).map((f) => ({ path: f.path, content: f.content }))
        : generatedFiles.map((f) => ({ path: f.path, content: f.content }))
    );

    return enqueuePreviewSync('buildPreviewNow', async () => {
      const filesToUse = filesSnapshot;
      const workspaceSnapshotMap = new Map(
        Array.from(workspaceFiles.values()).map((f) => [f.path.replace(/^\//, ''), { path: f.path, content: f.content }])
      );
      const previousFilesMap = lastSuccessfulPreviewFilesRef.current.size > 0
        ? new Map(lastSuccessfulPreviewFilesRef.current)
        : workspaceSnapshotMap;

      console.log('[Editor] Building preview from', filesToUse.length, 'files');
      transitionPreviewStatus('building', {
        message: 'Building preview...',
        details: `${filesToUse.length} files`,
      });

      // Validate and auto-fix files before sending to preview service
      const validationResult = validateAndFixFiles(filesToUse);

      // Log any fixes applied
      if (validationResult.fixedFiles.length > 0) {
        const totalFixes = validationResult.fixedFiles.reduce((sum, f) => sum + f.fixes.length, 0);
        console.log(`[Editor] Auto-fixed ${totalFixes} issue(s) in ${validationResult.fixedFiles.length} file(s)`);
      }

      // Log warnings if any
      validationResult.warnings.forEach(w => {
        console.log(`[Editor] Validation warning: ${w.file}: ${w.message}`);
      });

      // Log errors if any (but don't block - preview service may still work)
      validationResult.errors.forEach(e => {
        console.warn(`[Editor] Validation error: ${e.file}: ${e.message}`);
      });

      if (validationResult.errors.length > 0) {
        transitionPreviewStatus('building', {
          message: 'Preview validation found syntax issues...',
          details: `${validationResult.errors.length} blocking file(s) need recovery or repair`,
        });
      }

      // Use fixed files for preview
      const fixedFiles = normalizeProjectFiles(getFixedContent(filesToUse));

      // If validation still reports blocking files, rollback those files to last known-good content.
      const safeSet = buildSafeFilesAfterValidation(fixedFiles, previousFilesMap, validationResult.errors);
      const previewFiles = normalizeProjectFiles(safeSet.files);
      if (safeSet.rolledBack > 0) {
      }
      if (safeSet.unresolved.length > 0) {
        const unresolvedList = safeSet.unresolved.slice(0, 3).join(', ');
        transitionPreviewStatus('building', {
          message: 'Preview still has unrecovered syntax issues...',
          details: unresolvedList,
        });
      }

      // Check if Docker preview is available
      const health = await checkPreviewHealth(projectId!);

      if (health.isDockerAvailable) {
        // Try Docker preview
        console.log('[Editor] Docker preview available, syncing files...', health);

        let filesToUpdate = previewFiles.map((f: any) => ({ path: f.path, content: f.content }));

        let result = await updateDockerPreview(projectId!, filesToUpdate);

        // One retry path: if Docker rejects specific invalid source files,
        // replace those files from last known-good snapshot and retry once.
        if (!result.success) {
          const invalidPaths = extractInvalidSourceFiles(result.error);
          const retry = buildRetryFilesWithFallback(previewFiles, previousFilesMap, invalidPaths);

          if (retry && retry.safeToRetry && retry.replaced > 0) {
            filesToUpdate = retry.files.map((f: any) => ({ path: f.path, content: f.content }));
            result = await updateDockerPreview(projectId!, filesToUpdate);
          }
        }

        if (result.success) {
          // Updated immediately as requested
          lastSuccessfulPreviewFilesRef.current = new Map(
            filesToUpdate.map((f: { path: string; content: string }) => [f.path.replace(/^\//, ''), { path: f.path, content: f.content }])
          );
          const baseUrl = getPreviewUrl(projectId!);
          const navPath = targetPath ?? previewPathRef.current ?? '/';
          setPreviewUrl(buildPreviewNavigationUrl(baseUrl, navPath, true));
          setLatestPreviewUrl(baseUrl);
          transitionPreviewStatus('ready', { message: 'Preview Ready' });
          return;
        }

        console.warn('[Editor] Docker update failed:', result.error);
        transitionPreviewStatus('failed', {
          message: 'Preview Failed',
          details: result.error,
        });
        toast.error('Preview update failed. Your code changes are still saved and were not reverted.');
        return;
      }

      // Fallback block removed for security isolation
      console.warn('[Editor] Docker preview required but unavailable.');
      console.warn('[Editor] Health check details:', health);
      transitionPreviewStatus('failed', {
        message: 'Preview Unavailable',
        details: health.error,
      });
      toast.error(`Preview unavailable (${health.error || 'network/service issue'}). Your code remains unchanged.`);
    }, { coalesce: true });
  }, [projectId, workspaceFiles, generatedFiles, addSystemMessage, transitionPreviewStatus, enqueuePreviewSync]);

  const scheduleCodeEditorPreviewSync = useCallback(() => {
    if (codeEditorSyncTimeoutRef.current) {
      clearTimeout(codeEditorSyncTimeoutRef.current);
    }

    codeEditorSyncTimeoutRef.current = setTimeout(() => {
      buildPreviewNow().catch((error) => {
        console.error('[Editor] Code editor preview sync failed:', error);
      });
    }, 1200);
  }, [buildPreviewNow]);

  // Track when the workspace has completed its initial load.
  // When storage had files but JSONB was null (cleared by revisionService.createRevision),
  // loadLatestCode finds nothing in JSONB and skips the Docker sync. We catch that case
  // here: if workspace just finished loading AND there is no preview URL yet, sync to Docker.
  useEffect(() => {
    if (prevWorkspaceLoadingRef.current && !isWorkspaceLoading && workspaceFiles.size > 0) {
      console.log('[Editor] Workspace loading completed. Files loaded:', workspaceFiles.size);
      setHasInitialLoadCompleted(true);

      // Only build if there's no URL and the preview is not already building.
      // Guards against a double-build race where saveToDatabase completes (isWorkspaceLoading
      // briefly → true → false) while buildPreviewNow from onFilesGenerated is still running.
      if (!previewUrl && previewStatus !== 'building') {
        buildPreviewNow().catch((err) => {
          console.warn('[Editor] Initial preview build from workspace failed:', err);
        });
      }
    }

    prevWorkspaceLoadingRef.current = isWorkspaceLoading;
  }, [isWorkspaceLoading, workspaceFiles, previewUrl, previewStatus, buildPreviewNow]);


  const loadMessages = async () => {
    if (isGuest) { setMessages([]); return; }
    // Bounded fetch — this used to be an unbounded select("*") over the whole
    // project's message history, re-downloading every message every time the
    // editor mounted. AgentChatPanel renders its own paginated history; this
    // state is only consulted for "has any user message" / "last user message"
    // checks below, so the most recent 50 is more than enough.
    try {
      const { messages: recent } = await messageService.loadRecentMessages(projectId!, 50);
      setMessages(recent);
    } catch (error) {
      console.error("Error loading messages:", error);
    }
  };

  const validateFiles = (fileList: FileList): boolean => {
    if (attachedFiles.length + fileList.length > 10) {
      toast.error('Maximum 10 files allowed');
      return false;
    }

    for (let i = 0; i < fileList.length; i++) {
      if (fileList[i].size > 20 * 1024 * 1024) {
        toast.error(`File ${fileList[i].name} exceeds 20MB limit`);
        return false;
      }
    }
    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && validateFiles(e.target.files)) {
      setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeFile = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const getFilePreview = (file: File): string => {
    if (file.type.startsWith('image/')) {
      return URL.createObjectURL(file);
    }
    return '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && validateFiles(e.dataTransfer.files)) {
      setAttachedFiles(prev => [...prev, ...Array.from(e.dataTransfer.files)]);
      toast.success(`${e.dataTransfer.files.length} file(s) added`);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      const dataTransfer = new DataTransfer();
      imageFiles.forEach(file => dataTransfer.items.add(file));

      if (validateFiles(dataTransfer.files)) {
        setAttachedFiles(prev => [...prev, ...imageFiles]);
        toast.success(`${imageFiles.length} image(s) pasted`);
      }
    }
  };

  const handlePreviewFile = (file: { path: string; content: string }) => {
    console.log('[Editor] Previewing individual file:', file.path);
    setPreviewFileOverride(file);
    setShowCodeViewer(false);
    toast.success(`Previewing ${file.path}`);
  };

  const handleGenerateWithContext = async (promptText: string, fileContext?: string) => {
    if (!promptText.trim()) {
      toast.error("Please enter a prompt");
      return;
    }

    setPrompt(""); // Clear input
    setIsLoading(true);
    setWorkflowComplete(false);
    sentMessagesRef.current.clear();

    let latestFiles: Array<{ path: string; content: string }> = [];

    try {
      console.log('[Editor] Starting promptService stream generation...');

      const promptResult = await promptService.handlePrompt(
        {
          promptText,
          projectId: projectId!,
          userId: currentUser?.id || '',
          currentUser,
          organizationId: currentOrganizationId,
          fileContext,
          existingFiles: generatedFiles,
          hasRealApp:
            generatedFiles.length > 1 ||
            (generatedFiles.length === 1 && !generatedFiles[0].path.endsWith('index.html')),
          fingerprint: isGuest ? guestFingerprint : undefined,
        },
        {
          onMessageAdd: (message) => {
            if (message.role !== 'assistant' && message.role !== 'user') return;
            const normalizedMessage: { role: 'assistant' | 'user'; content: string } = {
              role: message.role,
              content: message.content,
            };
            setMessages((prev) => [...prev, normalizedMessage]);
          },
          onSystemMessage: addSystemMessage,
          onFilesUpdate: (files) => {
            const normalized = normalizeProjectFiles(files);
            latestFiles = normalized;
            setGeneratedFiles(normalized);

            const htmlFile = normalized.find((f) => f.path === 'index.html') || normalized[0];
            setGeneratedCode(htmlFile?.content || '');

            normalized.forEach((file) => {
              writeFileWorkspace(file.path, file.content, 'ai');
            });
          },
          onCodeUpdate: setGeneratedCode,
          onLoadingChange: setIsLoading,
          onWorkflowComplete: setWorkflowComplete,
          onPreviewStatusChange: (status) => transitionPreviewStatus(status),
          onPreviewUrlChange: (url) => {
            setPreviewUrl(url);
            setLatestPreviewUrl(url);
          },
        }
      );

      // Eco deducted by backend. Refresh usage display to sync counter.
      if (!isGuest) {
        refreshUsage().catch((err) => console.error('[Editor] Error refreshing usage:', err));
      }
    } catch (error) {
      console.error('Error generating app:', error);
      setWorkflowComplete(false);

      const message = error instanceof Error
        ? error.message
        : 'AI generation failed. Please try again.';

      const errorMessage = {
        role: 'assistant' as const,
        content: ` Generation failed: ${message}`,
      };
      setMessages((prev) => [...prev, errorMessage]);

      if (!isGuest) {
        await supabase.from('messages').insert({
          project_id: projectId,
          role: 'assistant',
          content: errorMessage.content,
        });
      }

      toast.warning('Generation failed. Existing project files were kept.');
    } finally {
      if (generationProgressRef.current) {
        clearInterval(generationProgressRef.current);
        generationProgressRef.current = null;
      }
      sentMessagesRef.current.clear();
      setIsLoading(false);
    }
  };

  const handleGenerate = async () => {
    console.log('[Editor] handleGenerate called with prompt:', prompt);

    // Reset to core stage for new generations
    setGenerationStage('core');
    setShowExpandButton(false);

    // Check if this is a temp project and user is trying to generate 2nd prompt
    const TEMP_PROJECT_KEY = 'ecomgear_temp_project';
    const tempProjectData = localStorage.getItem(TEMP_PROJECT_KEY);

    if (!currentUser && tempProjectData && !isGuest) {
      try {
        const { projectId: tempProjectId } = JSON.parse(tempProjectData);
        // If this temp project has any messages, require login
        if (tempProjectId === projectId && messages.length > 0) {
          toast.error("Please log in to continue generating");
          navigate('/auth?tab=login');
          return;
        }
      } catch (e) {
        console.error("Error checking temp project:", e);
      }
    }

    // Guest mode: check remaining requests
    if (isGuest) {
      const guestReqKey = 'ecg_guest_requests';
      const used = parseInt(localStorage.getItem(guestReqKey) || '0', 10);
      if (used >= 3) {
        toast.error("You've used all 3 free generations. Please sign up to continue!");
        navigate('/auth', {
          state: {
            message: 'Sign up to unlock unlimited AI generations',
            redirectTo: '/',
          },
        });
        return;
      }
      // Optimistically increment local counter (backend does the real check)
      localStorage.setItem(guestReqKey, String(used + 1));
    }

    let fileContext = "";

    try {
      console.log('[Editor] Checking for attached files:', attachedFiles.length);

      // Parse files if any
      if (attachedFiles && attachedFiles.length > 0) {
        toast.info("Processing attached files...");
        for (let i = 0; i < attachedFiles.length; i++) {
          const file = attachedFiles[i];
          console.log('[Editor] Parsing file:', file.name);

          const formData = new FormData();
          formData.append('file', file);

          const { data: parseData, error: parseError } = await supabase.functions.invoke('parse-file', {
            body: formData
          });

          if (parseError) {
            console.error('Error parsing file:', parseError);
            toast.error(`Failed to parse ${file.name}`);
          } else if (parseData?.extractedText) {
            fileContext += `\n\n${parseData.extractedText}`;
            console.log('[Editor] File parsed successfully:', file.name);
          }
        }
      }

      console.log('[Editor] About to call handleGenerateWithContext');
      await handleGenerateWithContext(prompt, fileContext);
    } catch (error) {
      console.error("Error in handleGenerate:", error);
      toast.error("Failed to start generation: " + (error instanceof Error ? error.message : 'Unknown error'));
      setIsLoading(false);
    }
  };

  const handleExpandToComplete = async () => {
    setGenerationStage('complete');
    setShowExpandButton(false);

    // Use the last user message or a default expand prompt
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const expandPrompt = lastUserMessage?.content || 'Expand to complete application';

    await handleGenerateWithContext(expandPrompt, '');
  };

  // ── Initialise publish dialog state whenever it opens ─────────────────────
  useEffect(() => {
    if (showPublishDialog) {
      // If already published — restore live URL so dialog shows "Your app is live"
      if (project?.published_url) {
        setPublishedUrl(project.published_url);
        if (project.published_subdomain) setPublishSlug(project.published_subdomain);
        return;
      }
      // New publish — auto-fill slug from project name (skip temp names) and open edit mode
      if (project?.name && !publishSlug) {
        const isTempName = /^(temp|project)-\d+$/.test(project.name);
        const auto = isTempName
          ? ''
          : project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61);
        setPublishSlug(auto);
      }
      setIsEditingSlug(true);
    }
    if (!showPublishDialog) {
      setSlugAvailable(null);
      setSlugChecking(false);
      setIsEditingSlug(false);
      setPublishMode('subdomain');
    }
  }, [showPublishDialog, project?.name]);

  // ── Debounced slug availability check ────────────────────────────────────
  useEffect(() => {
    if (!publishSlug || publishSlug.length < 3) { setSlugAvailable(null); return; }
    // Own slug (re-publish) — always available
    if (publishSlug === project?.published_subdomain) { setSlugAvailable(true); return; }
    setSlugChecking(true);
    setSlugAvailable(null);
    const t = setTimeout(async () => {
      const result = await domainService.checkSubdomainAvailability(publishSlug, projectId ?? undefined);
      if (!result.available && projectId) {
        // The slug may already belong to this project (e.g. after a re-publish).
        // Do a secondary DB lookup — if this project owns it, treat as available.
        const { data: owner } = await supabase
          .from('projects')
          .select('id')
          .eq('published_subdomain', publishSlug)
          .maybeSingle();
        if (owner?.id === projectId) {
          setSlugAvailable(true);
          setSlugChecking(false);
          return;
        }
      }
      setSlugAvailable(result.available);
      setSlugChecking(false);
    }, 500);
    return () => clearTimeout(t);
  }, [publishSlug, project?.published_subdomain]);

  const handlePublishToSubdomain = async () => {
    const isRepublish = publishSlug === project?.published_subdomain;
    if (!projectId || !publishSlug || (slugAvailable !== true && !isRepublish)) return;
    setIsPublishing(true);
    try {
      const files = Array.from(workspaceFiles.values()).map(f => ({ path: f.path, content: f.content }));

      // Each publish action counts as 1 against the monthly publish quota
      const allowed = await checkAndIncrementPublishLines(currentOrganizationId, 1);
      if (!allowed) {
        showLimitToast('You have reached your monthly publish limit.', 'starter');
        return;
      }

      const result = await domainService.publishToDomain(
        { projectId, userId: '', domain: publishSlug, domainType: 'subdomain' },
        files,
      );
      if (!result.success) throw new Error(result.error || 'Publish failed');

      // Persist to DB
      await supabase.from('projects').update({
        status: 'active',
        published_subdomain: publishSlug,
        published_url: result.publishedUrl,
        published_at: new Date().toISOString(),
      }).eq('id', projectId);

      setPublishedUrl(result.publishedUrl || null);
      if (project) setProject({ ...project, published_url: result.publishedUrl, published_subdomain: publishSlug });
      toast.success(`Live at ${result.publishedUrl}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUpdateSite = async () => {
    const slug = project?.published_subdomain;
    if (!projectId || !slug || !currentOrganizationId) return;
    setIsPublishing(true);
    try {
      const files = Array.from(workspaceFiles.values()).map(f => ({ path: f.path, content: f.content }));
      const allowed = await checkAndIncrementPublishLines(currentOrganizationId, 1);
      if (!allowed) {
        showLimitToast('You have reached your monthly publish limit.', 'starter');
        return;
      }
      const result = await domainService.publishToDomain(
        { projectId, userId: '', domain: slug, domainType: 'subdomain' },
        files,
      );
      if (!result.success) throw new Error(result.error || 'Update failed');
      await supabase.from('projects').update({
        status: 'active',
        published_subdomain: slug,
        published_url: result.publishedUrl,
        published_at: new Date().toISOString(),
      }).eq('id', projectId);
      toast.success(`Site updated at ${result.publishedUrl}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUpdateCustomDomainSite = async () => {
    // Prefer explicitly set customDomain, then DB-loaded custom domain,
    // then published_url only if it's a custom domain (not ecomgear subdomain)
    const customPublishedUrl = (project?.published_url && !project.published_url.includes('ecomgear.app'))
      ? project.published_url : null;
    const normalizedDomain = normalizeDomain(
      customDomain || dbCustomDomain || customPublishedUrl || ''
    );
    const slug = publishSlug || project?.published_subdomain || project?.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!projectId || !slug || !normalizedDomain || !currentOrganizationId) {
      toast.error('No custom domain found — connect a domain first from Settings.');
      return;
    }

    setIsPublishing(true);
    try {
      const files = Array.from(workspaceFiles.values()).map(f => ({ path: f.path, content: f.content }));
      const allowed = await checkAndIncrementPublishLines(currentOrganizationId, 1);
      if (!allowed) {
        showLimitToast('You have reached your monthly publish limit.', 'starter');
        return;
      }

      const deploy = await domainService.deployToHosting(projectId, slug, files);
      if (!deploy.success) {
        throw new Error(deploy.error || 'Production update failed');
      }
      if (deploy.hostingUrl) setHostingDeployUrl(deploy.hostingUrl);

      await supabase
        .from('projects')
        .update({
          status: 'active',
          published_url: `https://${normalizedDomain}`,
          published_at: new Date().toISOString(),
        })
        .eq('id', projectId);

      setCustomDomainActivated(true);
      setPublishedUrl(`https://${normalizedDomain}`);
      toast.success(`Production updated at https://${normalizedDomain}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Production update failed');
    } finally {
      setIsPublishing(false);
    }
  };

  const normalizeDomain = (value: string) => {
    return value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .split('/')[0];
  };

  const handlePrepareCustomDomain = async () => {
    const normalizedDomain = normalizeDomain(customDomain);
    const validDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(normalizedDomain);

    if (!projectId || !validDomain) {
      toast.error('Enter a valid domain like example.com or app.example.com');
      return;
    }

    setIsPublishing(true);
    try {
      const [config, domainRecord] = await Promise.all([
        domainService.getDomainConfiguration(normalizedDomain),
        domainService.addCustomDomain(projectId, normalizedDomain),
      ]);

      setCustomDomain(normalizedDomain);
      setCustomDomainConfig(config);
      setCustomDomainStatus(domainRecord.status);
      setCustomDomainActivated(false);
      toast.success('DNS setup generated. Add these records, then verify.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to prepare custom domain');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleCheckDnsOnly = async () => {
    const normalizedDomain = normalizeDomain(customDomain);
    if (!normalizedDomain) return;
    setIsCheckingDns(true);
    try {
      const result = await domainService.verifyDomainDNS(projectId, normalizedDomain);
      setDnsCheckResult({
        pointingOk: result.pointingOk ?? false,
        txtOk: result.txtOk ?? false,
        aRecord: result.detail?.a_record,
        cnameRecord: result.detail?.cname_record,
        txtRecord: result.detail?.txt_record,
        checkedAt: new Date().toLocaleTimeString(),
      });
    } catch {
      toast.error('DNS check failed — hosting service unreachable');
    } finally {
      setIsCheckingDns(false);
    }
  };

  const handleVerifyAndActivateCustomDomain = async () => {
    const normalizedDomain = normalizeDomain(customDomain);
    if (!projectId || !normalizedDomain) return;

    setIsPublishing(true);
    try {
      const files = Array.from(workspaceFiles.values()).map(f => ({ path: f.path, content: f.content }));
      const allowed = await checkAndIncrementPublishLines(currentOrganizationId, 1);
      if (!allowed) {
        showLimitToast('You have reached your monthly publish limit.', 'starter');
        return;
      }

      const deploy = await domainService.deployToHosting(projectId, publishSlug || project?.published_subdomain || 'site', files);
      if (!deploy.success) {
        throw new Error(deploy.error || 'Hosting deploy failed');
      }
      if (deploy.hostingUrl) setHostingDeployUrl(deploy.hostingUrl);

      const verification = await domainService.verifyDomainDNS(normalizedDomain);
      setCustomDomainStatus(verification.status);
      if (!verification.verified) {
        if (verification.error) {
          toast.error(`Verification error: ${verification.error}`);
        } else {
          const missing: string[] = [];
          if (!verification.pointingOk) {
            const rec = verification.detail?.a_record ?? verification.detail?.cname_record;
            missing.push(rec ? `A/CNAME (expected: ${rec.expected}, found: ${rec.found.join(', ') || 'none'})` : 'A or CNAME record');
          }
          if (!verification.txtOk) {
            const txt = verification.detail?.txt_record;
            missing.push(txt ? `TXT at ${txt.host} (expected: ${txt.expected}, found: ${txt.found.join(', ') || 'none'})` : 'TXT verification record');
          }
          toast.error(`DNS not verified. Missing or wrong: ${missing.join(' · ')}`);
        }
        return;
      }

      const activation = await domainService.activateCustomDomain(normalizedDomain, projectId);
      if (!activation.success) {
        throw new Error(activation.error || 'Domain activation failed');
      }

      await supabase
        .from('projects')
        .update({
          status: 'active',
          published_url: `https://${normalizedDomain}`,
          published_at: new Date().toISOString(),
        })
        .eq('id', projectId);

      setCustomDomainActivated(true);
      setPublishedUrl(`https://${normalizedDomain}`);
      toast.success(`Custom domain is live at https://${normalizedDomain}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to activate custom domain');
    } finally {
      setIsPublishing(false);
    }
  };

  const handlePublish = async () => {    try {
      const publishedUrl = `https://${project?.name}.ecomgear.app`;

      await supabase
        .from("projects")
        .update({
          status: 'active'
        })
        .eq("id", projectId);

      await loadProject();

      // Track referral publishing event
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // Check if this is the user's first publish
          const { data: publishedProjects } = await supabase
            .from('projects')
            .select('id')
            .eq('user_id', user.id)
            .eq('status', 'active');

          if (publishedProjects && publishedProjects.length === 1) {
            // This is their first published site - track referral
            const { data: referrals } = await supabase
              .from('referrals')
              .select('referral_code')
              .eq('referred_user_id', user.id)
              .eq('status', 'registered')
              .maybeSingle();

            if (referrals?.referral_code) {
              await supabase.functions.invoke('track-referral', {
                body: {
                  referral_code: referrals.referral_code,
                  event_type: 'published',
                  user_id: user.id,
                },
              });
            }
          }
        }
      } catch (err) {
        console.error('Failed to track referral publish:', err);
      }

      toast.success("Project published successfully! URL: " + publishedUrl);
      setShowPublishDialog(false);
    } catch (error) {
      console.error("Error publishing:", error);
      toast.error("Failed to publish project");
    }
  };

  const handleUnpublish = async () => {
    try {
      await supabase
        .from("projects")
        .update({ status: 'inactive' })
        .eq("id", projectId);

      await loadProject();
      toast.success("Project unpublished");
    } catch (error) {
      console.error("Error unpublishing:", error);
      toast.error("Failed to unpublish");
    }
  };

  const handleDownloadProductionBundle = async () => {
    if (!projectId) return;

    try {
      setIsLoading(true);
      toast.info("Deploying to production...");

      // Call deployment edge function
      const { data, error } = await supabase.functions.invoke('deploy-to-production', {
        body: {
          project_id: projectId,
          custom_domain: customDomain || undefined
        }
      });

      if (error) throw error;

      if (data.success) {
        toast.success(`Deployed successfully to ${data.url}`);
        await loadProject();
        setShowPublishDialog(false);
      } else {
        throw new Error(data.error || 'Deployment failed');
      }
    } catch (error) {
      console.error("Error deploying:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Deployment failed: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateProjectName = async () => {
    if (!project) return;

    try {
      const trimmedName = editProjectName.trim();

      if (!trimmedName) {
        toast.error('Project name cannot be empty');
        return;
      }

      if (trimmedName.length < 2 || trimmedName.length > 100) {
        toast.error('Project name must be between 2 and 100 characters');
        return;
      }

      setUpdatingProjectName(true);

      const { error } = await supabase
        .from('projects')
        .update({ name: trimmedName })
        .eq('id', projectId);

      if (error) throw error;

      toast.success('Project name updated');
      setProject({ ...project, name: trimmedName });
      setIsEditingProjectName(false);
    } catch (error) {
      console.error('Failed to update project name:', error);
      toast.error('Failed to update project name');
    } finally {
      setUpdatingProjectName(false);
    }
  };

  const handleRevisionSelect = useCallback(async (filesOrCode: Array<{ path: string; content: string; type?: string }> | string, previewUrl: string | undefined, restoredRevisionId: string) => {
    setIsLoading(false);

    let files: Array<{ path: string; content: string; type?: string }> = [];
    if (typeof filesOrCode === 'string') {
      files = [{ path: 'index.html', content: filesOrCode }];
      setGeneratedCode(filesOrCode);
      setGeneratedFiles(files);
    } else {
      files = filesOrCode;
      setGeneratedFiles(filesOrCode);
      const mainFile = filesOrCode.find(f => f.path === 'index.html' || f.path.endsWith('.html')) || filesOrCode[0];
      setGeneratedCode(mainFile?.content || '');
    }

    setWorkspaceFiles(files.map((file) => ({ path: file.path, content: file.content })));

    // Persist the restored state as a new revision so refreshing loads these files,
    // not the previous "latest" (which may contain the bug the user was reverting away from).
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user && projectId && files.length > 0) {
        const htmlFile = files.find(f => f.path === 'index.html' || f.path.endsWith('.html')) || files[0];
        await revisionService.createRevision({
          project_id: projectId,
          prompt: `Restored to revision ${restoredRevisionId.slice(0, 8)}`,
          generated_code: htmlFile?.content || '',
          generated_files: { files: files.map(f => ({ path: f.path, content: f.content ?? '', type: f.type })) },
          user_id: user.id,
        });
      }
    } catch (persistErr) {
      console.warn('[Editor] Failed to persist revision restore:', persistErr);
    }

    if (previewUrl) {
      setPreviewUrl(previewUrl);
      transitionPreviewStatus('ready', { message: 'Preview Ready' });
      setActiveBuilderTab('preview');
      return;
    }

    transitionPreviewStatus('building', { message: 'Building preview...' });
    toast.info('Starting preview build...');
    try {
      await buildPreviewNow();
    } catch (error) {
      console.error('[Editor] Failed to build preview for selected revision:', error);
      transitionPreviewStatus('failed', {
        message: 'Preview Failed',
        details: error instanceof Error ? error.message : String(error),
      });
      toast.error('Failed to build preview for this revision');
    }
    setActiveBuilderTab('preview');
  }, [setActiveBuilderTab, setWorkspaceFiles, buildPreviewNow, transitionPreviewStatus]);

  const viewportClasses = {
    desktop: "w-full h-full",
    tablet: "w-[768px] h-[1024px] mx-auto border-8 border-gray-800 rounded-xl",
    mobile: "w-[375px] h-[667px] mx-auto border-8 border-gray-800 rounded-[2.5rem]",
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const media = window.matchMedia('(max-width: 1023px)');
    setIsMobileViewport(media.matches);

    if (media.matches) {
      setIsMinimized(true);
    }

    const onMediaChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
      if (event.matches) {
        setIsMinimized(true);
      }
    };

    media.addEventListener('change', onMediaChange);
    return () => media.removeEventListener('change', onMediaChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;

      if (isModifier && event.key === '\\') {
        event.preventDefault();
        setIsMinimized((prev) => !prev);
        return;
      }

      if (event.key === 'Escape' && !isMinimized && window.innerWidth < 1024) {
        event.preventDefault();
        setIsMinimized(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMinimized]);

  useEffect(() => {
    if (!requestedTab || !BUILDER_TABS.includes(requestedTab as BuilderTab)) {
      setActiveBuilderTab('preview');
    }
  }, [requestedTab, setActiveBuilderTab]);

  useEffect(() => {
    if (activeBuilderTab === 'code') {
      setShowCodeViewer(true);
    }

    if (activeBuilderTab === 'preview') {
      setShowCodeViewer(false);
    }

    if (activeBuilderTab === 'brief' || activeBuilderTab === 'generate' || activeBuilderTab === 'revisions') {
      setIsMinimized(false);
    }

    if (activeBuilderTab === 'publish') {
      if (!canShowPublishActions) {
        toast.error('Generate your app before publishing');
        setActiveBuilderTab('preview');
        return;
      }
      if (isGuest) {
        toast.error("Sign up to publish your site");
        setActiveBuilderTab('preview');
        return;
      }
      if (!currentOrganizationId) {
        toast.error("Join or create an organization to publish your site");
        setActiveBuilderTab('preview');
        return;
      }
      setShowPublishDialog(true);
    }
  }, [activeBuilderTab, canShowPublishActions, currentOrganizationId, isGuest, setActiveBuilderTab]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#09090b]">
      <WorkspaceLoader
        visible={isWorkspaceLoading && !hasInitialLoadCompleted}
        projectName={project?.name}
        fileCount={workspaceFiles.size > 0 ? workspaceFiles.size : undefined}
        authResolved={!!currentUser}
        projectFetched={!!project}
        filesRestored={!isWorkspaceLoading && workspaceFiles.size > 0}
        previewFirstPaint={previewFirstPaint}
      />
      {!isMobileViewport && !isMinimized && (
        <button
          type="button"
          aria-label="Close assistant panel"
          onClick={() => setIsMinimized(true)}
          className="lg:hidden fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]"
        />
      )}

      {isMobileViewport && (
        <>
          <Sheet open={!isMinimized} onOpenChange={(open) => setIsMinimized(!open)}>
            <SheetContent
              side="bottom"
              className="h-[82vh] border-white/[0.06] bg-[#0e0e10] p-0 sm:max-w-none"
              aria-describedby={undefined}
            >
              <SheetTitle className="sr-only">Assistant</SheetTitle>
              <div className="h-full flex flex-col">
                <div className="h-14 flex items-center justify-between px-4 bg-[#131315]/60 backdrop-blur-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={ecgLogo}
                      alt="eCG"
                      className="h-5 w-auto object-contain"
                    />
                    <div className="h-4 w-px bg-white/[0.08]" />
                    <span className="text-sm font-medium text-white/80 truncate">Assistant</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openSettings()}
                      className="h-8 w-8 text-white/30 hover:text-white/80 hover:bg-white/[0.06] rounded-lg"
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {projectId && (currentUser || isGuest) && (
                    <AgentChatPanel
                      currentOrganizationId={currentOrganizationId}
                      projectId={projectId}
                      userId={currentUser?.id || `guest:${guestFingerprint || 'anonymous'}`}
                      isMinimized={false}
                      triggerPrompt={repairPrompt}
                      onTriggerConsumed={() => {
                        setRepairPrompt(null);
                        isAgentRunningRef.current = true;
                      }}
                      onFilesGenerated={(files, filesToDelete, previewPushed) => {
                        const normalizedFiles = files.length > 0
                          ? normalizeProjectFiles(files.map(f => ({ path: f.path, content: f.content })))
                          : [];
                        const deletedSet = new Set((filesToDelete ?? []).map(p => p.replace(/^\//, '')));
                        if (normalizedFiles.length > 0) {
                          setGeneratedFiles(normalizedFiles as any[]);
                          const htmlFile = normalizedFiles.find(f => f.path === 'index.html' || f.path.endsWith('.html')) || normalizedFiles[0];
                          if (htmlFile) setGeneratedCode(htmlFile.content);
                        }
                        deletedSet.forEach((deletedPath) => deleteFileWorkspace(deletedPath, 'ai'));
                        normalizedFiles.forEach((file) => writeFileWorkspace(file.path, file.content, 'ai'));
                        saveWorkspaceToDb().catch((err) => {
                          console.error('[Editor] Failed to persist agent files:', err);
                          scheduleWorkspaceSave();
                        });
                        if (normalizedFiles.length > 0 && !previewPushed) {
                          const merged = new Map(
                            Array.from(workspaceFiles.values())
                              .filter(f => !deletedSet.has(f.path.replace(/^\//, '')))
                              .map(f => [f.path, { path: f.path, content: f.content }])
                          );
                          normalizedFiles.forEach(f => merged.set(f.path, f));
                          buildPreviewNow(Array.from(merged.values()), previewPathRef.current || '/').catch((error) => {
                            console.error('[Editor] Preview sync failed after generation:', error);
                          });
                        }
                        lastAgentEcoRef.current = normalizedFiles.length > 0 ? 1 : 0;
                      }}
                      onGenerationComplete={() => {
                        isAgentRunningRef.current = false;
                        if (!pendingAutoRepairRef.current) {
                          consecutiveRepairsRef.current = 0;
                        }
                        pendingAutoRepairRef.current = false;
                        if (document.visibilityState === 'visible' && previewUrlRef.current) {
                          setActiveBuilderTab('preview');
                        }
                        if (!isGuest) {
                          refreshUsage().catch((err) =>
                            console.error('[Editor] Error refreshing usage:', err)
                          );
                        }
                      }}
                      onPreviewCommand={(cmd) => {
                        if ((cmd === 'restart' || cmd === 'refresh' || cmd === 'rebuild') && projectId) {
                          const baseUrl = getPreviewUrl(projectId);
                          setPreviewUrl(buildPreviewNavigationUrl(baseUrl, previewPath || '/', true));
                          setLatestPreviewUrl(baseUrl);
                          transitionPreviewStatus('building', { message: 'Refreshing preview…' });
                        }
                      }}
                      onUsage={(_tokensUsed) => {}}
                      onAgentStreamText={handleAgentStreamText}
                      onAgentStreamClear={handleAgentStreamClear}
                    />
                  )}
                </div>
              </div>
            </SheetContent>
          </Sheet>

          {/* Legacy pop-over Agent Button removed */}
        </>
      )}

      {/* Right Sidebar - Agent / Prompt */}
      {!isMobileViewport && <div
        ref={chatPanelRef}
        className={cn(
          'order-1 flex-shrink-0 flex flex-col relative animate-panel-enter',
          'fixed lg:relative inset-y-0 left-0 lg:inset-auto lg:left-auto z-40 lg:z-auto',
          isMinimized ? 'w-14' : ''
        )}
        style={!isMinimized ? { width: chatWidth, background: 'linear-gradient(180deg, #0f0f12 0%, #0c0c0e 100%)' } : undefined}
      >
        {/* Drag-to-resize handle */}
        {!isMinimized && (
          <div
            onPointerDown={startChatResize}
            style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, zIndex: 50, cursor: 'col-resize', touchAction: 'none' }}
            className="group"
          >
            <div style={{ position: 'absolute', left: 2, top: 0, bottom: 0, width: 2 }}
              className="bg-white/[0.06] group-hover:bg-indigo-500/60 transition-colors duration-150" />
          </div>
        )}
        {/* Header */}
        <div className="h-10 flex items-center justify-between px-3 bg-[#131315]/60 backdrop-blur-xl border-b border-white/[0.04] relative z-[100]">
          {!isMinimized && (
            <>
              {isEditingProjectName ? (
                <div className="flex items-center gap-1.5 flex-1">
                  <Input
                    value={editProjectName}
                    onChange={(e) => setEditProjectName(e.target.value)}
                    className="font-medium h-7 text-xs bg-white/5 border-white/[0.06] text-white rounded-md"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdateProjectName();
                      if (e.key === 'Escape') {
                        setIsEditingProjectName(false);
                        setEditProjectName(project?.name || '');
                      }
                    }}
                  />
                  <Button size="sm" onClick={handleUpdateProjectName} disabled={updatingProjectName}
                    className="h-6 text-[11px] px-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md">
                    {updatingProjectName ? '…' : 'Save'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setIsEditingProjectName(false); setEditProjectName(project?.name || ''); }}
                    className="h-6 text-[11px] px-2 text-white/40 hover:text-white">
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 min-w-0">
                  <button onClick={() => navigate('/dashboard/projects')} className="flex items-center group">
                    <img src={ecgLogo} alt="eCG" className="h-4 w-auto object-contain group-hover:opacity-60 transition-opacity" />
                  </button>
                  <div className="h-3 w-px bg-white/[0.08]" />
                  <button onClick={() => setIsEditingProjectName(true)} className="flex items-center gap-1 min-w-0 group">
                    <span className="text-[12px] font-medium text-white/70 truncate max-w-[150px] group-hover:text-white transition-colors" title={project?.name || ""}>
                      {project?.name || "Loading..."}
                    </span>
                    <Edit className="h-2.5 w-2.5 text-white/15 group-hover:text-white/40 transition-colors flex-shrink-0" />
                  </button>
                </div>
              )}
              <div className="flex gap-0.5">
                <Button variant="ghost" size="icon" onClick={() => setIsMinimized(!isMinimized)}
                  className="h-7 w-7 text-white/25 hover:text-white/70 hover:bg-white/[0.06] rounded-md">
                  <Minimize2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </>
          )}
          {isMinimized && (
            <Button variant="ghost" size="icon" onClick={() => setIsMinimized(false)} className="mx-auto h-9 w-9 text-white/40 hover:text-white/80 hover:bg-white/[0.06] rounded-lg">
              <Bot className="h-4.5 w-4.5" />
            </Button>
          )}
        </div>

        {/* New Agent Chat Panel */}
        {!isMinimized && projectId && (currentUser || isGuest) && activeBuilderTab !== 'revisions' && (
          <div className="flex-1 overflow-hidden">
            {isGuest && (
              <div className="mx-3 mt-3 mb-1 rounded-lg bg-cyan-500/[0.06] px-3 py-2.5 text-xs text-cyan-200/80">
                <span className="font-medium text-cyan-200">Guest</span> — Gemini &middot; {(() => {
                  const used = parseInt(localStorage.getItem('ecg_guest_requests') || '0', 10);
                  return Math.max(0, 3 - used);
                })()} of 3 left &middot;{' '}
                <button onClick={() => navigate('/auth')} className="underline text-cyan-300/80 hover:text-white transition-colors">
                  Sign up
                </button>
              </div>
            )}
            <AgentChatPanel
                            currentOrganizationId={currentOrganizationId}
              projectId={projectId}
              userId={currentUser?.id || `guest:${guestFingerprint || 'anonymous'}`}
              isMinimized={isMinimized}
              triggerPrompt={repairPrompt}
              onTriggerConsumed={() => {
                setRepairPrompt(null);
                isAgentRunningRef.current = true;
              }}
              onFilesGenerated={(files, filesToDelete, previewPushed) => {
                // Only normalize when there are actual writes — normalizeProjectFiles([])
                // injects boilerplate that would corrupt the workspace on delete-only runs.
                const normalizedFiles = files.length > 0
                  ? normalizeProjectFiles(files.map(f => ({ path: f.path, content: f.content })))
                  : [];
                const deletedSet = new Set((filesToDelete ?? []).map(p => p.replace(/^\//, '')));
                // Set the generated files
                if (normalizedFiles.length > 0) {
                  setGeneratedFiles(normalizedFiles as any[]);
                  // Optionally find an HTML file
                  const htmlFile = normalizedFiles.find(f => f.path === 'index.html' || f.path.endsWith('.html')) || normalizedFiles[0];
                  if (htmlFile) {
                    setGeneratedCode(htmlFile.content);
                  }
                }
                // Remove deleted files from workspace BEFORE writing new ones
                deletedSet.forEach((deletedPath) => {
                  deleteFileWorkspace(deletedPath, 'ai');
                });
                // Sync new/updated files to workspace
                normalizedFiles.forEach((file) => {
                  writeFileWorkspace(file.path, file.content, 'ai');
                });
                // Save immediately after agent generation — do NOT rely on the debounced
                // scheduleWorkspaceSave (1 s delay). If the user navigates away in under
                // 1 s the debounced save never fires and files are lost on next reload.
                saveWorkspaceToDb().catch((err) => {
                  console.error('[Editor] Failed to persist agent files:', err);
                  // Fall back to debounced save so at least something gets saved
                  scheduleWorkspaceSave();
                });

                // Detect new page files to auto-navigate after agent adds routes.
                // Compare against workspaceFiles (pre-agent state) to find truly new pages.
                // Start from current path but never use /home — agents commonly
                // generate a redirect from / to /home which gets stored as the
                // current route, then breaks every subsequent build that lacks /home.
                const rawTargetRoute = previewPathRef.current || '/';
                let targetRoute = (rawTargetRoute === '/home' || rawTargetRoute === 'home') ? '/' : rawTargetRoute;
                if (normalizedFiles.length > 0) {
                  const newPages = normalizedFiles.filter(f => {
                    if (!/^src\/pages\/[^/]+\.(tsx?|jsx?)$/.test(f.path)) return false;
                    const stripped = f.path.replace(/^\/+/, '');
                    return !workspaceFiles.has(stripped) && !workspaceFiles.has('/' + stripped);
                  });
                  const candidatePage = newPages.find(f => {
                    const name = f.path.replace(/^src\/pages\//, '').replace(/\.(tsx?|jsx?)$/, '');
                    return !/^(Home|Index|Landing|App|Main|Root|NotFound|404|Error)$/i.test(name);
                  });
                  if (candidatePage) {
                    const componentName = candidatePage.path
                      .replace(/^src\/pages\//, '')
                      .replace(/\.(tsx?|jsx?)$/, '');
                    let detectedRoute: string | null = null;
                    // Try to read the actual route from App.tsx in the agent's output
                    const appTsx = normalizedFiles.find(f =>
                      f.path === 'src/App.tsx' || f.path === '/src/App.tsx'
                    );
                    if (appTsx) {
                      // Match <Route path="..." element={<ComponentName or element={<ComponentName ... path="..."}
                      const re = new RegExp(
                        `path=["']([^"'*:][^"']*?)["'][^<>]*?element=\\{[^}]*<\\s*${componentName}|` +
                        `element=\\{[^}]*<\\s*${componentName}[^>]*?path=["']([^"'*:][^"']*?)["']`,
                        'i'
                      );
                      const m = re.exec(appTsx.content);
                      if (m) {
                        const r = (m[1] || m[2] || '').trim();
                        if (r && r !== '/') detectedRoute = r;
                      }
                    }
                    if (!detectedRoute) {
                      // Derive from filename: ServicesPage.tsx -> /services
                      const base = componentName.replace(/Page$/i, '');
                      detectedRoute = '/' + base
                        .replace(/([A-Z])/g, (c, i) => (i ? '-' : '') + c.toLowerCase())
                        .replace(/^-/, '');
                    }
                    if (detectedRoute && detectedRoute !== '/') {
                      targetRoute = detectedRoute;
                      console.log(`[Editor] New page detected (${componentName}) — navigating to ${targetRoute}`);
                    }
                  }

                  // Safety: validate targetRoute exists in the new App.tsx.
                  // If it doesn't appear as a registered route, fall back to '/'
                  // to avoid navigating to a 404 that triggers the blank-page repair loop.
                  if (targetRoute !== '/') {
                    const appTsx = normalizedFiles.find(f =>
                      f.path === 'src/App.tsx' || f.path === '/src/App.tsx'
                    );
                    if (appTsx) {
                      const routePattern = new RegExp(`path=["']${targetRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
                      if (!routePattern.test(appTsx.content)) {
                        console.log(`[Editor] targetRoute ${targetRoute} not found in App.tsx — falling back to /`);
                        targetRoute = '/';
                      }
                    }
                  }
                }

                if (previewPushed) {
                  // Agent server already pushed files to preview service — just refresh the iframe.
                  // Skipping buildPreviewNow avoids the duplicate push that can cause 422 rejections.
                  console.log('[Editor] Server already pushed preview — refreshing iframe');
                  const baseUrl = getPreviewUrl(projectId!);
                  setPreviewUrl(buildPreviewNavigationUrl(baseUrl, targetRoute, true));
                  setLatestPreviewUrl(baseUrl);
                  lastSuccessfulPreviewFilesRef.current = new Map(
                    normalizedFiles.map((f: { path: string; content: string }) => [f.path.replace(/^\//, ''), { path: f.path, content: f.content }])
                  );
                  transitionPreviewStatus('ready', { message: 'Preview Ready' });
                } else {
                  // Build preview with a merged snapshot to avoid the stale-state race:
                  // writeFileWorkspace schedules async React state updates, so workspaceFiles
                  // inside buildPreviewNow would still be the OLD map if called synchronously.
                  const merged = new Map(
                    Array.from(workspaceFiles.values())
                      .filter(f => !deletedSet.has(f.path.replace(/^\//, '')))
                      .map(f => [f.path, { path: f.path, content: f.content }])
                  );
                  normalizedFiles.forEach(f => merged.set(f.path, f));
                  buildPreviewNow(Array.from(merged.values()), targetRoute).catch((error) => {
                    console.error('[Editor] Preview sync failed after generation:', error);
                  });
                }

                // Track whether agent wrote files (for eco charging)
                lastAgentEcoRef.current = normalizedFiles.length > 0 ? 1 : 0;
              }}
              onGenerationComplete={() => {
                // Agent finished — clear running flag.
                // Only reset the repair counter when this was a USER-initiated generation.
                // If it was an auto-repair run, preserve the counter so the MAX limit
                // actually works — resetting after every repair is what caused the infinite loop.
                isAgentRunningRef.current = false;
                if (!pendingAutoRepairRef.current) {
                  consecutiveRepairsRef.current = 0;
                }
                pendingAutoRepairRef.current = false;
                // Only switch to preview tab if a preview URL exists (i.e. files were
                // actually built). If the agent returned a conversational response with
                // no file writes, previewUrlRef.current is null and we stay on chat.
                if (document.visibilityState === 'visible' && previewUrlRef.current) {
                  setActiveBuilderTab('preview');
                }
                // Eco is now pre-deducted in AgentChatPanel.handleSubmit (1 eco before start).
                // Just refresh the usage display so the counter stays in sync.
                if (!isGuest) {
                  refreshUsage().catch((err) =>
                    console.error('[Editor] Error refreshing usage:', err)
                  );
                }
              }}
              onPreviewCommand={(cmd) => {
                if ((cmd === 'restart' || cmd === 'refresh' || cmd === 'rebuild') && projectId) {
                  const baseUrl = getPreviewUrl(projectId);
                  setPreviewUrl(buildPreviewNavigationUrl(baseUrl, previewPath || '/', true));
                  setLatestPreviewUrl(baseUrl);
                  transitionPreviewStatus('building', { message: 'Refreshing preview…' });
                }
              }}
              onUsage={(_tokensUsed) => {
                // Eco is optimistically applied in AgentChatPanel.handleSubmit (1 eco per request).
                // tokensUsed here is raw LLM token count — not eco units.
              }}
              onAgentStreamText={handleAgentStreamText}
              onAgentStreamClear={handleAgentStreamClear}
            />
          </div>
        )}

        {/* Revisions Panel - Always visible at bottom */}
        {!isMinimized && projectId && currentUser && activeBuilderTab === 'revisions' && (
          <RevisionPanel
            projectId={projectId}
            onRevisionSelect={handleRevisionSelect}
            currentUserId={currentUser.id}
          />
        )}
      </div>}

      <QuotaLimitDialog
        open={showQuotaLimitDialog}
        onOpenChange={setShowQuotaLimitDialog}
        resetAt={quotaResetAt}
        onAutoRetry={async () => {
          const allowed = await ensureWithinLimit();
          if (allowed) {
            toast.success('Quota reset detected. You can continue now.');
          }
          return allowed;
        }}
        onUpgrade={() => {
          setShowQuotaLimitDialog(false);
          window.location.href = '/dashboard/settings?section=workspace-plans';
        }}
      />

      {/* Main Workspace - Preview / Code */}
      <div className="order-2 flex-1 min-w-0 flex flex-col bg-[#09090b]">
        {/* Preview Header */}
        <div className="h-10 flex items-center justify-between px-3 bg-[#131315]/60 backdrop-blur-xl border-b border-white/[0.04] relative z-10">
          <div className="flex gap-2 items-center min-w-0">
            <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
              {visibleBuilderTabs.map((tab) => (
                <Button
                  key={tab}
                  variant={activeBuilderTab === tab ? "default" : "ghost"}
                  size="sm"
                  className={cn(
                    "h-7 px-2 text-[11px] capitalize whitespace-nowrap rounded-md",
                    activeBuilderTab === tab
                      ? "bg-white/[0.08] text-white"
                      : "text-white/35 hover:text-white/70 hover:bg-white/[0.04]"
                  )}
                  onClick={() => {
                    if (tab === 'publish') {
                      if (isGuest) {
                        toast.error("Sign up to publish your site");
                        return;
                      }
                      if (!currentOrganizationId) {
                        toast.error("Join or create an organization to publish your site");
                        return;
                      }
                      setShowPublishDialog(true);
                    }
                    if (tab === 'generate' || tab === 'brief' || tab === 'revisions') {
                      setIsMinimized(false);
                    }
                    if (tab === 'preview') {
                      setShowCodeViewer(false);
                    }
                    if (tab === 'code') {
                      setShowCodeViewer(true);
                    }
                    setActiveBuilderTab(tab);
                  }}
                >
                  {tab}
                </Button>
              ))}

            </div>

            <>
              {showExpandButton && (
                <Button
                  onClick={handleExpandToComplete}
                  disabled={isLoading}
                  className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg rounded-lg"
                >
                  {isLoading ? "Expanding..." : "Expand to Full App"}
                </Button>
              )}
              {/* Viewport toggles */}
              <div className="flex gap-0.5 rounded-md bg-white/[0.04] p-0.5">
                <Button variant="ghost" size="icon" disabled={!canUsePreviewViewport}
                  onClick={() => { setViewMode("desktop"); setShowCodeViewer(false); }}
                  className={cn("h-6 w-6 rounded-sm", viewMode === "desktop" ? "bg-white/[0.1] text-white" : "text-white/25 hover:text-white/70 disabled:text-white/10 disabled:hover:bg-transparent")}>
                  <Monitor className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" disabled={!canUsePreviewViewport}
                  onClick={() => { setViewMode("tablet"); setShowCodeViewer(false); }}
                  className={cn("h-6 w-6 rounded-sm", viewMode === "tablet" ? "bg-white/[0.1] text-white" : "text-white/25 hover:text-white/70 disabled:text-white/10 disabled:hover:bg-transparent")}>
                  <Tablet className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" disabled={!canUsePreviewViewport}
                  onClick={() => { setViewMode("mobile"); setShowCodeViewer(false); }}
                  className={cn("h-6 w-6 rounded-sm", viewMode === "mobile" ? "bg-white/[0.1] text-white" : "text-white/25 hover:text-white/70 disabled:text-white/10 disabled:hover:bg-transparent")}>
                  <Smartphone className="h-3 w-3" />
                </Button>
              </div>
              <div className="h-3 w-px bg-white/[0.06]" />
              <Button variant="ghost" size="icon" disabled={!canToggleCodeViewer}
                onClick={() => { const next = !showCodeViewer; setShowCodeViewer(next); setActiveBuilderTab(next ? 'code' : 'preview'); }}
                title={showCodeViewer ? "View Preview" : "View Source Code"}
                className={cn("h-7 w-7 rounded-md", showCodeViewer ? "bg-white/[0.1] text-white" : "text-white/25 hover:text-white/70 hover:bg-white/[0.06] disabled:text-white/10 disabled:hover:bg-transparent")}>
                <FileCode className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" disabled={showCodeViewer}
                onClick={() => setInspectMode(!inspectMode)}
                title={inspectMode ? "Exit inspect mode" : "Inspect — click an element in the preview to scope your next prompt"}
                className={cn("h-7 w-7 rounded-md", inspectMode ? "bg-indigo-500/20 text-indigo-300" : "text-white/25 hover:text-white/70 hover:bg-white/[0.06] disabled:text-white/10 disabled:hover:bg-transparent")}>
                <MousePointerClick className="h-3.5 w-3.5" />
              </Button>
              {inspectTarget && (
                <span className="hidden lg:flex items-center gap-1 h-7 px-2 rounded-md bg-indigo-500/10 text-[11px] text-indigo-300 whitespace-nowrap">
                  Editing <code className="font-mono text-indigo-200">{inspectTarget.tagName}</code>
                  <button onClick={() => setInspectTarget(null)} className="text-indigo-300/50 hover:text-white ml-0.5">×</button>
                </span>
              )}
            </>
          </div>

          <TooltipProvider>
            <div className="flex gap-1 items-center">
              <div className="hidden md:flex items-center rounded-md bg-white/[0.04] px-2 py-0.5 text-[10px] gap-1">
                <span className="text-white/25">Eco</span>
                <span className={cn("font-medium tabular-nums", getUsagePercentage() >= 80 ? 'text-amber-400' : 'text-emerald-400/70')}>
                  {(usageRecord?.ai_gens_used ?? 0)}/{getUsageLimit()}
                </span>
              </div>

              {(tier === 'free' || tier === 'starter') && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => openSettings('workspace-plans')}
                      className="flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium text-white/60 hover:text-white/90 border border-white/[0.10] hover:border-white/[0.22] bg-white/[0.03] hover:bg-white/[0.06] transition-colors duration-6000 animate-border-flash"
                    >
                      {tier === 'free' ? 'Upgrade' : 'Go Pro'}
                      <ArrowUpRight className="h-3 w-3 opacity-60" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="z-[300] max-w-[180px] text-center">
                    <p>{tier === 'free' ? 'Unlock custom domains, more AI gens & export code' : 'Unlock unlimited projects & custom domains'}</p>
                  </TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={() => openSettings()}
                    className="h-7 w-7 rounded-md text-white/25 hover:text-white/70 hover:bg-white/[0.06]">
                    <Settings className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[300]"><p>Settings</p></TooltipContent>
              </Tooltip>

              {canRenderProjectActions && (
                <Popover
                  open={githubPopoverOpen}
                  onOpenChange={(next) => { if (githubStatus?.connected) setGithubPopoverOpen(next); }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon"
                          onClick={() => { if (!githubStatus?.connected) openSettings('project-integrations'); }}
                          className="h-7 w-7 rounded-md text-white/25 hover:text-white/70 hover:bg-white/[0.06]">
                          <Github className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent className="z-[300]"><p>{githubStatus?.connected ? 'GitHub' : 'Connect GitHub'}</p></TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-64 z-[300] p-3 space-y-2">
                    <p className="text-[11px] text-white/45">
                      Connected as <strong className="text-white/80">{githubStatus?.login}</strong>
                    </p>
                    {githubLink ? (
                      <a href={`https://github.com/${githubLink.fullName}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[12px] text-indigo-400 hover:text-indigo-300">
                        <ExternalLink className="h-3 w-3" />
                        {githubLink.fullName} ({githubLink.branch})
                      </a>
                    ) : (
                      <p className="text-[11px] text-white/45">No repository linked yet.</p>
                    )}
                    <Button size="sm" variant="outline" onClick={() => { setGithubPopoverOpen(false); openSettings('project-integrations'); }}
                      className="h-7 w-full text-[11px]">
                      Manage
                    </Button>
                  </PopoverContent>
                </Popover>
              )}

              {canRenderProjectActions && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={() => openSettings('ecomgear-database')}
                      className="h-7 w-7 flex items-center justify-center rounded-md text-orange-400/60 hover:text-orange-400 hover:bg-orange-500/10 transition-colors">
                      <Database className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="z-[300]"><p>ECG CLAUDE DB &amp; REST API</p></TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowVersionHistory(true)}
                    className="h-7 w-7 flex items-center justify-center rounded-md text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors">
                    <History className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="z-[300]"><p>Version history</p></TooltipContent>
              </Tooltip>

              {/* Legacy Agent Menu trigger removed */}

              {canRenderProjectActions && (
                /* ── Single Publish button → popover panel ── */
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      disabled={isPublishing || !isVersionPublishable}
                      className="flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPublishing ? (
                        <RotateCcw className="h-3 w-3 animate-spin shrink-0" />
                      ) : isAlreadyPublished ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse shrink-0" />
                      ) : (
                        <Globe className="h-3 w-3 shrink-0" />
                      )}
                      {isPublishing ? (isAlreadyPublished ? 'Updating…' : 'Publishing…') : 'Publish'}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={8}
                    className="w-80 p-0 bg-[#111116] border border-white/[0.1] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden"
                  >
                    {isAlreadyPublished ? (() => {
                      // Resolve all connected domains
                      const subdomainUrl = project?.published_subdomain
                        ? `https://${project.published_subdomain}.ecomgear.app`
                        : null;
                      const rawCustom = dbCustomDomain || customDomain ||
                        (project?.published_url && !project.published_url.includes('ecomgear.app')
                          ? project.published_url.replace(/^https?:\/\//, '') : null);
                      const customDomainUrl = rawCustom
                        ? (rawCustom.startsWith('http') ? rawCustom : `https://${rawCustom}`)
                        : null;
                      // Primary URL: custom domain preferred, then project URL, then subdomain
                      const primaryUrl = customDomainUrl || project?.published_url || publishedUrl || subdomainUrl || '';
                      const primaryDisplay = primaryUrl.replace(/^https?:\/\//, '');
                      // Count all active domains
                      const activeDomains = [subdomainUrl, customDomainUrl].filter(Boolean) as string[];
                      const domainCount = activeDomains.length;
                      return (
                        <div className="flex flex-col">
                          {/* Header */}
                          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/[0.06]">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                              <span className="text-sm font-semibold text-white">Published</span>
                            </div>
                          </div>
                          {/* URL section */}
                          <div className="px-4 pt-3 pb-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs text-white/40 font-medium">Website URL</span>
                              <button
                                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
                                onClick={() => openSettings('project-domains')}
                              >
                                <Link className="h-3 w-3" />
                                {domainCount > 1
                                  ? `Manage ${domainCount} domains`
                                  : canUseCustomDomain ? 'Add domain' : 'Manage'}
                              </button>
                            </div>
                            {/* Primary URL */}
                            <div className="flex items-center gap-2 bg-black/30 rounded-lg px-3 py-2 border border-white/[0.06]">
                              <span className="flex-1 text-sm text-white/80 font-mono truncate">{primaryDisplay || 'ecomgear.app'}</span>
                              <button
                                className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                                title="Copy URL"
                                onClick={() => { navigator.clipboard.writeText(primaryUrl); toast.success('URL copied'); }}
                              >
                                <Copy className="h-3.5 w-3.5 text-white/40 hover:text-white/70" />
                              </button>
                              <button
                                className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
                                title="Open site"
                                onClick={() => window.open(primaryUrl, '_blank')}
                              >
                                <ExternalLink className="h-3.5 w-3.5 text-white/40 hover:text-white/70" />
                              </button>
                            </div>
                            {/* Secondary URL (ecomgear subdomain when custom domain is primary) */}
                            {customDomainUrl && subdomainUrl && (
                              <div className="flex items-center gap-2 mt-1.5 bg-black/20 rounded-lg px-3 py-1.5 border border-white/[0.04]">
                                <Globe className="h-3 w-3 text-white/20 shrink-0" />
                                <span className="flex-1 text-xs text-white/35 font-mono truncate">{subdomainUrl.replace(/^https?:\/\//, '')}</span>
                                <button
                                  className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
                                  title="Copy subdomain URL"
                                  onClick={() => { navigator.clipboard.writeText(subdomainUrl); toast.success('URL copied'); }}
                                >
                                  <Copy className="h-3 w-3 text-white/25 hover:text-white/50" />
                                </button>
                              </div>
                            )}
                          </div>
                          {/* Visibility section */}
                          <div className="px-4 pb-3 border-b border-white/[0.06]">
                            <p className="text-xs text-white/40 font-medium mb-2">Who can see this website</p>
                            <div className="flex items-center gap-3">
                              <div className="h-8 w-8 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                                <Globe className="h-4 w-4 text-white/50" />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-white/90">Public</p>
                                <p className="text-xs text-white/40">Anyone with the URL</p>
                              </div>
                            </div>
                          </div>
                          {/* Actions row */}
                          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
                            <button
                              className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-white/70 hover:text-white text-xs font-medium transition-colors border border-white/[0.06]"
                              onClick={() => window.open(primaryUrl, '_blank')}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              Open site
                            </button>
                            <button
                              className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-white/70 hover:text-white text-xs font-medium transition-colors border border-white/[0.06]"
                              onClick={() => {
                                setPublishMode('subdomain');
                                setActiveBuilderTab('publish');
                                setShowPublishDialog(true);
                              }}
                            >
                              <Settings className="h-3.5 w-3.5" />
                              Edit settings
                            </button>
                          </div>
                          {/* SEO row */}
                          <div className="px-4 py-2 border-b border-white/[0.06]">
                            <button
                              className="w-full flex items-center gap-2 h-8 rounded-lg px-2 hover:bg-white/[0.06] text-white/50 hover:text-white/80 text-xs font-medium transition-colors"
                              onClick={() => openSettings('project-seo')}
                            >
                              <Search className="h-3.5 w-3.5 shrink-0" />
                              SEO &amp; Search settings
                            </button>
                          </div>
                          {/* Database row */}
                          <div className="px-4 py-2 border-b border-white/[0.06]">
                            <button
                              className="w-full flex items-center gap-2 h-8 rounded-lg px-2 hover:bg-white/[0.06] text-white/50 hover:text-white/80 text-xs font-medium transition-colors"
                              onClick={() => openSettings('ecomgear-database')}
                            >
                              <Cloud className="h-3.5 w-3.5 shrink-0 text-orange-400" />
                              <span className="flex-1 text-left">ECG CLAUDE DB</span>
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded leading-none">HOT</span>
                            </button>
                          </div>
                          {/* Update button */}
                          <div className="px-4 py-3">
                            <button
                              disabled={!isVersionPublishable || isPublishing}
                              className="w-full h-9 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                              onClick={() => {
                                if (!currentOrganizationId) { toast.error("Join or create an organization to publish your site"); return; }
                                if (!isVersionPublishable) return;
                                if (customDomainUrl) {
                                  handleUpdateCustomDomainSite();
                                } else if (project?.published_subdomain) {
                                  handleUpdateSite();
                                } else {
                                  handleUpdateCustomDomainSite();
                                }
                              }}
                            >
                              {isPublishing ? (
                                <><RotateCcw className="h-4 w-4 animate-spin" /> Updating…</>
                              ) : 'Update'}
                            </button>
                          </div>
                        </div>
                      );
                    })() : (
                      /* Not yet published */
                      <div className="flex flex-col">
                        {/* Header */}
                        <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
                          <h3 className="text-sm font-semibold text-white mb-0.5">Publish your site</h3>
                          <p className="text-xs text-white/40">Get your site live on the internet.</p>
                        </div>
                        {/* Domain option */}
                        <div className="px-4 py-3 border-b border-white/[0.06]">
                          <div className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                            <div className="h-8 w-8 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
                              <Globe className="h-4 w-4 text-indigo-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-white/70">ecomgear.app domain</p>
                              <p className="text-xs text-white/30 truncate">yourproject.ecomgear.app</p>
                            </div>
                          </div>
                          {canUseCustomDomain && (
                            <button
                              className="w-full mt-2 flex items-center gap-2 p-2.5 rounded-lg hover:bg-white/[0.04] text-xs text-white/40 hover:text-white/60 transition-colors"
                              onClick={() => openSettings('project-domains')}
                            >
                              <Link className="h-3.5 w-3.5 shrink-0" />
                              Connect a custom domain
                            </button>
                          )}
                        </div>
                        {/* SEO row */}
                        <div className="px-4 py-2 border-b border-white/[0.06]">
                          <button
                            className="w-full flex items-center gap-2 h-8 rounded-lg px-2 hover:bg-white/[0.06] text-white/50 hover:text-white/80 text-xs font-medium transition-colors"
                            onClick={() => openSettings('project-seo')}
                          >
                            <Search className="h-3.5 w-3.5 shrink-0" />
                            SEO &amp; Search settings
                          </button>
                        </div>
                        {/* Database row */}
                        <div className="px-4 py-2 border-b border-white/[0.06]">
                          <button
                            className="w-full flex items-center gap-2 h-8 rounded-lg px-2 hover:bg-white/[0.06] text-white/50 hover:text-white/80 text-xs font-medium transition-colors"
                            onClick={() => openSettings('ecomgear-database')}
                          >
                            <Cloud className="h-3.5 w-3.5 shrink-0 text-orange-400" />
                            <span className="flex-1 text-left">ECG CLAUDE DB</span>
                            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded leading-none">HOT</span>
                          </button>
                        </div>
                        {/* Publish button */}
                        <div className="px-4 py-3">
                          <button
                            disabled={!isVersionPublishable || isPublishing || !canPublishToEcomDomain}
                            className="w-full h-9 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                            onClick={() => {
                              if (!currentOrganizationId) { toast.error("Join or create an organization to publish your site"); return; }
                              if (!canPublishToEcomDomain) { toast.error(`Publishing is not available on ${tierLabel}. Upgrade your plan to publish.`); return; }
                              setPublishMode('subdomain');
                              setShowPublishDialog(true);
                            }}
                          >
                            {isPublishing ? (
                              <><RotateCcw className="h-4 w-4 animate-spin" /> Publishing…</>
                            ) : (
                              <><Globe className="h-4 w-4" /> Publish</>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </TooltipProvider>
        </div>

        {/* Main Content Area - Preview */}
        <div className="flex-1 min-h-0 bg-[#09090b] overflow-hidden relative flex">
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {activeBuilderTab === 'revisions' ? (
              <div className="flex-1 overflow-hidden p-4 sm:p-6">
                <div className="mb-4 rounded-xl bg-[#1c1b1d] p-4">
                  <p className="text-[10px] uppercase tracking-widest text-indigo-300/60">Revisions</p>
                  <h2 className="mt-1 text-base font-medium text-white/90">Version timeline</h2>
                  <p className="mt-1 text-xs text-white/30">
                    Browse past changes and restore a revision.
                  </p>
                </div>
                {projectId && currentUser ? (
                  <RevisionPanel
                    projectId={projectId}
                    onRevisionSelect={handleRevisionSelect}
                    currentUserId={currentUser.id}
                    mode="full"
                  />
                ) : (
                  <div className="rounded-xl bg-[#1c1b1d] p-6 text-sm text-white/30">
                    Revisions are available after project context is loaded.
                  </div>
                )}
              </div>
            ) : (
              <>

            {/* Route Navigator Address Bar */}
            {showRouteNavigator && (
            <div className="h-10 bg-[#0e0e10] flex items-center px-3 gap-1.5 flex-shrink-0">
              {/* Route Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-white/30 hover:text-white/70 hover:bg-white/[0.04] gap-1 px-2 rounded-md"
                    title="Select route"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <ChevronDown className="h-2.5 w-2.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-64 bg-[#1c1b1d] border-white/[0.06] text-white max-h-80 overflow-y-auto rounded-xl"
                >
                  <DropdownMenuLabel className="text-white/30 text-[10px] uppercase tracking-widest">
                    Routes ({detectedRoutes.length})
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-white/[0.06]" />
                  {detectedRoutes.map((route) => {
                    const routeName = typeof route.name === 'string' ? route.name : String(route.name);
                    const routePath = typeof route.path === 'string' ? route.path : String(route.path);

                    return (
                      <DropdownMenuItem
                        key={routePath}
                        className={`cursor-pointer hover:bg-white/[0.06] rounded-lg ${currentRoutePath === routePath ? 'bg-indigo-500/10 text-indigo-300' : ''}`}
                        onClick={() => {
                          setCurrentRoutePath(routePath);
                          if (projectId) {
                            // Construct new URL with route path using project base URL
                            const baseUrl = getPreviewUrl(projectId);
                            const newUrl = buildPreviewNavigationUrl(baseUrl, routePath);
                            setPreviewUrl(newUrl);
                          }
                        }}
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">{routeName}</span>
                          <span className="text-xs text-gray-500 font-mono">{routePath}</span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                  {detectedRoutes.length === 0 && (
                    <DropdownMenuItem disabled className="text-gray-500 text-sm">
                      No routes detected
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Editable URL Bar */}
              <div className="flex items-center gap-2 flex-1 bg-white/[0.03] rounded-full px-3 py-1 focus-within:bg-white/[0.05] transition-all">
                <Globe className="h-3.5 w-3.5 text-white/20 flex-shrink-0" />
                <input
                  type="text"
                  className="flex-1 bg-transparent border-none outline-none text-sm text-white/60 placeholder-white/20 font-mono min-w-0"
                  placeholder="/path"
                  value={currentRoutePath}
                  onChange={(e) => setCurrentRoutePath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && effectivePreviewUrl) {
                      const baseUrl = getPreviewUrl(projectId!);
                      const path = currentRoutePath.startsWith('/') ? currentRoutePath : '/' + currentRoutePath;
                      const newUrl = buildPreviewNavigationUrl(baseUrl, path);
                      setPreviewUrl(newUrl);
                      toast.success(`Navigating to ${path}`);
                    }
                  }}
                />
                {previewStatus === 'building' && <div className="w-3 h-3 border-2 border-indigo-400/60 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
              </div>

              {/* Refresh Button */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-white/20 hover:text-white/60 hover:bg-white/[0.04] rounded-md"
                onClick={() => {
                  if (!projectId) return;
                  // Always rebuild from the clean base URL so repeated clicks don't
                  // accumulate extra ?t=...&t=...&t=... params.
                  const baseUrl = getPreviewUrl(projectId);
                  setPreviewUrl(buildPreviewNavigationUrl(baseUrl, previewPathRef.current || '/', true));
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>


            </div>
            )}

            <div className={cn(
              "flex-1 overflow-hidden bg-[#09090b]",
              showCodeViewer ? "relative flex items-center justify-center" : ""
            )}>
              {!hasLoadedCode && !hasRenderablePreview && !isLoading ? (
                <div className="relative flex h-full items-center justify-center overflow-hidden">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.10),transparent_40%),radial-gradient(circle_at_bottom,rgba(168,85,247,0.08),transparent_35%)]" />
                  <div className="relative z-10 flex max-w-lg flex-col items-center justify-center px-8 text-center">
                    <video
                      src="/assets/loading.mp4"
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="mb-6 w-full max-w-xs rounded-xl border border-white/[0.06] object-cover shadow-[0_24px_80px_rgba(3,12,27,0.4)]"
                    />
                    <p className="text-sm text-white/40 leading-relaxed">
                      Describe what you want to build in the assistant
                    </p>
                  </div>
                </div>
              ) : showCodeViewer ? (
                <div className="w-full h-full bg-[#111113] border border-white/[0.06] rounded-xl overflow-hidden shadow-2xl">
                  <CodeEditorPanel
                    files={Array.from(workspaceFiles.values()).map(f => ({
                      path: f.path,
                      content: f.content,
                    }))}
                    onFileChange={(path, content) => {
                      writeFileWorkspace(path, content, 'user');

                      const nextFiles = new Map(workspaceFiles);
                      nextFiles.set(path, { path, content } as any);
                      setGeneratedFiles(Array.from(nextFiles.values()).map((file: any) => ({
                        path: file.path,
                        content: file.content,
                      })));

                      scheduleWorkspaceSave();
                      scheduleCodeEditorPreviewSync();
                    }}
                    onFileCreate={(path, content) => {
                      writeFileWorkspace(path, content, 'user');

                      const nextFiles = new Map(workspaceFiles);
                      nextFiles.set(path, { path, content } as any);
                      setGeneratedFiles(Array.from(nextFiles.values()).map((file: any) => ({
                        path: file.path,
                        content: file.content,
                      })));

                      scheduleWorkspaceSave();
                      scheduleCodeEditorPreviewSync();
                    }}
                    onFileDelete={(path) => {
                      deleteFileWorkspace(path, 'user');

                      const nextFiles = new Map(workspaceFiles);
                      nextFiles.delete(path);
                      setGeneratedFiles(Array.from(nextFiles.values()).map((file: any) => ({
                        path: file.path,
                        content: file.content,
                      })));

                      scheduleWorkspaceSave();
                      scheduleCodeEditorPreviewSync();
                    }}
                    onSave={() => {
                      scheduleWorkspaceSave();
                      buildPreviewNow().catch((error) => {
                        console.error('[Editor] Manual code editor sync failed:', error);
                      });
                    }}
                    readOnly={true}
                    canExport={canExportCode}
                    exportLockedReason="Code export is available on the Professional plan and above."
                    streamingText={agentStreamText}
                  />
                </div>
              ) : (
                <MultiDevicePreview
                  src={effectivePreviewUrl}
                  htmlContent={localPreviewHtml || (generatedFiles.length === 1 && generatedFiles[0]?.path === 'index.html' ? generatedCode : null)}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  onRefresh={() => buildPreviewNow()}
                  onOpenExternal={effectivePreviewUrl ? () => window.open(effectivePreviewUrl, '_blank') : undefined}
                  onPreviewFirstPaint={() => setPreviewFirstPaint(true)}
                  status={previewStatus}
                  currentPath={previewPath}
                  projectId={projectId ?? undefined}
                  inspectMode={inspectMode}
                  onInspectModeChange={setInspectMode}
                  onRepair={(errorSummary) => {
                    setRepairPrompt(errorSummary);
                    setIsMinimized(false);
                  }}
                />
              )}
            </div>

              </>
            )}
          </div>
        </div>

        {/* Publish Dialog */}
        <Dialog
          open={showPublishDialog}
          onOpenChange={(open) => {
            setShowPublishDialog(open);
            if (!open && activeBuilderTab === 'publish') {
              setActiveBuilderTab('preview');
            }
          }}
        >
          <DialogContent className="max-w-sm p-0 overflow-hidden" style={{ background: '#111318', borderColor: 'rgba(255,255,255,0.08)' }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <DialogTitle className="text-white text-base font-semibold">{publishedUrl || project?.published_url ? 'Update Site' : 'Publish'}</DialogTitle>
              <DialogDescription className="sr-only">Publish your project to a live URL.</DialogDescription>
              <a
                href="https://docs.ecomgear.app/publish"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10"/><path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4m0-4h.01"/></svg>
                Docs
              </a>
            </div>

            <div className="px-5 pb-5 space-y-3">
              {/* ── Subdomain URL block ── */}
              {publishMode === 'subdomain' && (
                <div>
                  <p className="text-xs text-gray-400 mb-2">Your website URL</p>

                  {/* URL field */}
                  {isEditingSlug ? (
                    <div className="rounded-lg border border-purple-500/50 bg-white/[0.04] overflow-hidden">
                      <div className="px-3 pt-2 text-[11px] text-gray-600 select-none font-mono">preview.ecomgear.app/p/</div>
                      <div className="flex items-center gap-2 px-3 pb-2.5">
                        <input
                          autoFocus
                          className="flex-1 bg-transparent text-sm text-white placeholder:text-gray-600 focus:outline-none font-mono"
                          placeholder="my-awesome-app"
                          value={publishSlug}
                          onChange={e => {
                            const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
                            setPublishSlug(v);
                          }}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="text-gray-500 hover:text-gray-200 transition-colors shrink-0"
                          title="Cancel"
                          onClick={() => {
                            setIsEditingSlug(false);
                            if (project?.published_subdomain) setPublishSlug(project.published_subdomain);
                          }}
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                        </button>
                      </div>
                      {/* Availability badge */}
                      {publishSlug.length >= 3 && (
                        <div className="px-3 pb-2 flex items-center gap-1.5 text-xs">
                          {slugChecking ? (
                            <span className="text-gray-500">Checking…</span>
                          ) : publishSlug === project?.published_subdomain ? (
                            <><span className="h-1.5 w-1.5 rounded-full bg-blue-400 inline-block"/><span className="text-blue-400">Current address</span></>
                          ) : slugAvailable === true ? (
                            <><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 inline-block"/><span className="text-emerald-400">Available</span></>
                          ) : slugAvailable === false ? (
                            <><span className="h-1.5 w-1.5 rounded-full bg-red-400 inline-block"/><span className="text-red-400">Already taken</span></>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 flex items-center gap-2 group">
                      <span className="flex-1 text-sm text-gray-200 font-mono truncate">
                        {publishSlug
                          ? <><span className="text-purple-300">{publishSlug}</span><span className="text-gray-500">.preview.ecomgear.app</span></>
                          : <span className="text-gray-600 italic">not set</span>
                        }
                      </span>
                      <button
                        type="button"
                        className="text-gray-600 hover:text-gray-200 transition-colors shrink-0"
                        title="Edit address"
                        onClick={() => setIsEditingSlug(true)}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6.5-6.5a2 2 0 012.828 2.828L11.828 13.828A4 4 0 019 15H8v-1a4 4 0 01.172-1.172z"/></svg>
                      </button>
                    </div>
                  )}

                  {/* Copy + Open row (only when published) */}
                  {publishedUrl && !isEditingSlug && (
                    <div className="flex gap-2 mt-2">
                      <button
                        type="button"
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-gray-400 hover:text-gray-200 transition-colors py-1.5"
                        onClick={() => { navigator.clipboard.writeText(publishedUrl); toast.success('URL copied'); }}
                      >
                        <Copy className="h-3 w-3" /> Copy URL
                      </button>
                      <button
                        type="button"
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-gray-400 hover:text-gray-200 transition-colors py-1.5"
                        onClick={() => window.open(publishedUrl, '_blank')}
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                        Open Site
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Custom domain section ── */}
              <div className="border-t border-white/[0.06] pt-3">
                {publishMode === 'subdomain' ? (
                  <button
                    type="button"
                    className={`w-full flex items-center gap-2 text-sm transition-colors ${canUseCustomDomain ? 'text-gray-400 hover:text-gray-200' : 'text-gray-600 cursor-default'}`}
                    onClick={() => canUseCustomDomain && setPublishMode('custom')}
                  >
                    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
                    <span>Add custom domain</span>
                    {!canUseCustomDomain && (
                      <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded px-1.5 py-0.5">
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                        Pro
                      </span>
                    )}
                  </button>
                ) : (
                  /* Custom domain mode — full DNS flow */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-gray-300">Custom domain</p>
                      <button
                        type="button"
                        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                        onClick={() => setPublishMode('subdomain')}
                      >
                        ← Back
                      </button>
                    </div>
                    <Input
                      value={customDomain}
                      onChange={(event) => { setCustomDomain(event.target.value); setCustomDomainActivated(false); }}
                      placeholder="example.com"
                      className="bg-white/5 border-white/10 text-white text-sm"
                    />
                    <p className="text-xs text-gray-600">Root domain or subdomain, e.g. example.com or app.example.com</p>

                    {customDomainConfig && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-3 text-xs">
                        <p className="text-amber-300 font-semibold flex items-center gap-1.5">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                          Add BOTH DNS records at your registrar
                        </p>
                        {customDomainConfig.a_record && (
                          <div className="space-y-1">
                            <p className="text-gray-400 font-medium">Record 1 — A record</p>
                            <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center bg-black/20 rounded p-2">
                              <span className="text-purple-300 font-mono">Type</span><span className="text-white font-mono">A</span><span/>
                              <span className="text-purple-300 font-mono">Host</span><span className="text-white font-mono break-all">{customDomainConfig.a_record.host}</span>
                              <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.a_record!.host); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                              <span className="text-purple-300 font-mono">Value</span><span className="text-white font-mono break-all">{customDomainConfig.a_record.value}</span>
                              <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.a_record!.value); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                            </div>
                          </div>
                        )}
                        {customDomainConfig.cname_record && (
                          <div className="space-y-1">
                            <p className="text-gray-400 font-medium">Record 1 — CNAME record</p>
                            <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center bg-black/20 rounded p-2">
                              <span className="text-purple-300 font-mono">Type</span><span className="text-white font-mono">CNAME</span><span/>
                              <span className="text-purple-300 font-mono">Host</span><span className="text-white font-mono break-all">{customDomainConfig.cname_record.host}</span>
                              <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.cname_record!.host); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                              <span className="text-purple-300 font-mono">Value</span><span className="text-white font-mono break-all">{customDomainConfig.cname_record.value}</span>
                              <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.cname_record!.value); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                            </div>
                          </div>
                        )}
                        <div className="space-y-1">
                          <p className="text-gray-400 font-medium">Record 2 — TXT verification</p>
                          <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center bg-black/20 rounded p-2">
                            <span className="text-purple-300 font-mono">Type</span><span className="text-white font-mono">TXT</span><span/>
                            <span className="text-purple-300 font-mono">Host</span>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-white font-mono break-all">{customDomainConfig.txt_record.host}</span>
                              <span className="text-gray-500 text-[10px]">Some registrars need: <span className="font-mono text-gray-400">{customDomainConfig.txt_record.host}.{normalizeDomain(customDomain)}</span></span>
                            </div>
                            <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.txt_record.host); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                            <span className="text-purple-300 font-mono">Value</span><span className="text-white font-mono break-all">{customDomainConfig.txt_record.value}</span>
                            <button onClick={() => { navigator.clipboard.writeText(customDomainConfig.txt_record.value); toast.success('Copied'); }} className="text-gray-400 hover:text-white transition-colors"><Copy className="h-3 w-3"/></button>
                          </div>
                        </div>
                        <p className="text-gray-500 text-[10px]">DNS changes can take up to 48 hours. After adding records, click "Check DNS" then "Verify & Go Live".</p>
                      </div>
                    )}

                    {dnsCheckResult && (
                      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2 text-xs">
                        <p className="text-gray-300 font-medium flex items-center justify-between">
                          <span>DNS check</span>
                          <span className="text-gray-500 text-[10px]">{dnsCheckResult.checkedAt}</span>
                        </p>
                        {(dnsCheckResult.aRecord || dnsCheckResult.cnameRecord) && (() => {
                          const rec = dnsCheckResult.aRecord ?? dnsCheckResult.cnameRecord!;
                          return (
                            <div className="flex items-start gap-2">
                              <span className={`mt-0.5 shrink-0 text-[10px] font-bold px-1 rounded ${rec.ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{rec.ok ? '✓' : '✗'}</span>
                              <div>
                                <span className="text-gray-300">{dnsCheckResult.aRecord ? 'A' : 'CNAME'} record</span>
                                {rec.ok ? <p className="text-emerald-400 text-[10px]">Pointing to {rec.found.join(', ')}</p>
                                  : <p className="text-red-400 text-[10px]">Expected: {rec.expected} — Found: {rec.found.join(', ') || 'nothing yet'}</p>}
                              </div>
                            </div>
                          );
                        })()}
                        {dnsCheckResult.txtRecord && (
                          <div className="flex items-start gap-2">
                            <span className={`mt-0.5 shrink-0 text-[10px] font-bold px-1 rounded ${dnsCheckResult.txtOk ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{dnsCheckResult.txtOk ? '✓' : '✗'}</span>
                            <div>
                              <span className="text-gray-300">TXT at <span className="font-mono text-gray-400">{dnsCheckResult.txtRecord.host}</span></span>
                              {dnsCheckResult.txtOk ? <p className="text-emerald-400 text-[10px]">Verified ✓</p>
                                : <p className="text-red-400 text-[10px]">Expected: <span className="font-mono">{dnsCheckResult.txtRecord.expected}</span> — Found: {dnsCheckResult.txtRecord.found.join(', ') || 'nothing yet'}</p>}
                            </div>
                          </div>
                        )}
                        {!dnsCheckResult.pointingOk && !dnsCheckResult.txtOk && (
                          <p className="text-amber-400 text-[10px]">Neither record found yet — DNS may still be propagating (up to 48h)</p>
                        )}
                      </div>
                    )}

                    {customDomainActivated && publishedUrl && (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
                        <p className="text-emerald-400 text-sm flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse inline-block"/>Custom domain is live
                        </p>
                        <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-300 underline break-all">{publishedUrl}</a>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="flex-1 border-white/10 text-gray-300 hover:bg-white/5" onClick={() => { navigator.clipboard.writeText(publishedUrl); toast.success('URL copied'); }}>Copy URL</Button>
                          <Button size="sm" className="flex-1 bg-purple-600 hover:bg-purple-700 text-white" onClick={() => window.open(publishedUrl, '_blank')}>Open Site</Button>
                        </div>
                      </div>
                    )}

                    <div className="grid gap-2">
                      <Button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40" disabled={isPublishing || isCheckingDns || !customDomain.trim() || !canUseCustomDomain} onClick={handlePrepareCustomDomain}>
                        Prepare DNS Setup
                      </Button>
                      <Button variant="outline" className="w-full border-white/20 text-white hover:bg-white/10 disabled:opacity-40" disabled={isCheckingDns || isPublishing || !customDomainConfig || !customDomain.trim()} onClick={handleCheckDnsOnly}>
                        {isCheckingDns ? <span className="flex items-center gap-2"><svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Checking DNS…</span> : 'Check DNS'}
                      </Button>
                      <Button className="w-full bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40" disabled={isPublishing || isCheckingDns || !customDomainConfig || !customDomain.trim() || !canUseCustomDomain} onClick={handleVerifyAndActivateCustomDomain}>
                        {isPublishing ? 'Deploying and verifying…' : 'Verify DNS and Go Live'}
                      </Button>
                      {customDomainActivated && (
                        <Button className="w-full bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40" disabled={isPublishing || isCheckingDns || !isVersionPublishable} onClick={handleUpdateCustomDomainSite}>
                          {isPublishing ? 'Updating production…' : 'Update Production Site'}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Primary CTA (subdomain mode only) ── */}
              {publishMode === 'subdomain' && (
                <div className="space-y-2 pt-1">
                  {!isVersionPublishable && (
                    <p className="text-xs text-amber-400/80 text-center">
                      {previewStatus === 'building' ? 'Preview is still building…' : 'Preview must be ready before publishing.'}
                    </p>
                  )}
                  <Button
                    className="w-full bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40"
                    disabled={
                      !publishSlug ||
                      (slugAvailable !== true && publishSlug !== project?.published_subdomain) ||
                      isPublishing ||
                      !isVersionPublishable
                    }
                    onClick={() => {
                      if (publishedUrl && publishSlug === project?.published_subdomain) {
                        handleUpdateSite();
                      } else {
                        setIsEditingSlug(false);
                        handlePublishToSubdomain();
                      }
                    }}
                  >
                    {isPublishing ? (
                      <span className="flex items-center gap-2">
                        <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                        {publishSlug === project?.published_subdomain ? 'Updating…' : 'Building & deploying…'}
                      </span>
                    ) : (
                      publishedUrl && publishSlug === project?.published_subdomain ? 'Update Site' : 'Publish'
                    )}
                  </Button>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Cloud Dialog */}
        <Dialog open={showCloudDialog} onOpenChange={setShowCloudDialog}>
          <DialogContent className="max-w-2xl bg-slate-900 text-white border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-3xl font-bold">eCOMGear Cloud</DialogTitle>
              <DialogDescription className="sr-only">
                Review regional cloud application options for China and Hong Kong services.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-8 py-6">
              {/* China Section */}
              <div>
                <h3 className="text-2xl font-bold mb-4">China</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-xl">.cn ICP</span>
                    <Button
                      variant="outline"
                      className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                      onClick={() => {
                        setShowCloudDialog(false);
                        openSettings('china-icp');
                      }}
                    >
                      APPLY
                    </Button>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-xl">Wechat Auth.</span>
                    <Button
                      variant="outline"
                      className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                      onClick={() => toast.info('Wechat Auth application coming soon')}
                    >
                      APPLY
                    </Button>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-xl">QQ Auth.</span>
                    <Button
                      variant="outline"
                      className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                      onClick={() => toast.info('QQ Auth application coming soon')}
                    >
                      APPLY
                    </Button>
                  </div>
                </div>
              </div>

              {/* Hong Kong Section */}
              <div>
                <h3 className="text-2xl font-bold mb-4">Hong Kong</h3>
                <div className="flex items-center justify-between py-2">
                  <span className="text-xl">iAM Smart</span>
                  <Button
                    variant="outline"
                    className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                    onClick={() => toast.info('iAM Smart application coming soon')}
                  >
                    APPLY
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Settings Dialog — opens in-place so the editor/preview stay mounted */}
        {projectId && (
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            defaultSection={settingsSection}
            projectId={projectId}
            workspaceFiles={Array.from(workspaceFiles.values())}
          />
        )}

        {/* Version History Panel — plain fixed overlay, no Radix Dialog */}
        {showVersionHistory && (
          <>
            <div
              className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm"
              onClick={() => setShowVersionHistory(false)}
            />
            <div className="fixed inset-y-0 right-0 z-[201] w-[400px] sm:w-[480px] bg-[#0c0c0e] border-l border-white/[0.08] flex flex-col shadow-2xl">
              <VersionHistoryPanel
                projectId={projectId ?? ''}
                onClose={() => setShowVersionHistory(false)}
                onRestored={() => {
                  setShowVersionHistory(false);
                  window.dispatchEvent(new CustomEvent('preview:refresh'));
                }}
              />
            </div>
          </>
        )}

      </div>
    </div>
  );
};
export default Editor;