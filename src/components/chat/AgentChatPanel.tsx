import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, StopCircle, ChevronDown, Zap, Paperclip, X, FileText, Image as ImageIcon, RotateCcw, Sparkles, Bot, ClipboardList } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { streamAgentGeneration } from '@/eCG/UserPrompt/agentStreamService';
import type { StepFinishData } from '@/eCG/UserPrompt/agentStreamService';
import { ChatMessage } from '@/components/ChatMessage';
import { getGenServerUrl, getGenServerCandidateUrls } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';
import { messageService } from '@/eCG/UserPrompt/messageService';
import { uploadChatAttachment, isAllowedFile, formatFileSize, type ChatAttachment } from '@/services/chatAttachmentService';
import { useUsage } from '@/contexts/UsageContext';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolActivity {
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency' | 'command';
  label: string;
}

/** A file being actively written/edited during streaming */
interface LiveFileChange {
  path: string;
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency';
  timestamp: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  isPlan?: boolean;
  summary?: string;
  toolActivities?: ToolActivity[];
  attachments?: ChatAttachment[];
  /** Snapshot ID for rollback — present only on assistant messages after an agent run */
  snapshotId?: string;
  /** Commands the agent suggested (e.g. 'restart', 'refresh', 'rebuild') */
  suggestedCommands?: string[];
  /** AI-generated follow-up prompt chips shown after a build completes. null = loading */
  followUpSuggestions?: string[] | null;
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

// Extract and strip <ecomgear-chat-summary> from content
function extractSummary(content: string): { body: string; summary?: string } {
  const match = content.match(/<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/i);
  if (!match) return { body: content };
  return {
    body: content.replace(match[0], '').trim(),
    summary: match[1].trim(),
  };
}



// Parse all COMPLETED tool calls from raw agent output, deduplicating by path.
function parseToolActivities(raw: string): ToolActivity[] {
  // Use a Map keyed by label so later operations for the same file overwrite earlier ones.
  const seen = new Map<string, ToolActivity>();

  for (const m of raw.matchAll(/<ecomgear-write[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'write', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-edit[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'edit', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-delete[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'delete', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-rename[^>]*\bfrom="([^"]+)"[^>]*\bto="([^"]+)"/gi)) {
    const label = `${m[1]} → ${m[2]}`;
    seen.set(label, { type: 'rename', label });
  }

  for (const m of raw.matchAll(/<ecomgear-add-dependency[^>]*\bpackages="([^"]+)"/gi))
    seen.set(`dep:${m[1]}`, { type: 'dependency', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-command[^>]*\btype="([^"]+)"/gi))
    seen.set(`cmd:${m[1]}`, { type: 'command', label: m[1] });

  return Array.from(seen.values());
}

// Return a human-readable live status for the tool currently being streamed.
// Returns null when no tool is mid-flight.
function detectLiveTool(raw: string): string | null {
  // An open <ecomgear-write> that hasn't been closed yet means we're streaming file content.
  const open = raw.match(/<ecomgear-write[^>]*\bpath="([^"]+)"[^>]*>(?![\s\S]*?<\/ecomgear-write>)/i);
  if (open) return `Writing ${open[1]}…`;

  // Partial tag (agent is still typing the opening tag itself)
  if (/<ecomgear-/i.test(raw.replace(/<ecomgear-[\s\S]*?<\/ecomgear-\w+>/gi, '')
                              .replace(/<ecomgear-(?:rename|delete|add-dependency|command|file)[^>]*>/gi, ''))) {
    return 'Working…';
  }
  return null;
}

// Extract command types the agent suggested (e.g. restart, refresh, rebuild)
// Handles both <ecomgear-command> and abbreviated <egear-command> variants.
function parseCommandSuggestions(raw: string): string[] {
  const cmds: string[] = [];
  for (const m of raw.matchAll(/<(?:ecomgear|egear)-command[^>]*\btype="([^"]+)"/gi))
    if (!cmds.includes(m[1])) cmds.push(m[1]);
  return cmds;
}

/** @deprecated Replaced by Gemini-generated suggestions from /api/v1/ai/suggestions */
function generateFollowUpSuggestions(_filePaths: string[], _summaryText: string): string[] {
  // Use the summary as the primary signal — it describes exactly what changed.
  // File paths are used as fallback context when the summary is vague.
  const summary = summaryText.toLowerCase();
  const paths = filePaths.join(' ').toLowerCase();

  // Helper: test summary first, then paths
  const match = (...patterns: RegExp[]) => patterns.some(p => p.test(summary) || p.test(paths));

  // Ordered from most specific to least — first 3 matching suggestions win.
  const candidates: [RegExp[], string[]][] = [
    // Navigation / header / menu
    [
      [/navbar|nav\s*bar|navigation\s*bar|top\s*bar|header\s*with\s*(link|nav|menu)/],
      [
        'Make the navbar sticky so it stays visible on scroll',
        'Add a mobile hamburger menu that slides open',
        'Add a dropdown submenu to the navigation links',
      ],
    ],
    // Mobile menu / hamburger
    [
      [/hamburger|mobile\s*menu|responsive\s*nav|mobile\s*nav/],
      [
        'Add a smooth slide-in animation to the mobile menu',
        'Close the menu automatically when a link is clicked',
        'Add a backdrop/overlay behind the open mobile menu',
      ],
    ],
    // Hero section
    [
      [/hero\s*section|hero\s*banner|landing\s*hero|above.the.fold/],
      [
        'Add a background image or subtle animated gradient to the hero',
        'Add a scroll-down arrow that bounces at the bottom of the hero',
        'Add a secondary CTA button alongside the primary one',
      ],
    ],
    // Footer
    [
      [/footer\s*(section|component|with|added|created|built)/],
      [
        'Add a newsletter email signup field to the footer',
        'Add social media icon links (Twitter, LinkedIn, Instagram)',
        'Add a site map / quick links column to the footer',
      ],
    ],
    // Pricing / pricing table
    [
      [/pricing\s*(table|page|section|card|plan)|price\s*(table|plan|tier)/],
      [
        'Add a monthly / annual billing toggle to the pricing table',
        'Highlight the most popular plan with a badge',
        'Add a feature comparison table below the pricing cards',
      ],
    ],
    // Testimonials / reviews
    [
      [/testimonial|review\s*section|customer\s*review|star\s*rating|feedback\s*section/],
      [
        'Auto-rotate the testimonials as a carousel',
        'Add star ratings and an avatar photo to each testimonial',
        'Add a "Write a review" form below the testimonials',
      ],
    ],
    // FAQ section
    [
      [/faq|frequently\s*asked|accordion\s*(faq|section|component)/],
      [
        'Make the FAQ items expand/collapse with a smooth animation',
        'Add a search box above the FAQ to filter questions',
        'Group FAQ items into categories with tabs',
      ],
    ],
    // Contact form
    [
      [/contact\s*form|contact\s*page|get\s*in\s*touch\s*form|reach\s*out\s*form/],
      [
        'Add real-time validation that highlights empty required fields',
        'Show a success toast / confirmation message after submit',
        'Embed a Google Map next to the contact form',
      ],
    ],
    // Booking / appointment form
    [
      [/appointment\s*(form|page|booking)|booking\s*form|schedule\s*(form|page)|reservation\s*form/],
      [
        'Add a calendar date picker to let users choose a date',
        'Add time slot selection (morning / afternoon / evening)',
        'Show a confirmation summary screen before final submit',
      ],
    ],
    // Login / signup page
    [
      [/login\s*page|sign.?in\s*page|signup\s*page|registration\s*page|auth\s*page/],
      [
        'Add a "Forgot password?" link and reset flow',
        'Add Google / social login buttons',
        'Show a password strength indicator while typing',
      ],
    ],
    // User profile / account
    [
      [/profile\s*page|user\s*profile|account\s*page|my\s*account/],
      [
        'Add an avatar upload with image preview',
        'Add an editable bio / about section',
        'Add a recent activity or order history section',
      ],
    ],
    // Dashboard
    [
      [/dashboard\s*(page|layout|view|screen|component)/],
      [
        'Add summary stat cards at the top (total users, revenue, etc.)',
        'Add a date range picker to filter the dashboard data',
        'Add a sidebar navigation with collapse/expand toggle',
      ],
    ],
    // Charts / graphs
    [
      [/chart|graph|analytics\s*(chart|component)|bar\s*chart|line\s*chart|pie\s*chart/],
      [
        'Add a date range selector to filter the chart data',
        'Add a tooltip that shows exact values on hover',
        'Add a chart legend and toggle to show/hide data series',
      ],
    ],
    // Data table
    [
      [/data\s*table|list\s*table|table\s*(component|page|with\s*column)|sortable\s*table/],
      [
        'Add column sorting when the header is clicked',
        'Add a search / filter input above the table',
        'Add pagination controls at the bottom of the table',
      ],
    ],
    // Product listing / catalog
    [
      [/product\s*(listing|grid|catalog|page|card)|shop\s*page|store\s*page/],
      [
        'Add filter by category, price range, and rating',
        'Add a quick-view popup on product card hover',
        'Add a wishlist / save button on each product card',
      ],
    ],
    // Product detail page
    [
      [/product\s*detail|item\s*detail|product\s*page\s*with\s*(image|description|price)/],
      [
        'Add an image gallery with thumbnail carousel',
        'Add a quantity selector and "Add to cart" button',
        'Add a customer reviews section below the product info',
      ],
    ],
    // Shopping cart
    [
      [/shopping\s*cart|cart\s*page|cart\s*sidebar|cart\s*drawer/],
      [
        'Add a promo code / discount field to the cart',
        'Show estimated shipping cost in the cart summary',
        'Add a "You might also like" recommended products row',
      ],
    ],
    // Checkout
    [
      [/checkout\s*page|checkout\s*form|order\s*summary\s*page/],
      [
        'Add an order review step before payment confirmation',
        'Add address auto-complete to the shipping field',
        'Show a progress stepper (Cart → Shipping → Payment → Confirm)',
      ],
    ],
    // Blog / article listing
    [
      [/blog\s*(page|listing|grid|index)|article\s*listing|post\s*listing/],
      [
        'Add a search bar to filter blog posts by title',
        'Add category tags that filter posts when clicked',
        'Add pagination or a "Load more" button at the bottom',
      ],
    ],
    // Blog post / article detail
    [
      [/blog\s*post|article\s*page|post\s*detail|single\s*post/],
      [
        'Add a related posts section at the bottom of the article',
        'Add social share buttons (Twitter, LinkedIn, copy link)',
        'Add an estimated reading time badge near the title',
      ],
    ],
    // Gallery / portfolio grid
    [
      [/gallery|image\s*grid|photo\s*grid|portfolio\s*grid|masonry/],
      [
        'Add a lightbox that opens when an image is clicked',
        'Add category filter tabs above the gallery',
        'Add a lazy-load / skeleton while images are loading',
      ],
    ],
    // About page
    [
      [/about\s*(page|section|us\s*page)|company\s*about|team\s*section/],
      [
        'Add a team members section with photos and roles',
        'Add a company timeline / milestones section',
        'Add a mission statement and core values section',
      ],
    ],
    // Services page
    [
      [/services\s*(page|section|list)|our\s*services|service\s*card/],
      [
        'Add icons and hover animations to each service card',
        'Add a "Request this service" button linking to the contact form',
        'Add pricing or "Starting from" labels to each service',
      ],
    ],
    // Doctor / medical profiles
    [
      [/doctor\s*(profile|page|card|list)|physician|specialist\s*page|medical\s*team/],
      [
        'Add a "Book appointment" button on each doctor profile',
        'Add a filter by specialty above the doctor listing',
        'Add availability hours to each doctor card',
      ],
    ],
    // Food menu
    [
      [/food\s*menu|restaurant\s*menu|menu\s*(page|section|with\s*item)|dish\s*listing/],
      [
        'Add category tabs (Starters, Mains, Desserts) to filter the menu',
        'Add dietary labels (vegan, gluten-free) to each dish',
        'Add a "Add to order" button for each menu item',
      ],
    ],
    // Real estate listing
    [
      [/property\s*(listing|card|page)|real\s*estate\s*listing|house\s*listing/],
      [
        'Add a map view to show property locations',
        'Add a filter bar (price, bedrooms, property type)',
        'Add a mortgage calculator widget on the property detail page',
      ],
    ],
    // Settings page
    [
      [/settings\s*page|preferences\s*page|account\s*settings/],
      [
        'Add a save confirmation toast when settings are updated',
        'Group settings into sections with a left-side category nav',
        'Add a danger zone section for account deletion / data export',
      ],
    ],
    // Notifications
    [
      [/notification\s*(panel|center|bell|feed|list|page)/],
      [
        'Add a red badge count on the notification bell icon',
        'Add "Mark all as read" button at the top',
        'Add filter tabs (All, Unread, Mentions)',
      ],
    ],
    // Sidebar navigation
    [
      [/sidebar\s*(nav|navigation|menu|layout)|side\s*nav/],
      [
        'Add a collapse/expand toggle to the sidebar',
        'Highlight the active page link in the sidebar',
        'Add a user avatar and name at the bottom of the sidebar',
      ],
    ],
    // Modal / dialog
    [
      [/modal|dialog|popup|lightbox/],
      [
        'Add a fade-in animation when the modal opens',
        'Close the modal when clicking the backdrop behind it',
        'Add a confirmation step inside the modal before the action runs',
      ],
    ],
    // Search
    [
      [/search\s*(bar|page|component|input|feature)|search\s*results/],
      [
        'Add autocomplete / type-ahead suggestions to the search bar',
        'Highlight the search term in the results',
        'Add filter chips to narrow down the search results',
      ],
    ],
    // Home page (full page)
    [
      [/home\s*page|homepage|index\s*page|landing\s*page/],
      [
        'Add a smooth scroll animation between sections',
        'Add a sticky header that shrinks on scroll',
        'Add an animated counter for stats (users, projects, etc.)',
      ],
    ],
    // Color / theme / styling update
    [
      [/color\s*scheme|color\s*palette|theme|typography|font|styling|redesign|visual/],
      [
        'Add a dark mode toggle that persists across pages',
        'Apply the new colors to the buttons and hover states',
        'Add subtle entrance animations as sections scroll into view',
      ],
    ],
    // Responsive / mobile fix
    [
      [/mobile\s*responsive|responsive\s*(layout|design|fix)|mobile.?friendly|breakpoint/],
      [
        'Test and fix the tablet (768px) layout next',
        'Add touch-friendly tap targets to all buttons',
        'Add swipe gestures to the carousel / gallery',
      ],
    ],
    // Animation / transition
    [
      [/animation|transition|framer.motion|fade.?in|slide.?in|scroll\s*animation/],
      [
        'Add staggered entrance animations to the list items',
        'Add a parallax scroll effect to the background image',
        'Add a loading skeleton before content appears',
      ],
    ],
    // Full initial build (many files, first generation)
    [
      [/created|built|generated|implemented|added/],
      [], // handled below by file-count logic
    ],
  ];

  const picked: string[] = [];
  for (const [patterns, suggestions] of candidates) {
    if (suggestions.length === 0) continue;
    if (match(...patterns)) {
      for (const s of suggestions) {
        if (!picked.includes(s)) picked.push(s);
        if (picked.length === 3) return picked;
      }
    }
  }

  // Fallback: infer from what files changed — still change-specific, not generic
  if (picked.length < 3) {
    const changedFiles = filePaths.map(p => p.toLowerCase());
    const justNav = changedFiles.some(p => /nav|header/.test(p)) && changedFiles.length <= 3;
    const justPage = changedFiles.some(p => /page/.test(p)) && changedFiles.length <= 4;
    const manyFiles = changedFiles.length > 5;

    if (justNav && !picked.length) {
      picked.push('Make the navbar sticky on scroll', 'Add a hamburger menu for mobile', 'Add active link highlighting');
    } else if (justPage && !picked.length) {
      picked.push('Add a loading skeleton for this page', 'Make this page fully mobile responsive', 'Add smooth scroll-to-top at the bottom');
    } else if (manyFiles && !picked.length) {
      picked.push('Make the layout fully mobile responsive', 'Add smooth entrance animations on scroll', 'Add a sticky header that hides on scroll down');
    }
  }

  // Last resort — still change-aware (not domain-generic)
  if (picked.length < 3) {
    const remaining = [
      'Make the layout fully mobile responsive',
      'Add smooth entrance animations on scroll',
      'Add a sticky header that hides on scroll down',
    ].filter(s => !picked.includes(s));
    picked.push(...remaining.slice(0, 3 - picked.length));
  }

  return picked.slice(0, 3);
}

// Strip ALL <ecomgear-*> / <egear-*> tags from the visible chat text.
// During streaming, any open (unclosed) block tag hides everything after it
// so the user never sees raw XML or partial code.
function stripEcomgearTags(raw: string): string {
  let s = raw;

  // Strip model-internal reasoning/tool-call markup (thinking blocks, function calls)
  // that leaks from DeepSeek, Gemini, and plan-mode responses into the text stream.
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  s = s.replace(/<thinking>[\s\S]*?<\/antml:thinking>/gi, '');
  s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  s = s.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '');
  s = s.replace(/<invoke[\s\S]*?<\/invoke>/gi, '');
  // Partial/unclosed internal block still streaming — truncate at start of tag
  const internalPartials: RegExp[] = [/<(?:antml:)?thinking>/i, /<function_calls[\s>]/i, /<tool_calls[\s>]/i, /<invoke[\s>]/i];
  for (const re of internalPartials) {
    const idx = s.search(re);
    if (idx !== -1) { s = s.slice(0, idx); break; }
  }

  // Remove complete ecomgear/egear block tags + their content
  s = s.replace(/<ecomgear-write[\s\S]*?<\/ecomgear-write>/gi, '\n\n');
  s = s.replace(/<ecomgear-edit[\s\S]*?<\/ecomgear-edit>/gi, '\n\n');
  s = s.replace(/<ecomgear-chat-summary>[\s\S]*?<\/ecomgear-chat-summary>/gi, '');

  // Remove complete self-closing / void tags (both ecomgear- and egear- prefixes)
  s = s.replace(/<(?:ecomgear|egear)-(rename|delete|add-dependency|command|file)[^>]*\/?>/gi, '');

  // Remove any explicit closing tags (both prefix forms)
  s = s.replace(/<\/(?:ecomgear|egear)-[a-z-]+>/gi, '');

  // Hide everything from any still-open ecomgear/egear tag to end of buffer
  const partialIdx = s.search(/<(?:ecomgear|egear)-/i);
  if (partialIdx !== -1) s = s.slice(0, partialIdx);

  // Normalize whitespace
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ─── Human-friendly file path labels ────────────────────────────────────────
function filePathToLabel(filePath: string): string {
  const base = filePath.replace(/\.[^.]+$/, '').split('/').pop() ?? filePath;
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  if (words.startsWith('use ')) return words.replace('use ', '') + ' hook';
  if (filePath.includes('/pages/')) return words + ' page';
  if (filePath.includes('/components/')) return words + ' component';
  if (filePath.includes('/hooks/')) return words + ' hook';
  if (filePath.includes('/lib/') || filePath.includes('/utils/')) return words;
  if (base === 'App') return 'app shell';
  if (base === 'main') return 'app entry';
  return words;
}

// ─── Model branding ───────────────────────────────────────────────────────────

// ─── Component ────────────────────────────────────────────────────────────────

interface AgentChatPanelProps {
  projectId: string;
  userId: string;
  currentOrganizationId?: string | null;
  onFilesGenerated?: (files: { path: string; content: string }[], filesToDelete?: string[], previewPushed?: boolean) => void;
  onGenerationComplete?: (tokensUsed: number) => void;
  /** Called with the real token count once the server resolves usage (fires after onGenerationComplete) */
  onUsage?: (tokensUsed: number) => void;
  isMinimized?: boolean;
  /** When set, automatically send this prompt to the agent (e.g. from Repair button). */
  triggerPrompt?: string | null;
  /** Called once after triggerPrompt has been consumed so the parent can clear it. */
  onTriggerConsumed?: () => void;
  /** Called when user clicks a preview command button (e.g. 'restart', 'refresh'). */
  onPreviewCommand?: (cmd: string) => void;
  /** Called with each text-delta chunk as it streams from the agent. */
  onAgentStreamText?: (chunk: string) => void;
  /** Called when the stream resets (new generation started). */
  onAgentStreamClear?: () => void;
}

export const AgentChatPanel: React.FC<AgentChatPanelProps> = ({
  projectId,
  userId,
  currentOrganizationId,
  onFilesGenerated,
  onGenerationComplete,
  onUsage,
  isMinimized = false,
  triggerPrompt,
  onTriggerConsumed,
  onPreviewCommand,
  onAgentStreamText,
  onAgentStreamClear,
}) => {
  const GREETING: Message = {
    id: 'greeting',
    role: 'assistant',
    content:
      "Welcome to **EcomGear App Builder**",
    status: 'complete',
  };

  const MAX_INPUT_CHARS = 4000;

  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [stepCount, setStepCount] = useState(0);
  // Timestamp until which LLM-generated statuses block lower-priority overrides.
  const llmStatusLockedUntil = useRef<number>(0);
  const [liveFiles, setLiveFiles] = useState<LiveFileChange[]>([]);
  const [filesWritten, setFilesWritten] = useState(0);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<'agent' | 'plan'>(() => {
    try {
      const saved = localStorage.getItem('ecomgear:agentMode');
      return saved === 'plan' ? 'plan' : 'agent';
    } catch { return 'agent'; }
  });

  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pagination state for chat history
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const oldestTimestampRef = useRef<string | null>(null);
  // Tracks consecutive auto-repair escalations from the frontend (after server repair exhausted).
  // Resets to 0 on any successful build. Capped at 2 to prevent infinite repair loops.
  const autoRepairCountRef = useRef<number>(0);

  const pushStatus = (message: string, isLLM = false, force = false) => {
    if (!isLLM && !force && Date.now() < llmStatusLockedUntil.current) return;
    if (isLLM) llmStatusLockedUntil.current = Date.now() + 4000;
    setStatusText((prev) => (prev === message ? prev : message));
  };

  const startProgressFeedback = () => {
    setStatusText('Preparing request...');
    setStepCount(0);
    setLiveFiles([]);
    setFilesWritten(0);
    llmStatusLockedUntil.current = 0;
    // Start elapsed seconds counter
    setElapsedSeconds(0);
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    elapsedIntervalRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
  };

  // ── Stop elapsed timer when generation ends ───────────────────────────────
  useEffect(() => {
    if (!isGenerating && elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, [isGenerating]);

  // Persist plan/build mode across refreshes
  useEffect(() => {
    try { localStorage.setItem('ecomgear:agentMode', agentMode); } catch {}
  }, [agentMode]);

  // ── Auto-trigger from external prompt (e.g. Repair button) ──────────────
  useEffect(() => {
    if (!triggerPrompt || isGenerating) return;
    onTriggerConsumed?.();
    handleSubmit(triggerPrompt, '🔧 Repair request', 'build');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerPrompt]);

  // ── Eco usage ──────────────────────────────────────────────────────────────
  const { refreshUsage, isWithinLimit, applyUsageDelta } = useUsage();

  // ── Detect guest mode from userId ──────────────────────────────────────────
  const isGuest = userId.startsWith('guest:');
  const guestFingerprint = isGuest ? userId.slice('guest:'.length) : undefined;

  // Model is now auto-selected server-side based on request tier and user plan.

  // ── Load message history ──────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    // Guests have no persisted history
    if (isGuest) { setMessages([GREETING]); return; }
    // Guard: if the component unmounts or projectId changes before the async
    // load completes, don't overwrite whatever state is current (which may
    // include an in-flight generation the user started before history arrived).
    let cancelled = false;
    (async () => {
      try {
        // Ensure a valid session before querying — on page refresh the token
        // may be stale and getSession() returns null until the refresh completes.
        // Try getSession() first; if null, call refreshSession() once before giving up.
        let { data: { session } } = await lovableCloud.auth.getSession();
        if (!session && !cancelled) {
          const { data: refreshed } = await lovableCloud.auth.refreshSession();
          session = refreshed.session;
        }
        // Still no session — user is truly not logged in; show clean slate but
        // do NOT overwrite an already-populated messages array (e.g. a run is in progress)
        if (!session || cancelled) {
          if (!cancelled) setMessages(prev => prev.length <= 1 ? [GREETING] : prev);
          return;
        }
        const { messages: history, hasMore } = await messageService.loadRecentMessages(projectId, 30);
        if (cancelled) return;
        if (history.length === 0) {
          setMessages([GREETING]);
          return;
        }
        // Track oldest timestamp for "load more" cursor
        if (history.length > 0) oldestTimestampRef.current = history[0].created_at;
        setHasMoreMessages(hasMore);

        // Prepend GREETING once, then map DB rows using their real IDs.
        // Strip all ecomgear operational tags from stored content.
        const mapped: Message[] = [
          GREETING,
          ...history.map((m) => {
            if (m.role === 'assistant') {
              const { body, summary } = extractSummary(stripEcomgearTags(m.content));
              return { id: m.id, role: 'assistant' as const, content: body, status: 'complete' as const, summary };
            }
            return { id: m.id, role: 'user' as const, content: m.content, status: 'complete' as const };
          }),
        ];
        setMessages(mapped);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load message history', err);
        // Don't wipe existing messages on a transient error
        setMessages(prev => prev.length <= 1 ? [GREETING] : prev);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, isGuest]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  // scrollRef points to a plain div with overflow-y:auto — set scrollTop directly.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, statusText]);

  // ── Load older messages when scrolled to top ──────────────────────────────
  const loadMoreMessages = async () => {
    if (!hasMoreMessages || isLoadingMore || !oldestTimestampRef.current || isGuest) return;
    setIsLoadingMore(true);
    try {
      const { messages: older, hasMore } = await messageService.loadMessagesBefore(
        projectId, oldestTimestampRef.current, 20
      );
      if (older.length === 0) { setHasMoreMessages(false); return; }

      oldestTimestampRef.current = older[0].created_at;
      setHasMoreMessages(hasMore);

      const mapped: Message[] = older.map((m) => {
        if (m.role === 'assistant') {
          const { body, summary } = extractSummary(stripEcomgearTags(m.content));
          return { id: m.id, role: 'assistant' as const, content: body, status: 'complete' as const, summary };
        }
        return { id: m.id, role: 'user' as const, content: m.content, status: 'complete' as const };
      });

      // Preserve scroll position: save height before prepend, restore delta after
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setMessages(prev => [...mapped, ...prev]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (err) {
      console.error('Failed to load older messages', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80 && hasMoreMessages && !isLoadingMore) loadMoreMessages();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreMessages, isLoadingMore, projectId]);

  // ── Close model menu on outside click ────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Cleanup on unmount / project change ──────────────────────────────────
  // Do NOT abort the agent on unmount — it should keep running server-side.
  // Only clear local UI timers. The user can reconnect by navigating back.
  useEffect(() => () => {}, [projectId]);

  // ── Auto-reconnect to active run when loading this project ───────────────
  useEffect(() => {
    if (!projectId || isGuest) return;
    let cancelled = false;

    (async () => {
      try {
        const { data: { session } } = await lovableCloud.auth.getSession();
        if (!session || cancelled) return;

        const urls = getGenServerCandidateUrls(`/api/v1/ai/active-run/${projectId}`);
        for (const url of urls) {
          try {
            const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
            if (!r.ok) break;
            const json = await r.json();
            if (cancelled) return;
            if (json.active && !isGenerating) {
              // A run is in progress server-side — reconnect to it
              const asstId = `reconnect-${Date.now()}`;
              setMessages(prev => [...prev, { id: asstId, role: 'assistant', content: '', status: 'pending' }]);
              setIsGenerating(true);
              startProgressFeedback();

              let currentContent = '';
              let toolXmlAccum = '';
              let generationDone = false;

              abortRef.current = new AbortController();
              streamAgentGeneration({
                prompt: '__rejoin__',
                projectId,
                orgId: currentOrganizationId,
                callbacks: {
                  onTextDelta: (chunk) => {
                    if (generationDone || cancelled) return;
                    currentContent += chunk;
                    setMessages(prev => prev.map(m => m.id === asstId
                      ? { ...m, content: stripEcomgearTags(currentContent), status: 'streaming' }
                      : m));
                  },
                  onToolOutput: (xml) => {
                    if (generationDone || cancelled) return;
                    toolXmlAccum += xml + '\n';
                  },
                  onStepFinish: (stepData: StepFinishData) => {
                    if (generationDone || cancelled) return;
                    if (stepData.step > 0) setStepCount(stepData.step);
                    const isLLMStatus = stepData.step === 0 && stepData.toolCount === 0;
                    if (stepData.status) pushStatus(stepData.status, isLLMStatus);
                  },
                  onDone: (result) => {
                    generationDone = true;
                    setIsGenerating(false);
                    setStatusText('');
                    setStepCount(0);
                    setLiveFiles([]);
                    setFilesWritten(0);
                    const rawContent = currentContent || result.summary || '';
                    const { body: finalContent, summary } = extractSummary(stripEcomgearTags(rawContent));
                    const toolActivities = parseToolActivities(toolXmlAccum || rawContent);
                    const displayContent = finalContent || (toolActivities.length > 0 ? '' : 'Something went wrong — please try again.');
                    setMessages(prev => prev.map(m => m.id === asstId
                      ? { ...m, status: 'complete', content: displayContent, summary, toolActivities, snapshotId: result.snapshotId }
                      : m));
                    if (onFilesGenerated && (result.filesToWrite?.length > 0 || result.filesToDelete?.length > 0)) {
                      onFilesGenerated(
                        (result.filesToWrite ?? []).map((f: { path: string; content: string | Buffer }) => ({
                          path: f.path,
                          content: typeof f.content === 'string' ? f.content : '',
                        })),
                        result.filesToDelete ?? [],
                        result.previewPushed === true
                      );
                    }
                    onGenerationComplete?.(result.tokensUsed ?? 0);
                    refreshUsage().catch(() => {});
                  },
                  onError: () => {
                    if (cancelled) return;
                    setIsGenerating(false);
                    setStatusText('');
                    setStepCount(0);
                    setLiveFiles([]);
                    setFilesWritten(0);
                    setMessages(prev => prev.filter(m => m.id !== asstId));
                  },
                },
                signal: abortRef.current.signal,
              }).catch(() => {
                if (!cancelled) {
                  setIsGenerating(false);
                  setMessages(prev => prev.filter(m => m.id !== asstId));
                }
              });
            }
            break;
          } catch { break; }
        }
      } catch { /* ignore */ }
    })();

    return () => {
      cancelled = true;
      // Abort any in-flight SSE stream so a stale project's events don't
      // bleed into the next project's chat panel when the user switches projects.
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ── File attachment handlers ──────────────────────────────────────────────
  const handleFiles = async (files: FileList | File[]) => {
    if (isGuest) { toast.error('Sign up to attach files'); return; }
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    for (const file of fileArray) {
      const check = isAllowedFile(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }

      setUploadingCount(prev => prev + 1);
      try {
        const attachment = await uploadChatAttachment(file, userId, projectId);
        setPendingAttachments(prev => [...prev, attachment]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        toast.error(`Failed to upload ${file.name}: ${message}`);
      } finally {
        setUploadingCount(prev => prev - 1);
      }
    }
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (overridePrompt?: string, displayText?: string, forcedMode?: 'build' | 'plan') => {
    const raw = (overridePrompt ?? input).trim();
    const hasAttachments = !overridePrompt && pendingAttachments.length > 0;
    if ((!raw && !hasAttachments) || isGenerating || !projectId) return;

    // Eco gate — block non-guest users who are at their daily limit
    if (!isGuest && !isWithinLimit()) {
      toast.error('Monthly eco limit reached. Please upgrade your plan or wait for the reset.');
      return;
    }

    if (!overridePrompt) setInput('');

    // Capture and clear pending attachments
    const messageAttachments = !overridePrompt ? [...pendingAttachments] : [];
    if (!overridePrompt) setPendingAttachments([]);

    const effectivePrompt = raw || (messageAttachments.length > 0 ? 'Please review the attached files.' : '');

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: displayText ?? raw,
      status: 'complete',
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    };
    const asstId = (Date.now() + 1).toString();
    const asstMsg: Message = { id: asstId, role: 'assistant', content: '', status: 'pending' };

    setMessages(prev => [...prev, userMsg, asstMsg]);
    setIsGenerating(true);
    startProgressFeedback();

    // Optimistic eco display: increment counter by 1 immediately so the header
    // stays in sync without waiting for refreshUsage() after generation ends.
    if (!isGuest) applyUsageDelta(1);

    // Persist user message (skip for guests — no DB project row)
    if (!isGuest) {
      messageService.saveUserMessage(projectId, raw, userId).catch(err => {
        console.error('Failed to save user message', err);
        toast.error('Message could not be saved. Check your connection.');
      });
    }

    // ── Build conversation history ─────────────────────────────────────────
    // Grab all real turns (skip the static GREETING, skip the two new stubs
    // we just added).  Only include 'complete' messages so we never send
    // partial/pending/error turns as context.
    const HISTORY_WINDOW = 6;   // messages to send in full  (3 exchanges)
    const completedTurns = messages.filter(
      m => m.id !== 'greeting' && m.status === 'complete' && m.content.trim()
    );

    // Split: recent goes in full, older gets condensed to a summary line
    const recentTurns = completedTurns.slice(-HISTORY_WINDOW);
    const olderTurns  = completedTurns.slice(0, -HISTORY_WINDOW);

    const history = recentTurns.map(m => ({
      role: m.role as 'user' | 'assistant',
      // Content is already cleaned (ecomgear tags stripped on save/load)
      content: m.content,
    }));

    // Compress older turns into a structured summary to give the server stable,
    // verifiable context without hallucination from narrative-only chips.
    // Combines: verified file changes from tool activities + user constraints + summary chips.
    const olderSummary = olderTurns.length > 0
      ? (() => {
          // Collect verified file changes from tool activities (ground truth — not LLM narrative)
          const filesChanged: string[] = [];
          const constraints: string[] = [];

          for (const m of olderTurns) {
            if (m.role === 'assistant' && m.toolActivities) {
              for (const act of m.toolActivities) {
                if (act.type === 'write' || act.type === 'edit') {
                  filesChanged.push(act.label);
                }
              }
            }
            if (m.role === 'user') {
              const text = m.content.trim();
              if (/\b(keep|make sure|don't|do not|always|never|must|should)\b/i.test(text)) {
                constraints.push(text.slice(0, 100));
              }
            }
          }

          const structuredLines: string[] = [];
          const uniqueFiles = [...new Set(filesChanged)];
          if (uniqueFiles.length > 0) {
            structuredLines.push(`Files modified in earlier turns: ${uniqueFiles.slice(0, 20).join(', ')}`);
          }
          if (constraints.length > 0) {
            structuredLines.push(`User constraints to maintain: ${[...new Set(constraints)].slice(0, 3).join(' | ')}`);
          }

          // Also include assistant summary chips as narrative context fallback
          const summaryChips = olderTurns
            .filter(m => m.role === 'assistant')
            .map(m => `• ${m.summary || m.content.split('\n')[0].slice(0, 80)}`)
            .join('\n');

          return structuredLines.length > 0
            ? `${structuredLines.join('\n')}\n\nEarlier responses:\n${summaryChips}`
            : summaryChips;
        })()
      : undefined;

    let currentContent = '';
    // Accumulate XML from tool-output events (write_file / delete_file / rename_file).
    // This is the real source for toolActivities chips — the text-delta stream
    // almost never contains <ecomgear-*> tags when the agent uses tool calls.
    let toolXmlAccum = '';
    // Guard: once 'done' is received, ignore any late text-delta events.
    let generationDone = false;

    try {
      abortRef.current = new AbortController();
      await streamAgentGeneration({
        prompt: effectivePrompt,
        projectId,
        orgId: currentOrganizationId,
        mode: forcedMode ?? (agentMode === 'plan' ? 'plan' : undefined),
        history,
        olderSummary,
        fingerprint: guestFingerprint,
        attachments: messageAttachments.length > 0
          ? messageAttachments.map(a => ({
              name: a.name,
              type: a.type,
              category: a.category,
              tempPath: a.tempPath,
            }))
          : undefined,
        callbacks: {
          onOpen: () => {
            onAgentStreamClear?.();
            pushStatus('Reviewing request...');
          },
          onTextDelta: (chunk) => {
            if (generationDone) return;          // drop late post-done events
            onAgentStreamText?.(chunk);
            currentContent += chunk;
            const displayContent = stripEcomgearTags(currentContent);

            // Only update statusText from text-delta if no tool is actively running.
            // onToolOutput already sets a more precise label; don't overwrite it.
            const liveTool = detectLiveTool(currentContent);
            if (liveTool) pushStatus(liveTool);
            else if (displayContent.trim().length > 0) pushStatus('Writing response...');

            setMessages(prev =>
              prev.map(m =>
                m.id === asstId ? { ...m, content: displayContent, status: 'streaming' } : m
              )
            );
          },
          onToolOutput: (xml) => {
            if (generationDone) return;
            toolXmlAccum += xml + '\n';

            // Track live file changes
            const writeMatch = /ecomgear-write[^>]*\bpath="([^"]+)"/.exec(xml);
            const editMatch = /ecomgear-edit[^>]*\bpath="([^"]+)"/.exec(xml);
            const deleteMatch = /ecomgear-delete[^>]*\bpath="([^"]+)"/.exec(xml);
            const renameMatch = /ecomgear-rename[^>]*\bfrom="([^"]+)"/.exec(xml);
            const depMatch = /ecomgear-add-dependency[^>]*\bpackages="([^"]+)"/.exec(xml);

            if (writeMatch) {
              pushStatus(`Building ${filePathToLabel(writeMatch[1])}...`, false, true);
              setLiveFiles(prev => [...prev, { path: writeMatch[1], type: 'write', timestamp: Date.now() }]);
              setFilesWritten(prev => prev + 1);
            } else if (editMatch) {
              pushStatus(`Updating ${filePathToLabel(editMatch[1])}...`, false, true);
              setLiveFiles(prev => [...prev, { path: editMatch[1], type: 'edit', timestamp: Date.now() }]);
              setFilesWritten(prev => prev + 1);
            } else if (deleteMatch) {
              pushStatus(`Removing ${filePathToLabel(deleteMatch[1])}...`, false, true);
              setLiveFiles(prev => [...prev, { path: deleteMatch[1], type: 'delete', timestamp: Date.now() }]);
            } else if (renameMatch) {
              pushStatus(`Renaming ${filePathToLabel(renameMatch[1])}...`, false, true);
              setLiveFiles(prev => [...prev, { path: `${renameMatch[1]} → ${renameMatch[2]}`, type: 'rename', timestamp: Date.now() }]);
            } else if (depMatch) {
              pushStatus(`Installing ${depMatch[1]}...`, false, true);
              setLiveFiles(prev => [...prev, { path: depMatch[1], type: 'dependency', timestamp: Date.now() }]);
            } else {
              pushStatus('Applying changes...');
            }
          },
          onStepFinish: (stepData: StepFinishData) => {
            if (generationDone) return;
            if (stepData.step > 0) setStepCount(stepData.step);
            const isLLMStatus = stepData.step === 0 && stepData.toolCount === 0;
            if (stepData.status) pushStatus(stepData.status, isLLMStatus);
            else if (stepData.toolCount > 0) pushStatus('Reviewing generated changes...');
          },
          onDone: (result) => {
            generationDone = true;             // block any further text-delta updates
            setIsGenerating(false);
            setStatusText('');
            setStepCount(0);
            setLiveFiles([]);
            setFilesWritten(0);

            // Prefer full streamed text over backend summary
            const rawContent = currentContent || result.summary || '';
            const { body: strippedContent, summary } = extractSummary(stripEcomgearTags(rawContent));
            const isPlan = result.mode === 'plan'
              || (!result.mode && /reply\s+\*\*execute\*\*/i.test(rawContent) && !overridePrompt);
            // Tool activities come from tool-output XML (accumulated during streaming),
            // not from the text-delta stream which rarely contains ecomgear tags.
            const toolActivities = isPlan ? [] : parseToolActivities(toolXmlAccum || rawContent);
            // Show actual output; if model returned nothing and no tool activity, show a retry hint.
            const finalContent = strippedContent.trim() || result.summary?.trim()
              || (toolActivities.length > 0 ? '' : 'The model didn\'t respond. Please try rephrasing your request.');

            const suggestedCommands = isPlan ? [] : parseCommandSuggestions(toolXmlAccum || rawContent);
            const filePaths = (result.filesToWrite ?? []).map((f: { path: string }) => f.path);
            // Detect confirm-first spec: agent described a plan and asked for confirmation
            // (ghostRun=true because no files written yet, but it's not a plan-mode response).
            const isConfirmRequest = !isPlan && result.ghostRun === true &&
              /shall i (start building|begin|proceed|start coding|go ahead)|let me know if you.{0,10}d like (any changes|to (change|adjust))|ready to (start|build)|should i (start|build|proceed)|confirm or adjust/i.test(rawContent);

            // For confirm requests, show fixed chips immediately. For real builds, set null (loading)
            // while Gemini generates contextual suggestions — skeleton chips show in the meantime.
            const initialSuggestions: string[] | null = isConfirmRequest
              ? ['Yes, build it!', 'Make some changes first']
              : !isPlan && filePaths.length > 0 ? null   // null = Gemini loading
              : [];

            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'complete', content: finalContent, isPlan, summary, toolActivities, snapshotId: result.snapshotId, suggestedCommands, followUpSuggestions: initialSuggestions }
                  : m
              )
            );

            // Fire Gemini suggestion call — replaces null (loading) with real chips when done.
            if (!isConfirmRequest && !isPlan && filePaths.length > 0) {
              fetch(getGenServerUrl('/api/v1/ai/suggestions'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  summary: (summary || finalContent).slice(0, 800),
                  filePaths,
                  userPrompt: effectivePrompt.slice(0, 300),
                }),
              })
                .then(r => r.ok ? r.json() : null)
                .then((data: { suggestions?: string[] } | null) => {
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === asstId
                        ? { ...m, followUpSuggestions: data?.suggestions?.length ? data.suggestions : [] }
                        : m
                    )
                  );
                })
                .catch(() => {
                  // On failure, clear the loading state so skeleton doesn't stay forever
                  setMessages(prev =>
                    prev.map(m => m.id === asstId ? { ...m, followUpSuggestions: [] } : m)
                  );
                });
            }

            // Persist assistant message (skip for guests, save plan messages too)
            if (!isGuest && finalContent.trim()) {
              messageService.saveAssistantMessage(projectId, finalContent, userId).catch(err => {
                console.error('Failed to save assistant message', err);
                toast.error('Message could not be saved. Check your connection.');
              });
            }

            if (!isPlan) {
              if (result.ghostRun) {
                // Agent produced text but wrote no files — this is a normal conversational
                // response (question, clarification, limitation). Never auto-retry here.
                // Auto-fix only happens via onRepairFailed when there are real syntax/build errors.
              }
              if (onFilesGenerated && (result.filesToWrite?.length > 0 || result.filesToDelete?.length > 0)) {
                onFilesGenerated(
                  (result.filesToWrite ?? []).map((f: { path: string; content: string | Buffer }) => ({
                    path: f.path,
                    content: typeof f.content === 'string' ? f.content : '',
                  })),
                  result.filesToDelete ?? [],
                  result.previewPushed === true
                );
              }
              onGenerationComplete?.(result.tokensUsed ?? 0);
              // Refresh eco usage display after generation
              if (!isGuest) refreshUsage().catch(() => {});
              autoRepairCountRef.current = 0; // successful build — reset repair counter
              toast.success('App updated.');
            }
          },
          onRepairFailed: (errors) => {
            autoRepairCountRef.current += 1;

            // Cap at 2 consecutive frontend escalations — beyond this the AI is clearly
            // stuck in a loop and further auto-retries will not help.
            if (autoRepairCountRef.current > 2) {
              autoRepairCountRef.current = 0;
              const errorSummary = errors.length > 0
                ? errors.slice(0, 3).map(e => `- ${e.split('\n')[0]}`).join('\n')
                : '- Unknown build error';
              setMessages(prev =>
                prev.map(m =>
                  m.id === asstId
                    ? {
                        ...m,
                        status: 'complete',
                        content: currentContent || `Build errors could not be fixed automatically. Please describe what you'd like to change and I'll try again.\n\n${errorSummary}`,
                      }
                    : m
                )
              );
              return;
            }

            // Server-side auto-repair exhausted — escalate once more with a focused prompt
            const errorList = errors.length > 0
              ? errors.map(e => `- ${e}`).join('\n')
              : '- Unknown build error';
            const autoFixPrompt =
              `The app has build errors that could not be auto-repaired. Please fix all of them now:\n${errorList}\n\nFocus only on these errors. Keep changes minimal.`;
            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'complete', content: currentContent || 'Build errors detected. Attempting auto-fix…' }
                  : m
              )
            );
            // Brief delay so the completed message renders before the new run starts
            setTimeout(() => handleSubmit(autoFixPrompt, '🔧 Auto-fix', 'build'), 300);
          },
          onError: (errMsg) => {
            setIsGenerating(false);
            setStatusText('');
            setStepCount(0);
            setLiveFiles([]);
            setFilesWritten(0);
            // Show real error so users/devs can diagnose — strip raw HTTP prefix if present
            const display = errMsg
              ? errMsg.replace(/^Agent stream failed \(\d+\):\s*/i, '').slice(0, 300)
              : 'Model temporarily unavailable. Please try again.';
            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'error', content: currentContent || display }
                  : m
              )
            );
            toast.error(display);
          },
          onUsage: (tokensUsed) => {
            onUsage?.(tokensUsed);
          },
        },
        signal: abortRef.current.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setIsGenerating(false);
      setStatusText('');
      setStepCount(0);
      setLiveFiles([]);
      setFilesWritten(0);
      const errDisplay = err instanceof Error
        ? err.message.replace(/^Agent stream failed \(\d+\):\s*/i, '').slice(0, 300)
        : 'Model temporarily unavailable. Please try again.';
      setMessages(prev =>
        prev.map(m =>
          m.id === asstId && m.status !== 'error'
            ? { ...m, status: 'error', content: errDisplay }
            : m
        )
      );
      toast.error(errDisplay);
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setStatusText('');
    setStepCount(0);
    setLiveFiles([]);
    setFilesWritten(0);
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && (last.status === 'pending' || last.status === 'streaming')) {
        return prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, status: 'error', content: (m.content || '') + '\n\n*Cancelled.*' }
            : m
        );
      }
      return prev;
    });
  };

  const executePlan = (planContent: string) => {
    setAgentMode('agent');
    handleSubmit(`Execute the following plan:\n\n${planContent}`, 'Execute plan', 'build');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      setAgentMode(m => m === 'plan' ? 'agent' : 'plan');
    }
  };

  if (isMinimized) return null;

  const statusLabel = statusText || 'Working on your request...';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(99,102,241,0.04) 0%, transparent 70%), #09090b' }}>

      {/* ── Header ── */}
      <div>
        <div className="flex items-center gap-0.5">
          {isGenerating && (
            <button
              onClick={cancelGeneration}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-400/10 transition-colors"
            >
              <StopCircle className="w-3 h-3" /> Stop
            </button>
          )}
        </div>
      </div>

      {/* ── Messages — plain div so scrollTop works directly ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-3 space-y-3">
          {/* Load-more indicator at top */}
          {isLoadingMore && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-400/60" />
            </div>
          )}
          {!isLoadingMore && hasMoreMessages && (
            <button
              onClick={loadMoreMessages}
              className="w-full text-center text-[11px] text-indigo-400/50 hover:text-indigo-300/80 py-1 transition-colors"
            >
              ↑ Load older messages
            </button>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className="group">
              {msg.id === 'greeting' ? (
                <div className="relative overflow-hidden rounded-2xl p-4 mb-1"
                  style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(139,92,246,0.14) 40%, rgba(6,182,212,0.08) 100%)' }}>
                  {/* Grid dot texture */}
                  <div className="absolute inset-0 opacity-[0.04]"
                    style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.9) 1px, transparent 1px)' }} />
                  {/* Glow orb */}
                  <div className="absolute -top-6 -right-6 w-28 h-28 rounded-full opacity-20"
                    style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.8), transparent 70%)' }} />
                  <div className="relative z-10 flex items-center gap-3 mb-3">
                    <img src="/src/assets/ecgagent.png" alt="EcomGear Agent" className="w-10 h-8 shrink-0" />
                    <div>
                      <p className="text-[13px] font-semibold text-white/90 leading-tight">EcomGear Agent</p>
                      <p className="text-[10px] text-indigo-300/60 font-medium tracking-wide">App Builder · AI Powered</p>
                    </div>
                  </div>
                  <p className="relative z-10 text-[12.5px] text-white/75 leading-relaxed">
                    Welcome to <span className="font-semibold text-white">EcomGear App Builder</span> describe what you want to build and I'll generate it for you.
                  </p>
                </div>
              ) : (<>
              <ChatMessage role={msg.role} content={msg.content} status={msg.status} attachments={msg.attachments} />

              {/* Retry button — shown on hover below user messages */}
              {msg.role === 'user' && (
                <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleSubmit(msg.content)}
                    disabled={isGenerating}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-white/25 hover:text-white/60 hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-default transition-all duration-150"
                    title="Retry this prompt"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                </div>
              )}

              {/* Tool activity chips — shown below assistant messages after completion */}
              {msg.role === 'assistant' && msg.status === 'complete' &&
               msg.toolActivities && msg.toolActivities.length > 0 && (
                <div className="mt-1.5 ml-[30px] flex flex-wrap gap-1">
                  {msg.toolActivities.map((act, i) => {
                    const cfg: Record<ToolActivity['type'], { icon: string; cls: string }> = {
                      write:      { icon: '✦', cls: 'text-indigo-300  bg-indigo-500/10  border-indigo-500/20'  },
                      edit:       { icon: '✎', cls: 'text-blue-300    bg-blue-500/10    border-blue-500/20'    },
                      delete:     { icon: '✕', cls: 'text-red-400     bg-red-500/10     border-red-500/20'     },
                      rename:     { icon: '↪', cls: 'text-yellow-300  bg-yellow-500/10  border-yellow-500/20'  },
                      dependency: { icon: '⬡', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
                      command:    { icon: '⚡', cls: 'text-orange-300  bg-orange-500/10  border-orange-500/20'  },
                    };
                    const { icon, cls } = cfg[act.type] ?? cfg.write;
                    const displayLabel = (act.type === 'dependency' || act.type === 'command')
                      ? act.label
                      : filePathToLabel(act.label);
                    return (
                      <span key={i} title={act.label} className={`inline-flex items-center gap-0.5 px-1.5 py-px rounded border text-[9px] font-mono ${cls}`}>
                        <span>{icon}</span>{displayLabel}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Summary chip */}
              {msg.summary && msg.status === 'complete' && (
                <div className="mt-1 ml-[30px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-[9px] text-gray-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/60 shrink-0" />
                  {msg.summary}
                </div>
              )}


              {/* Undo button — only on completed non-plan assistant messages that have a snapshot (hidden for guests) */}
              {!isGuest && msg.role === 'assistant' && msg.status === 'complete' && !msg.isPlan && msg.snapshotId && (
                <div className="mt-1.5 ml-[30px]">
                  <button
                    disabled={isGenerating || rollingBack}
                    onClick={async () => {
                      if (!msg.snapshotId) return;
                      setRollingBack(true);
                      try {
                        const { data: { session } } = await lovableCloud.auth.getSession();
                        if (!session) throw new Error('Not authenticated');
                        const resp = await fetch(getGenServerUrl('/api/v1/ai/rollback'), {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${session.access_token}`,
                          },
                          body: JSON.stringify({ snapshotId: msg.snapshotId, projectId }),
                        });
                        if (!resp.ok) {
                          const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
                          throw new Error(err.error ?? 'Rollback failed');
                        }
                        // Remove snapshotId from this message so the button disappears
                        setMessages(prev => prev.map(m =>
                          m.id === msg.id ? { ...m, snapshotId: undefined } : m
                        ));
                        toast.success('Rolled back — project restored to previous state.');
                      } catch (err: unknown) {
                        toast.error(err instanceof Error ? err.message : 'Rollback failed');
                      } finally {
                        setRollingBack(false);
                      }
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-yellow-500/25 bg-yellow-500/8 text-yellow-300/80 hover:bg-yellow-500/15 text-[10px] font-medium transition-colors disabled:opacity-40"
                  >
                    {rollingBack
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RotateCcw className="w-3 h-3" />}
                    Undo this change
                  </button>
                </div>
              )}

              {/* Preview command buttons — shown when agent suggests restart/refresh/rebuild */}
              {msg.role === 'assistant' && msg.status === 'complete' && msg.suggestedCommands && msg.suggestedCommands.length > 0 && (
                <div className="mt-1.5 ml-[30px] flex flex-wrap gap-1.5">
                  {msg.suggestedCommands.map((cmd) => {
                    const labels: Record<string, string> = { restart: 'Restart', refresh: 'Refresh', rebuild: 'Rebuild' };
                    const label = labels[cmd] ?? cmd;
                    return (
                      <button
                        key={cmd}
                        disabled={isGenerating}
                        onClick={() => onPreviewCommand?.(cmd)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-600/15 hover:bg-indigo-600/25 border border-indigo-500/25 text-indigo-300/80 hover:text-indigo-200 text-[10px] font-medium transition-colors disabled:opacity-40"
                      >
                        <RotateCcw className="w-2.5 h-2.5" /> {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Follow-up suggestion chips — skeleton while Gemini is loading (null), chips when ready */}
              {msg.role === 'assistant' && msg.status === 'complete' && msg.followUpSuggestions !== undefined && !isGenerating && (
                <div className="mt-2 ml-[30px]">
                  {msg.followUpSuggestions === null ? (
                    /* Skeleton loading chips */
                    <div className="flex flex-wrap gap-1.5">
                      {[72, 96, 84].map((w) => (
                        <div
                          key={w}
                          className="h-[26px] rounded-full border border-white/[0.06] bg-white/[0.03] animate-pulse"
                          style={{ width: w }}
                        />
                      ))}
                    </div>
                  ) : msg.followUpSuggestions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.followUpSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          disabled={isGenerating}
                          onClick={() => handleSubmit(suggestion)}
                          className="animate-chip-pop px-2.5 py-1 rounded-full
                            bg-gradient-to-r from-white/[0.04] to-white/[0.02]
                            hover:from-indigo-500/[0.1] hover:to-purple-500/[0.07]
                            border border-white/[0.07] hover:border-indigo-500/30
                            text-gray-500 hover:text-gray-200 text-[11px]
                            transition-all duration-200 disabled:opacity-40
                            shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              </>)}
            </div>
          ))}

          {/* ── Live status + file activity feed ── */}
          {isGenerating && (
            <div className="ml-[28px] animate-status-in">
              {/* Status pill */}
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                bg-gradient-to-r from-indigo-600/[0.12] to-purple-600/[0.08]
                border border-indigo-500/[0.18]
                shadow-[0_0_16px_rgba(99,102,241,0.06)]">
                {/* Live dot with ping */}
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping-ring absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                </span>
                {/* Status text re-animates on each change */}
                <span
                  key={statusLabel}
                  className={`text-[11px] font-medium animate-status-in ${
                    /unavailable|failed|error/i.test(statusLabel)
                      ? 'text-red-400/80'
                      : /fallback|retry/i.test(statusLabel)
                        ? 'text-amber-400/80'
                        : 'text-indigo-200/80'
                  }`}
                >
                  {statusLabel}
                </span>
                {filesWritten > 0 && (
                  <span key={filesWritten} className="text-[10px] text-white/30 font-mono animate-count-in">
                    {filesWritten}f
                  </span>
                )}
                {stepCount > 0 && (
                  <span className="text-[10px] text-white/20 font-mono">·{stepCount}</span>
                )}
                <span className="text-[10px] text-white/20 font-mono tabular-nums">{elapsedSeconds}s</span>
              </div>

              {/* Live file activity feed */}
              {liveFiles.length > 0 && (
                <div className="flex flex-col mt-1.5 gap-0.5 pl-1">
                  {liveFiles.slice(-5).map((f, i, arr) => {
                    const isLatest = i === arr.length - 1;
                    const typeIcon: Record<string, string> = { write: '✦', edit: '✎', delete: '✕', rename: '↪', dependency: '⬡' };
                    const typeColor: Record<string, { active: string; dim: string }> = {
                      write:      { active: 'text-indigo-400',  dim: 'text-white/15' },
                      edit:       { active: 'text-blue-400',    dim: 'text-white/15' },
                      delete:     { active: 'text-red-400',     dim: 'text-white/15' },
                      rename:     { active: 'text-yellow-400',  dim: 'text-white/15' },
                      dependency: { active: 'text-emerald-400', dim: 'text-white/15' },
                    };
                    const col = typeColor[f.type] ?? { active: 'text-white/40', dim: 'text-white/15' };
                    const stagger = `stagger-${Math.min(i + 1, 5)}`;
                    return (
                      <div
                        key={f.timestamp}
                        className={`flex items-center gap-1.5 text-[10px] font-mono animate-chip-pop ${stagger} ${isLatest ? col.active : col.dim}`}
                      >
                        <span className="shrink-0 opacity-70">{typeIcon[f.type] ?? '·'}</span>
                        <span className="truncate max-w-[180px]">{f.path.replace(/^src\//, '')}</span>
                        {isLatest && (
                          <span className="w-1 h-1 rounded-full bg-current animate-pulse shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Bottom anchor — keeps scroll pinned */}
          <div className="h-1" />
        </div>
      </div>

      {/* ── Input ── */}
      <div
        className="p-2.5 border-t border-white/[0.06]"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.csv,.md,.json,.docx,.xlsx"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="max-h-[32vh] overflow-y-auto overscroll-contain pr-1 sm:max-h-[45vh]">
          {/* Drag overlay */}
          {isDragOver && (
            <div className="mb-2 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-500/40 bg-indigo-500/[0.06] py-4">
              <p className="text-xs text-indigo-300">Drop files here</p>
            </div>
          )}

          {/* Pending attachment previews */}
          {(pendingAttachments.length > 0 || uploadingCount > 0) && (
            <div className="mb-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto overscroll-contain sm:max-h-40">
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-gray-300"
                >
                  {att.category === 'image' ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <FileText className="h-4 w-4 text-gray-500 shrink-0" />
                  )}
                  <div className="min-w-0 max-w-[120px]">
                    <p className="truncate font-medium">{att.name}</p>
                    <p className="text-[9px] text-gray-600">{formatFileSize(att.size)}</p>
                  </div>
                  <button
                    onClick={() => removePendingAttachment(att.id)}
                    className="ml-1 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {uploadingCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Uploading…
                </div>
              )}
            </div>
          )}

          {/* Textarea — overflow-hidden only wraps this so rounded corners work */}
          <div className={`rounded-xl overflow-hidden transition-all duration-250
            ${isDragOver
              ? 'bg-[#0e0e14] border border-indigo-500/40 shadow-[0_0_0_1px_rgba(99,102,241,0.22),0_0_24px_rgba(99,102,241,0.10)]'
              : 'bg-[#0c0c10] border border-white/[0.08] focus-within:border-indigo-500/35 focus-within:shadow-[0_0_0_1px_rgba(99,102,241,0.18),0_0_20px_rgba(99,102,241,0.08)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_2px_8px_rgba(0,0,0,0.2)]'}`}>
            <Textarea
              ref={inputRef}
              placeholder={
                isGenerating ? 'Agent is working…'
                : 'Describe your idea or ask me to build something…'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.items);
                const imageFiles = items
                  .filter(item => item.type.startsWith('image/'))
                  .map(item => item.getAsFile())
                  .filter((f): f is File => f !== null);
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  handleFiles(imageFiles);
                }
              }}
              disabled={isGenerating || !projectId}
              className="min-h-[52px] max-h-[140px] w-full resize-none overflow-y-auto bg-transparent border-0 focus-visible:ring-0 shadow-none text-[12px] text-gray-200 placeholder:text-gray-600 px-3 pt-2.5 pb-2.5"
            />
          </div>
        </div>

        {/* Over-limit warning */}
        {input.length > MAX_INPUT_CHARS && (
          <p className="text-[11px] text-red-400 px-1 mt-1">
            Message is too long. Please shorten it before sending ({input.length - MAX_INPUT_CHARS} characters over the {MAX_INPUT_CHARS.toLocaleString()} limit).
          </p>
        )}

        {/* Toolbar */}
        <div className="flex items-center justify-between mt-1.5 px-0.5">

          {/* Left: attach */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating || !projectId}
            className="h-6 w-6 flex items-center justify-center rounded-md text-gray-600 hover:text-gray-300 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-default transition-all"
            title="Attach file"
          >
            <Paperclip className="w-3 h-3" />
          </button>

          {/* Right: char counter + mode dropdown + send */}
          <div className="flex items-center gap-1.5">
            {input.length >= MAX_INPUT_CHARS * 0.8 && (
              <span className={`text-[10px] tabular-nums transition-colors ${
                input.length >= MAX_INPUT_CHARS ? 'text-red-400' : input.length >= MAX_INPUT_CHARS * 0.95 ? 'text-amber-400' : 'text-gray-500'
              }`}>
                {input.length}/{MAX_INPUT_CHARS}
              </span>
            )}

            {/* Build / Plan mode dropdown */}
            <div className="relative" ref={modelMenuRef}>
              <button
                onClick={() => setModelMenuOpen(v => !v)}
                disabled={isGenerating}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium text-white/70 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                <span>{agentMode === 'plan' ? 'Plan' : 'Build'}</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>

              {/* Dropdown — opens upward */}
              {modelMenuOpen && (
                <div className="absolute bottom-full right-0 mb-1.5 bg-[#1c1c20] border border-white/[0.10] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.7)] z-[200] overflow-hidden" style={{ minWidth: 210 }}>
                  <button
                    onClick={() => { setAgentMode('agent'); setModelMenuOpen(false); }}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.05] ${agentMode === 'agent' ? 'text-white' : 'text-white/60'}`}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0 text-indigo-400">{agentMode === 'agent' ? '✓' : ''}</span>
                    <div>
                      <p className="text-[13px] font-semibold leading-none mb-1">Build</p>
                      <p className="text-[11px] text-white/40">Make changes directly</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { setAgentMode('plan'); setModelMenuOpen(false); }}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.05] ${agentMode === 'plan' ? 'text-white' : 'text-white/60'}`}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0 text-indigo-400">{agentMode === 'plan' ? '✓' : ''}</span>
                    <div>
                      <p className="text-[13px] font-semibold leading-none mb-1">Plan</p>
                      <p className="text-[11px] text-white/40">Discuss before building</p>
                    </div>
                  </button>
                  <div className="px-4 py-2 border-t border-white/[0.06]">
                    <span className="text-[11px] text-white/25">Toggle with <kbd className="px-1 py-0.5 rounded bg-white/[0.07] text-white/40 font-mono text-[10px]">Alt</kbd> <kbd className="px-1 py-0.5 rounded bg-white/[0.07] text-white/40 font-mono text-[10px]">P</kbd></span>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => handleSubmit()}
              disabled={(!input.trim() && pendingAttachments.length === 0) || isGenerating || !projectId || input.length > MAX_INPUT_CHARS}
              className="h-7 w-7 flex items-center justify-center rounded-lg
                bg-gradient-to-br from-indigo-500 to-violet-600
                hover:from-indigo-400 hover:to-violet-500
                disabled:from-white/[0.05] disabled:to-white/[0.03] disabled:text-white/15
                text-white
                shadow-[0_2px_12px_rgba(99,102,241,0.30),inset_0_1px_0_rgba(255,255,255,0.15)]
                hover:shadow-[0_4px_16px_rgba(99,102,241,0.45),inset_0_1px_0_rgba(255,255,255,0.15)]
                disabled:shadow-none
                transition-all duration-150"
            >
              {isGenerating
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Send className="w-3 h-3 translate-x-px" />
              }
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
