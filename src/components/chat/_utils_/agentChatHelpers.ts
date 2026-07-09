import type { ChatAttachment } from '@/services/chatAttachmentService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolActivity {
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency' | 'command';
  label: string;
}

/** One entry in the persistent step-by-step history shown alongside the live status line. */
export interface StepEntry {
  type: ToolActivity['type'] | 'status';
  label: string;
  done: boolean;
}

/** A file being actively written/edited during streaming */
export interface LiveFileChange {
  path: string;
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency';
  timestamp: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  isPlan?: boolean;
  /** True when the agent replied without writing/deleting any files (ghostRun) and it wasn't a confirm-first ask */
  noChanges?: boolean;
  summary?: string;
  toolActivities?: ToolActivity[];
  /** Step-by-step history of the run (file ops + narrative steps) — not persisted, live-session only. */
  steps?: StepEntry[];
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
export function extractSummary(content: string): { body: string; summary?: string } {
  const match = content.match(/<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/i);
  if (!match) return { body: content };
  return {
    body: content.replace(match[0], '').trim(),
    summary: match[1].trim(),
  };
}



// Parse all COMPLETED tool calls from raw agent output, deduplicating by path.
export function parseToolActivities(raw: string): ToolActivity[] {
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

/**
 * Build a readable summary from tool activities when the agent produced no
 * prose of its own. Reads like a short human sentence ("Updated the header,
 * sign-up, and about pages.") rather than a raw file-change log.
 */
export function buildFallbackSummary(activities: ToolActivity[]): string {
  const fileActs = activities.filter(a => ['write', 'edit', 'delete', 'rename'].includes(a.type));
  if (fileActs.length === 0) return '';

  const writes = fileActs.filter(a => a.type === 'write').length;
  const edits  = fileActs.filter(a => a.type === 'edit').length;
  const verb   = writes > 0 && edits === 0 ? 'Added' : 'Updated';

  const labels = Array.from(new Set(fileActs.map(a =>
    a.type === 'rename' ? a.label : filePathToLabel(a.label)
  )));

  const MAX = 4;
  const shown = labels.slice(0, MAX);
  const extra = labels.length - MAX;
  const list = extra > 0
    ? `${shown.join(', ')}, and ${extra} more`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
      : shown[0];

  return `${verb} ${list}.`;
}

// Return a human-readable live status for the tool currently being streamed.
// Returns null when no tool is mid-flight.
export function detectLiveTool(raw: string): string | null {
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
export function parseCommandSuggestions(raw: string): string[] {
  const cmds: string[] = [];
  for (const m of raw.matchAll(/<(?:ecomgear|egear)-command[^>]*\btype="([^"]+)"/gi))
    if (!cmds.includes(m[1])) cmds.push(m[1]);
  return cmds;
}

/** @deprecated Replaced by Gemini-generated suggestions from /api/v1/ai/suggestions */
export function generateFollowUpSuggestions(filePaths: string[], summaryText: string): string[] {
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
export function stripEcomgearTags(raw: string): string {
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
export function filePathToLabel(filePath: string): string {
  const base = filePath.replace(/\.[^.]+$/, '').split('/').pop() ?? filePath;
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  if (words.startsWith('use ')) return words.replace('use ', '') + (words.endsWith(' hook') ? '' : ' hook');
  // Avoid doubling up when the filename already ends with the directory's
  // implied word (e.g. AboutPage.tsx in /pages/ → "about page", not "about page page").
  if (filePath.includes('/pages/')) return words.endsWith(' page') ? words : words + ' page';
  if (filePath.includes('/components/')) return words.endsWith(' component') ? words : words + ' component';
  if (filePath.includes('/hooks/')) return words.endsWith(' hook') ? words : words + ' hook';
  if (filePath.includes('/lib/') || filePath.includes('/utils/')) return words;
  if (base === 'App') return 'app shell';
  if (base === 'main') return 'app entry';
  return words;
}
