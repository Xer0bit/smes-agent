// Reads the agent-template folder and injects it as a Supabase-ready file map.
// Only ecg-config.ts is generated dynamically; all other files are read verbatim
// (with {{CSS_VARS}} and {{APP_NAME}} substituted).

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Which physical template directory backs each agent type. 'social' (the
// original MCP-based dashboard) is kept only so pre-existing dashboards of
// that type keep resolving correctly -- new onboarding no longer offers it
// (see EcgConnectWizard.tsx). 'social-v2' (cloud auth + edge functions,
// .scratch/social-template-v2/spec.md) is the default as of 2026-08-11,
// after its end-to-end verification gate passed on production (found and
// fixed a real preview-service auto-repair bug in the process). This
// registry exists so adding another real template later is a one-line
// addition here, not a rewrite of seedEcgTemplate/ecgConfigTs's hardcoded
// single path.
const TEMPLATE_REGISTRY: Record<string, string> = {
  social: path.resolve(__dirname, '../../agent-template'),
  'social-v2': path.resolve(__dirname, '../../social-template'),
};
const DEFAULT_AGENT_TYPE = 'social-v2';

// Non-template dirs excluded from every template walk (seed AND version
// hash). The hash walk previously had no exclusions, so a local
// node_modules under a template dir skewed the local hash away from the
// deployed one (deploys are git-archive, no node_modules).
// 'edge-functions' holds a template's server-side function SOURCE (deployed
// as edge_functions DB rows by seedTemplateEdgeFunctions below, not bundled
// into the built app) -- excluded from the app-file walk for the same
// reason node_modules is.
const WALK_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'coverage', 'edge-functions']);

// Binary assets (logos, banners, icons) can't survive a plain utf8 read --
// mirrors agentLoopService.ts's readFileForSync/BINARY_SENTINEL, the
// established fix for "images vanish/corrupt in transit" (see that file's
// 2026-08-09 fix note). Base64-encode with this sentinel prefix; preview-
// service's materialize.js and the browser's revisionService already decode
// it on the read side, and saveEcgRevision below uploads the sentinel string
// as-is (plain text, no Postgres Unicode issue) -- no other pipeline change
// needed.
const BINARY_EXTS = new Set(['.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4']);
const BINARY_SENTINEL = '__SMEsAgent_BIN64__';

function resolveTemplateDir(agentType?: string): string {
  return TEMPLATE_REGISTRY[agentType ?? DEFAULT_AGENT_TYPE] ?? TEMPLATE_REGISTRY[DEFAULT_AGENT_TYPE];
}

const cachedTemplateHashes = new Map<string, string>();

// A short hash of every file under the resolved template dir, embedded into
// each seeded project's ecg-config.ts as `templateVersion`. Lets a caller
// (see ai.routes.ts) tell "this project's eCG overlay is from an OLDER
// template" apart from "never seeded at all" -- re-seeding a project whose
// files are simply stale, not missing, was the one case the original
// re-seed check (existence-only) couldn't catch: a template update alone
// never reached any project that already had a copy on disk. Cached per
// agent type since each type will eventually have its own template dir/hash.
export function getCurrentTemplateHash(agentType?: string): string {
  const key = agentType ?? DEFAULT_AGENT_TYPE;
  const cached = cachedTemplateHashes.get(key);
  if (cached) return cached;
  const templateDir = resolveTemplateDir(key);
  const hash = crypto.createHash('sha256');
  try {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!WALK_EXCLUDE.has(entry.name)) walk(full); continue; }
        hash.update(path.relative(templateDir, full));
        hash.update(fs.readFileSync(full));
      }
    };
    walk(templateDir);
  } catch {
    return 'unknown';
  }
  const digest = hash.digest('hex').slice(0, 16);
  cachedTemplateHashes.set(key, digest);
  return digest;
}

export interface TemplateOptions {
  orgName: string;
  modules: string[];
  agentIds: string[];
  // Which dashboard template to seed. Optional and currently only 'social'
  // has a real template behind it (see TEMPLATE_REGISTRY) -- every existing
  // caller that omits this keeps seeding the same agent-template/ it always
  // has, unchanged.
  agentType?: string;
  // Display names for the dashboard's agent switcher, keyed by the same IDs
  // as agentIds. Optional so existing callers that only pass agentIds still
  // typecheck; ecgConfigTs() falls back to the bare ID when a name is missing.
  agentNames?: Record<string, string>;
  config: Record<string, unknown>;
  projectId: string;
  proxyUrl: string;
}

interface DesignCfg {
  appName: string;
  logoUrl: string;
  layout: 'sidebar' | 'topnav' | 'minimal';
  theme: string;
  accentColor: string;
  sidebarColor: string;
  bodyColor: string;
  fontFamily: string;
  showSummaryCards: boolean;
  moduleSettings: Record<string, Record<string, boolean | string>>;
}

// Sidebar is a solid, saturated surface, not a near-white panel that blends
// into the body   this single choice is the biggest lever on whether a
// generated dashboard reads as "a real product" vs. a generic admin scaffold.
// EXCEPTION: 'light' deliberately breaks this rule -- redesigned to match
// Buffer's actual chrome (white/near-white sidebar with a subtle border, blue
// accent used sparingly, not a saturated color block) since this platform's
// job -- an agent managing social media -- is the same job Buffer's own UI is
// built around. cssVars() derives sidebar text/hover shades from
// isDark(sidebarColor), so this alone flips the whole sidebar to its light
// variant automatically, no component changes needed.
const THEME_DEFAULTS: Record<string, Pick<DesignCfg, 'accentColor' | 'sidebarColor' | 'bodyColor'>> = {
  light:  { accentColor: '#2C4BFF', sidebarColor: '#fbfbfd', bodyColor: '#ffffff' },
  dark:   { accentColor: '#60a5fa', sidebarColor: '#111827', bodyColor: '#030712' },
  ocean:  { accentColor: '#0ea5c9', sidebarColor: '#0c3d5e', bodyColor: '#eef8fc' },
  forest: { accentColor: '#16a34a', sidebarColor: '#16301f', bodyColor: '#eef8f0' },
  sunset: { accentColor: '#ea580c', sidebarColor: '#6b2810', bodyColor: '#fef3ea' },
  slate:  { accentColor: '#7c3aed', sidebarColor: '#293548', bodyColor: '#f4f5f7' },
};

function resolveDesign(raw: Record<string, unknown>, orgName: string): DesignCfg {
  const themeKey = (raw.theme as string) || 'light';
  const def = THEME_DEFAULTS[themeKey] ?? THEME_DEFAULTS.light;
  return {
    appName:         (raw.appName as string) || orgName,
    logoUrl:         (raw.logoUrl as string) || '',
    layout:          (raw.layout as DesignCfg['layout']) || 'sidebar',
    theme:           themeKey,
    accentColor:     (raw.accentColor as string) || def.accentColor,
    sidebarColor:    (raw.sidebarColor as string) || def.sidebarColor,
    bodyColor:       (raw.bodyColor as string) || def.bodyColor,
    fontFamily:      (raw.fontFamily as string) || 'Inter',
    showSummaryCards: (raw.showSummaryCards as boolean) !== false,
    moduleSettings:  (raw.moduleSettings as DesignCfg['moduleSettings']) || {},
  };
}

// ── OKLCH color math ─────────────────────────────────────────────────────────
// Replaces the old naive sRGB channel-shift approach (subtract N from each of
// r/g/b) -- that distorts hue and desaturates on any saturated input color
// (e.g. shading a vivid orange by "-20 on each channel" pulls it visibly
// toward gray-brown, not a darker orange). OKLCH is a perceptually uniform
// color space: shifting lightness (L) at fixed chroma (C) and hue (H) gives a
// darker/lighter version of the SAME color, which is what "hover state" and
// "muted variant" actually mean. Self-contained (no deps) -- these are the
// standard sRGB<->OKLab<->OKLCH transforms (Björn Ottosson's OKLab).
interface Oklch { l: number; c: number; h: number } // l: 0-1, c: ~0-0.4, h: degrees

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToOklch(hex: string): Oklch {
  const h = hex.replace('#', '');
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16) / 255);

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  const C = Math.sqrt(a * a + bb * bb);
  let H = Math.atan2(bb, a) * (180 / Math.PI);
  if (H < 0) H += 360;
  return { l: L, c: C, h: C < 1e-6 ? 0 : H };
}

function oklchToHex({ l, c, h }: Oklch): string {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const bb = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * bb;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  const r = linearToSrgb(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc);
  const g = linearToSrgb(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc);
  const b = linearToSrgb(-0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc);

  const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/** True perceptual darkness check (OKLCH L), replacing the old sRGB-luma heuristic. */
function isDark(hex: string): boolean {
  return hexToOklch(hex).l < 0.55;
}

/** Shift lightness by `deltaL` (positive = lighter, negative = darker) at fixed chroma/hue -- a true darker/lighter variant of the SAME color, never a desaturated smear. */
function oklchShift(hex: string, deltaL: number): string {
  const { l, c, h } = hexToOklch(hex);
  return oklchToHex({ l: Math.max(0, Math.min(1, l + deltaL)), c, h });
}

/** A neutral gray at lightness `l`, carrying a whisper of the brand hue (chroma ~0.006 -- Linear/Vercel-style "living neutral" instead of a flat, hue-less gray) so the ink scale feels tied to the accent rather than generic. */
function tintedNeutral(hueSource: string, l: number): string {
  const { h } = hexToOklch(hueSource);
  return oklchToHex({ l, c: 0.006, h });
}

function hexToRgb(hex: string): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// Reserved status colors -- fixed brand-independent hues (never derived from
// the org's theme/accent), so "success" always reads as green and "danger"
// always reads as red regardless of what accent color the org picked. Two
// pairs (light body / dark body) since a flat #16a34a green is too dark to
// read comfortably on a near-black dark-mode card.
const STATUS_LIGHT = { success: '#16a34a', warning: '#d97706', danger: '#dc2626' };
const STATUS_DARK  = { success: '#4ade80', warning: '#fbbf24', danger: '#f87171' };

function cssVars(d: DesignCfg): string {
  const bodyIsDark    = isDark(d.bodyColor);
  const sidebarIsDark = isDark(d.sidebarColor);
  const status = bodyIsDark ? STATUS_DARK : STATUS_LIGHT;

  const sidebarText  = tintedNeutral(d.sidebarColor, sidebarIsDark ? 0.95 : 0.20);
  const sidebarMuted = tintedNeutral(d.sidebarColor, sidebarIsDark ? 0.68 : 0.46);
  const sidebarHover = oklchShift(d.sidebarColor, sidebarIsDark ? 0.05 : -0.05);

  const accentBg     = `${d.accentColor}1a`;
  const accentBgHover = `${d.accentColor}29`;
  const accentRgb    = hexToRgb(d.accentColor);
  const accentHover  = oklchShift(d.accentColor, bodyIsDark ? 0.1 : -0.1);

  const cardBg  = tintedNeutral(d.accentColor, bodyIsDark ? 0.22 : 1.0);
  const inputBg = tintedNeutral(d.accentColor, bodyIsDark ? 0.16 : 1.0);
  const border  = tintedNeutral(d.accentColor, bodyIsDark ? 0.32 : 0.91);

  // Ink scale: four steps of hierarchy, hue-tied to the accent (a "living
  // neutral" -- Linear/Vercel-style subtly warm/cool grays instead of flat
  // #64748b-everywhere) so text never looks like it belongs to a different
  // product than the accent color does. --text/--muted stay as aliases for
  // every existing component already written against those two names.
  const ink1 = tintedNeutral(d.accentColor, bodyIsDark ? 0.96 : 0.17); // primary text
  const ink2 = tintedNeutral(d.accentColor, bodyIsDark ? 0.82 : 0.32); // secondary text
  const ink3 = tintedNeutral(d.accentColor, bodyIsDark ? 0.64 : 0.47); // muted/tertiary
  const ink4 = tintedNeutral(d.accentColor, bodyIsDark ? 0.46 : 0.65); // disabled/placeholder

  return `:root {
  /* Brand */
  --accent: ${d.accentColor};
  --accent-rgb: ${accentRgb};
  --accent-bg: ${accentBg};
  --accent-bg-hover: ${accentBgHover};
  --accent-hover: ${accentHover};
  --accent-gradient: linear-gradient(135deg, ${d.accentColor}, ${accentHover});

  /* Sidebar */
  --sidebar-bg: ${d.sidebarColor};
  --sidebar-text: ${sidebarText};
  --sidebar-muted: ${sidebarMuted};
  --sidebar-hover: ${sidebarHover};

  /* Surfaces */
  --body-bg: ${d.bodyColor};
  --card-bg: ${cardBg};
  --input-bg: ${inputBg};
  --border: ${border};

  /* Ink scale (text hierarchy) */
  --ink-1: ${ink1};
  --ink-2: ${ink2};
  --ink-3: ${ink3};
  --ink-4: ${ink4};
  --text: var(--ink-1);
  --muted: var(--ink-3);

  /* Status (reserved, brand-independent) */
  --success: ${status.success};
  --success-bg: ${status.success}1a;
  --warning: ${status.warning};
  --warning-bg: ${status.warning}1a;
  --danger: ${status.danger};
  --danger-bg: ${status.danger}1a;

  /* Radius */
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --radius-full: 999px;

  /* Shadow -- resting state carries real depth (a card should read as a
     raised surface at a glance, not a bordered rectangle); hover/lg steps up
     from there. */
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.03), 0 6px 16px -10px rgba(15, 23, 42, 0.14);
  --shadow-md: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 24px -12px rgba(15, 23, 42, 0.18);
  --shadow-lg: 0 4px 6px rgba(15, 23, 42, 0.05), 0 20px 40px -16px rgba(15, 23, 42, 0.24);
  --shadow-accent: 0 8px 20px -8px rgba(${accentRgb}, 0.35);
  --table-row-hover: rgba(${accentRgb}, 0.06);

  /* Spacing (4pt scale) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  /* Type scale */
  --text-tiny: 0.6875rem;
  --text-small: 0.8125rem;
  --text-body: 0.9375rem;
  --text-lg: 1.0625rem;
  --text-h3: 1.25rem;
  --text-h2: 1.625rem;
  --text-h1: 2rem;
  --text-display: 2.5rem;
  --leading-tight: 1.2;
  --leading-normal: 1.5;
  --leading-relaxed: 1.6;
  --tracking-tight: -0.01em;
  --tracking-normal: 0em;
  --tracking-wide: 0.02em;
  --font-weight-heading: 600;

  /* Motion */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --duration-fast: 120ms;
  --duration-base: 180ms;
  --duration-slow: 280ms;
}`;
}

function ecgConfigTs(
  d: DesignCfg,
  modules: string[],
  projectId: string,
  proxyUrl: string,
  agentIds: string[],
  agentNames: Record<string, string>,
  agentType?: string,
): string {
  const ALL_MODULES = ['agents', 'schedulers', 'posts', 'connectors', 'runs', 'knowledge'];
  const mods = modules.length > 0 ? modules : ALL_MODULES;
  // Falls back to the bare ID as its own label when a name wasn't supplied,
  // so the switcher never shows a blank entry.
  const names: Record<string, string> = Object.fromEntries(agentIds.map((id) => [id, agentNames[id] ?? id]));
  return `// Auto-generated by App Builder   do not edit manually.
export const ECG = {
  templateVersion: ${JSON.stringify(getCurrentTemplateHash(agentType))},
  appName: ${JSON.stringify(d.appName)},
  logoUrl: ${JSON.stringify(d.logoUrl)},
  layout: ${JSON.stringify(d.layout)} as 'sidebar' | 'topnav' | 'minimal',
  modules: ${JSON.stringify(mods)} as string[],
  showSummaryCards: ${d.showSummaryCards},
  accentColor: ${JSON.stringify(d.accentColor)},
  fontFamily: ${JSON.stringify(d.fontFamily)},
  proxyUrl: ${JSON.stringify(proxyUrl)},
  projectId: ${JSON.stringify(projectId)},
  moduleSettings: ${JSON.stringify(d.moduleSettings)} as Record<string, Record<string, boolean | string>>,
  // Which eCG agent(s) this dashboard manages -- agentIds[0] is the default
  // active agent; the in-dashboard switcher (Layout.tsx) lets the user pick
  // a different one when there's more than one. See ecgClient.ts's
  // getActiveAgentId()/setActiveAgentId().
  agentIds: ${JSON.stringify(agentIds)} as string[],
  agentNames: ${JSON.stringify(names)} as Record<string, string>,
  activeAgentId: ${JSON.stringify(agentIds[0] ?? null)} as string | null,
};
`;
}

/** Read all files from agent-template/, substitute placeholders, return file map. */
export function seedEcgTemplate(
  projectDir: string,
  opts: TemplateOptions,
): Record<string, string> {
  const design = resolveDesign(opts.config, opts.orgName);
  const vars   = cssVars(design);
  const agentNames = opts.agentNames ?? {};
  const templateDir = resolveTemplateDir(opts.agentType);
  const files: Record<string, string> = {};

  // Walk template directory (WALK_EXCLUDE at module scope, shared with the
  // version-hash walk).
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && WALK_EXCLUDE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.test\.[jt]sx?$/.test(entry.name)) continue;
      const rel  = path.relative(templateDir, full);
      if (BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files[rel] = `${BINARY_SENTINEL}${fs.readFileSync(full).toString('base64')}`;
        continue;
      }
      let content = fs.readFileSync(full, 'utf8');
      // Substitute placeholders. replaceAll, not replace: string-pattern
      // replace() hits only the FIRST occurrence, which shipped a literal
      // "{{FONT_FAMILY}}" in every seeded site's font fallback chain and
      // would leave 5 of index.html's 6 {{APP_NAME}} slots unsubstituted.
      content = content.replaceAll('{{CSS_VARS}}', vars);
      content = content.replaceAll('{{APP_NAME}}', design.appName);
      content = content.replaceAll('{{FONT_FAMILY}}', design.fontFamily);
      content = content.replaceAll('{{FONT_FAMILY_URL}}', design.fontFamily.replace(/ /g, '+'));
      content = content.replaceAll('{{LOGO_URL}}', design.logoUrl);
      files[rel] = content;
    }
  }

  try {
    walk(templateDir);
  } catch (e) {
    // Template dir missing in dev   emit minimal stub
    files['src/ecg-config.ts'] = ecgConfigTs(design, opts.modules, opts.projectId, opts.proxyUrl, opts.agentIds, agentNames, opts.agentType);
    return files;
  }

  // Inject the generated config (overrides any placeholder in template)
  files['src/ecg-config.ts'] = ecgConfigTs(design, opts.modules, opts.projectId, opts.proxyUrl, opts.agentIds, agentNames, opts.agentType);

  // Write to disk (VPS3 local path)   non-fatal
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(projectDir, rel);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    } catch { /* non-fatal */ }
  }

  return files;
}

// Reads a template's edge-functions/*.js -- server-side function SOURCE,
// deployed as edge_functions DB rows (see ecg-dev-agent.routes.ts's seed
// step), never bundled into the built app. Returns {} for templates with no
// edge-functions dir (e.g. 'social' today).
export function loadTemplateEdgeFunctions(agentType?: string): Record<string, string> {
  const dir = path.join(resolveTemplateDir(agentType), 'edge-functions');
  const out: Record<string, string> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  } catch {
    return out;
  }
  for (const file of entries) {
    out[file.replace(/\.js$/, '')] = fs.readFileSync(path.join(dir, file), 'utf8');
  }
  return out;
}
