// Reads the agent-template folder and injects it as a Supabase-ready file map.
// Only ecg-config.ts is generated dynamically; all other files are read verbatim
// (with {{CSS_VARS}} and {{APP_NAME}} substituted).

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Which physical template directory backs each agent type. Only 'social' is
// real today -- every other agent-portal category (bookkeeping, sales,
// support, business-dev, email) is a DB placeholder with no dashboard
// template built yet (see the Phase 2 plan). This registry exists so adding
// a second real template later is a one-line addition here, not a rewrite
// of seedEcgTemplate/ecgConfigTs's hardcoded single path.
const TEMPLATE_REGISTRY: Record<string, string> = {
  social: path.resolve(__dirname, '../../agent-template'),
};
const DEFAULT_AGENT_TYPE = 'social';

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
        if (entry.isDirectory()) { walk(full); continue; }
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
const THEME_DEFAULTS: Record<string, Pick<DesignCfg, 'accentColor' | 'sidebarColor' | 'bodyColor'>> = {
  light:  { accentColor: '#2563eb', sidebarColor: '#161c3d', bodyColor: '#f4f5f7' },
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

function isDark(hex: string): boolean {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// Shifts a hex color darker (positive amount) or lighter (negative), clamped to 0-255.
function shade(hex: string, amount: number): string {
  const c = hex.replace('#', '');
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const r = clamp(parseInt(c.slice(0, 2), 16) - amount);
  const g = clamp(parseInt(c.slice(2, 4), 16) - amount);
  const b = clamp(parseInt(c.slice(4, 6), 16) - amount);
  return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function cssVars(d: DesignCfg): string {
  const sidebarText  = isDark(d.sidebarColor) ? '#f1f5f9' : '#1e293b';
  const sidebarMuted = isDark(d.sidebarColor) ? '#94a3b8' : '#64748b';
  const accentBg     = `${d.accentColor}1a`;
  const accentRgb    = hexToRgb(d.accentColor);
  const accentHover  = shade(d.accentColor, isDark(d.bodyColor) ? -20 : 20);
  const sidebarHover = shade(d.sidebarColor, isDark(d.sidebarColor) ? -12 : 12);
  const cardBg       = isDark(d.bodyColor) ? '#1e293b' : '#ffffff';
  const inputBg      = isDark(d.bodyColor) ? '#0f172a' : '#ffffff';
  const border       = isDark(d.bodyColor) ? '#293548' : '#e8ebef';
  const text         = isDark(d.bodyColor) ? '#f1f5f9' : '#1e293b';
  const muted        = isDark(d.bodyColor) ? '#94a3b8' : '#64748b';
  return `:root {
  --accent: ${d.accentColor};
  --accent-bg: ${accentBg};
  --accent-hover: ${accentHover};
  --sidebar-bg: ${d.sidebarColor};
  --sidebar-text: ${sidebarText};
  --sidebar-muted: ${sidebarMuted};
  --sidebar-hover: ${sidebarHover};
  --body-bg: ${d.bodyColor};
  --card-bg: ${cardBg};
  --input-bg: ${inputBg};
  --border: ${border};
  --text: ${text};
  --muted: ${muted};
  --radius: 12px;
  --radius-sm: 8px;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-md: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 24px -12px rgba(15, 23, 42, 0.16);
  --shadow-accent: 0 8px 20px -8px rgba(${accentRgb}, 0.35);
  --font-weight-heading: 600;
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

  // Walk template directory
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel  = path.relative(templateDir, full);
      let content = fs.readFileSync(full, 'utf8');
      // Substitute placeholders
      content = content.replace('{{CSS_VARS}}', vars);
      content = content.replace('{{APP_NAME}}', design.appName);
      content = content.replace('{{FONT_FAMILY}}', design.fontFamily);
      content = content.replace('{{FONT_FAMILY_URL}}', design.fontFamily.replace(/ /g, '+'));
      content = content.replace('{{LOGO_URL}}', design.logoUrl);
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
