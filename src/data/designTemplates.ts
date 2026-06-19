/**
 * Design templates — curated design system prompts from real-world sites.
 * Each template's `prompt` is the full design.md that gets passed to the agent
 * when creating a project from this template.
 *
 * The prompt includes a mandatory file scaffold that tells the agent EXACTLY
 * which files to create and in what order. This prevents the #1 class of
 * agent bugs: broken imports from files that don't exist or are named wrong.
 */

export interface TemplateQuestion {
  id: string;
  label: string;
  placeholder: string;
  /** Pre-filled default value so user can just tweak */
  defaultValue?: string;
}

export interface DesignTemplate {
  id: string;
  name: string;
  tag: string;
  /** Brief one-liner shown on cards */
  description: string;
  /** Accent color for the card preview */
  accent: string;
  /** Foreground/text color for the card preview */
  fg: string;
  /** Path to the preview image in /public */
  image: string;
  /** The full design.md prompt passed to the agent */
  prompt: string;
  /** Questions asked after template selection to customise the build */
  questions: TemplateQuestion[];
}

/* ─── helper: assemble the final prompt from design system + user answers ─── */

export function buildTemplatePrompt(
  tpl: DesignTemplate,
  answers: Record<string, string>,
): string {
  const businessName = answers.business?.trim() || 'a modern web application';
  const rawPages     = answers.pages?.trim() || 'Home, About, Contact';
  const extras       = answers.tone?.trim() || '';

  // Normalise page list into safe identifiers
  const pages = rawPages
    .split(/[,\n]+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(name => {
      const id = name.replace(/[^a-zA-Z0-9]/g, '');
      return { name, id, file: 'src/pages/' + id + '.tsx' };
    });

  const routeEntries = pages
    .map(p => p.id === 'Home'
      ? '  <Route path="/" element={<' + p.id + ' />} />'
      : '  <Route path="/' + p.id.toLowerCase() + '" element={<' + p.id + ' />} />')
    .join('\n');

  const routeImports = pages
    .map(p => 'import ' + p.id + ' from "./pages/' + p.id + '";')
    .join('\n');

  const pageFileList = pages
    .map(p => '   - ' + p.file + '  (the "' + p.name + '" page)')
    .join('\n');

  const appTsxCode = [
    'import { HashRouter, Routes, Route } from "react-router-dom";',
    routeImports,
    'import Header from "./components/Header";',
    'import Footer from "./components/Footer";',
    'import "./App.css";',
    '',
    'export default function App() {',
    '  return (',
    '    <HashRouter>',
    '      <Header />',
    '      <Routes>',
    routeEntries,
    '      </Routes>',
    '      <Footer />',
    '    </HashRouter>',
    '  );',
    '}',
  ].join('\n');

  const scaffold = [
    '',
    '',
    '# MANDATORY File Scaffold (follow EXACTLY — do not rename or skip files)',
    '',
    '## Required dependencies',
    'Add these with `add_dependency` BEFORE writing any file that imports them:',
    '- react-router-dom',
    '',
    '## File creation order (create files in this exact sequence)',
    '',
    '1. Shared UI components first:',
    '   - src/components/Header.tsx  (navigation bar with links to all pages)',
    '   - src/components/Footer.tsx  (site footer)',
    '',
    '2. Page components (one per page):',
    pageFileList,
    '',
    '3. App entry LAST (imports all pages + routes):',
    '   - src/App.tsx',
    '   - src/App.css',
    '',
    '## src/App.tsx MUST use this exact structure:',
    '',
    '```tsx',
    appTsxCode,
    '```',
    '',
    '## Rules',
    '- Every page component MUST use `export default function PageName()` (default export).',
    '- Every import path MUST match a file you already created ABOVE it in the sequence.',
    '- Use @/ alias (configured in vite.config) for deep imports: `import X from "@/components/X"`.',
    '- Do NOT create files not listed above unless absolutely necessary (e.g. a shared data file).',
    '- Do NOT use `BrowserRouter` — use `HashRouter` (preview runs in an iframe without server routing).',
    '- Call `get_build_errors` after writing ALL files. Fix any errors before finishing.',
  ].join('\n');

  const userReqs = [
    '- Business: ' + businessName,
    extras ? '- Style / features: ' + extras : '',
    '- Pages: ' + rawPages,
  ].filter(Boolean).join('\n');

  return tpl.prompt + scaffold + '\n\n## User Requirements\n' + userReqs +
    '\n\nBuild the complete site now. Follow the file scaffold exactly. Write shared components first, then pages, then App.tsx last.';
}

export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    tag: "SaaS · Voice AI · Clean",
    description: "Near-white canvas with warm undertones, whisper-thin typography, and multi-layered shadows.",
    accent: "#f5f2ef",
    fg: "#1a1a1a",
    image: "/assets/templates/elevenlabs.png",
    prompt: `Use the following design system to build this website. Follow the typography, color palette, component styles, and spacing exactly as described.

# Design System Inspired by ElevenLabs

## Visual Theme
Near-white canvas (#ffffff, #f5f5f5) with warm stone undertones (#f5f2ef). Typography-driven with subtle multi-layered shadows. Apple-like whitespace but warmer.

## Typography
- Display: Waldenburg weight 300 (light) for ethereal, whisper-thin headings at 48px, line-height 1.08, letter-spacing -0.96px
- Body: Inter 16-18px, weight 400, letter-spacing +0.14-0.18px for airy readability
- Buttons: Inter 15px weight 500, or WaldenburgFH 14px bold uppercase with 0.7px tracking

## Color Palette
- Background: #ffffff, #f5f5f5, #f5f2ef (warm stone)
- Text: #000000 primary, #4e4e4e secondary, #777169 tertiary
- Borders: rgba(0,0,0,0.05) ultra-subtle
- Shadows: Multi-layered at sub-0.1 opacity with warm tints rgba(78,50,23,0.04)

## Components
- Pill buttons (border-radius: 9999px) with warm stone backgrounds
- Primary: #000 bg, #fff text, pill shape
- Secondary: #fff bg, shadow-bordered, pill shape
- Cards with multi-layered shadow stacks: inset 0.5px borders + outline rings + soft elevation
- Full-round (9999px) for pills, tags, toggles

## Spacing
8px base grid. Generous whitespace. Section padding 64-96px.`,
    questions: [
      { id: 'business', label: 'What is your product or business?', placeholder: 'e.g. AI voice cloning platform, design studio...' },
      { id: 'pages', label: 'What pages do you need?', placeholder: 'e.g. Home, Pricing, About, Blog', defaultValue: 'Home, Features, Pricing, About, Contact' },
      { id: 'tone', label: 'Any specific feel or features?', placeholder: 'e.g. Minimalist, include testimonials section...' },
    ],
  },
  {
    id: "nike",
    name: "Nike",
    tag: "E-commerce · Athletic · Bold",
    description: "Monochromatic UI with massive uppercase headlines and full-bleed hero photography.",
    accent: "#111111",
    fg: "#ffffff",
    image: "/assets/templates/nike.png",
    prompt: `Use the following design system to build this website. Follow the typography, color palette, component styles, and spacing exactly as described.

# Design System Inspired by Nike

## Visual Theme
Monochromatic (black/white/grey) retail cathedral. UI disappears to let product photography dominate. Aggressively minimal — product is the only color source.

## Typography
- Display: Condensed sans-serif (Futura-style), uppercase, 96px, weight 700-900, line-height 0.90, tight tracking
- Headings: Helvetica Now Display Medium, 24-32px
- Body: Helvetica Now Text, 16px weight 400, line-height 1.5
- Body Medium: weight 500 for links, buttons, nav

## Color Palette
- Primary: #111111 (Nike Black), #FFFFFF
- Surfaces: #FAFAFA, #F5F5F5, #E5E5E5
- Dark surfaces: #28282A, #1F1F21
- Text: #111111 primary, #707072 secondary, #9E9EA0 disabled
- Semantic: #D30005 red, #007D48 green, #1151FF blue, #FF5000 orange
- Borders: #CACACB secondary, #111111 active

## Components
- Pill buttons (30px radius) — primary: #111 bg, #fff text
- Full-bleed imagery with NO border radius — edges fill completely
- No shadows, no gradients — surface differentiation through grey shifts only
- Category cards: large image + text overlay
- Clean product grid: image + name + price, minimal ornamentation

## Spacing
8px grid. Aggressive use of whitespace. Hero sections are full-viewport. Product grids: 16-24px gaps.`,
    questions: [
      { id: 'business', label: 'What products or brand is this for?', placeholder: 'e.g. Running shoes, sportswear brand, fitness app...' },
      { id: 'pages', label: 'What pages do you need?', placeholder: 'e.g. Home, Shop, Product detail, Cart', defaultValue: 'Home, Products, About, Contact' },
      { id: 'tone', label: 'Anything specific to include?', placeholder: 'e.g. Hero with video, product grid, athlete testimonials...' },
    ],
  },
  {
    id: "mintlify",
    name: "Mintlify",
    tag: "Docs · Developer · Dark",
    description: "Dark atmospheric hero with green accent, documentation-focused layout, ultra-round corners.",
    accent: "#0d1117",
    fg: "#18E299",
    image: "/assets/templates/mintlify.png",
    prompt: `Use the following design system to build this website. Follow the typography, color palette, component styles, and spacing exactly as described.

# Design System Inspired by Mintlify

## Visual Theme
Documentation-as-product. White airy surface with dark atmospheric hero section. Green brand accent (#18E299). Calm, confident, engineered for legibility. Cloud-like gradient hero transitioning to clean white sections.

## Typography
- Display: Inter 64px, weight 600, line-height 1.15, letter-spacing -1.28px — compressed hero headlines
- Section Heading: Inter 40px, weight 600, tracking -0.8px
- Body: Inter 16-18px, weight 400, line-height 1.5
- Code/Labels: Geist Mono 12px, weight 500, uppercase, letter-spacing 0.6px
- Three weights only: 400 (body), 500 (UI/nav), 600 (headings)

## Color Palette
- Primary: #0d0d0d text, #ffffff background, #18E299 brand green accent
- Green variants: #d4fae8 light, #0fa76e deep
- Neutrals: #333333, #666666, #888888, #e5e5e5, #f5f5f5
- Borders: rgba(0,0,0,0.05) subtle, rgba(0,0,0,0.08) medium
- Shadows: Barely-there — rgba(0,0,0,0.03) for ambient lift

## Components
- Full-round buttons (9999px): #0d0d0d bg, #fff text for primary CTA
- Ghost buttons: transparent bg, #0d0d0d text, 1px border
- Cards: white bg, 16-24px border-radius, whisper-thin borders, generous 24px+ padding
- Badges: green-tinted background, Geist Mono uppercase
- Atmospheric gradient hero: dark with green-to-transparent wash

## Spacing
8px base grid. Section padding 48-96px. Generous card padding 24px+.`,
    questions: [
      { id: 'business', label: 'What is the product or tool?', placeholder: 'e.g. API documentation platform, developer SDK...' },
      { id: 'pages', label: 'What sections do you need?', placeholder: 'e.g. Docs, Getting started, API reference, Changelog', defaultValue: 'Home, Docs, Pricing, Contact' },
      { id: 'tone', label: 'Any special requirements?', placeholder: 'e.g. Code examples, interactive playground, search...' },
    ],
  },
  {
    id: "xai",
    name: "xAI / Grok",
    tag: "AI · Dark · Brutalist",
    description: "Dark-first monospace-driven brutalist minimalism with extreme scale typography.",
    accent: "#1f2228",
    fg: "#ffffff",
    image: "/assets/templates/xai.png",
    prompt: `Use the following design system to build this website. Follow the typography, color palette, component styles, and spacing exactly as described.

# Design System Inspired by xAI

## Visual Theme
Dark-first brutalist minimalism. Almost-black background (#1f2228), pure white text. Terminal-inspired, high-contrast. Zero decorative elements — no shadows, no gradients, no colored accents. Communicates through absence.

## Typography
- Display: Monospace font at extreme sizes (up to 320px), weight 300 — monospace as luxury
- Section Heading: Clean sans-serif, 30px, weight 400, line-height 1.2
- Body: Sans-serif 16px, weight 400, line-height 1.5
- Buttons: Monospace 14px, weight 400, UPPERCASE, letter-spacing 1.4px — commanding, technical
- Two-font clarity: monospace for impact + interaction, sans-serif for reading

## Color Palette
- Background: #1f2228 (warm near-black with subtle blue undertone)
- Text: #ffffff primary, rgba(255,255,255,0.7) secondary, rgba(255,255,255,0.5) muted
- Interactive: rgba(255,255,255,0.5) for hover (dimming, not brightening)
- Surfaces: rgba(255,255,255,0.05) elevated, rgba(255,255,255,0.08) hover
- Borders: rgba(255,255,255,0.1) default, rgba(255,255,255,0.2) strong
- No color accents in UI

## Components
- Primary button: #fff bg, #1f2228 text, 0px radius (sharp corners), monospace uppercase
- Ghost button: transparent bg, #fff text, 1px border rgba(255,255,255,0.2), sharp corners
- Cards: transparent or rgba(255,255,255,0.03), sharp edges, minimal borders
- No shadows, no gradients, no rounded corners

## Spacing
8px base grid. Sparse, deliberate scale (4, 8, 24, 48px). Dense, information-focused.`,
    questions: [
      { id: 'business', label: 'What is your AI product or project?', placeholder: 'e.g. LLM chat interface, AI research lab, data platform...' },
      { id: 'pages', label: 'What pages do you need?', placeholder: 'e.g. Home, Features, API, Pricing', defaultValue: 'Home, Features, Pricing, About' },
      { id: 'tone', label: 'Anything specific to highlight?', placeholder: 'e.g. Live demo, model benchmarks, dark terminal feel...' },
    ],
  },
];
