/**
 * Starter blueprints: curated, category-specific build guides the agent
 * follows when a project is started from Dashboard → Templates.
 *
 * A blueprint is not code. It is (1) a pinned stack, (2) the page map,
 * (3) design rules distilled from the best open-source references in that
 * category, and (4) a first prompt. On start the rules become the project's
 * first knowledge note, so every run reads them and the owner can edit or
 * delete them in Settings → Knowledge.
 *
 * References the rules were distilled from: shadcn-admin (collapsible
 * sidebar, Cmd+K, data tables), Twenty and Refine CRM (pipeline kanban,
 * records with activity timelines), ERPNext (module home, list/form/report
 * triad), react-three-fiber + drei starters, KaTeX for math typesetting.
 */
export interface Blueprint {
  id: string;
  name: string;
  category: string;
  tagline: string;
  description: string;
  /** Tailwind gradient classes for the card. */
  accent: string;
  /** npm packages beyond the scaffold the agent should install first. */
  stack: string[];
  pages: string[];
  rules: string[];
  starterPrompt: string;
}

const SHARED_RULES = [
  'Use the Vite + React + TypeScript scaffold with Tailwind. Put shared UI in src/components, pages in src/pages, data hooks in src/hooks, and route everything from src/App.tsx.',
  'Every list gets an empty state, a loading skeleton, and an error state. Never ship a page that renders a blank area while data loads.',
  'Persist real data in the eCG Cloud database; put writes and auth behind edge functions. Never fake persistence with localStorage.',
  'Mobile first: every layout must work at 375px before it is widened. Sidebars collapse to a sheet on small screens.',
];

export const BLUEPRINTS: Blueprint[] = [
  {
    id: 'admin-dashboard',
    name: 'Admin dashboard',
    category: 'Admin dashboard',
    tagline: 'Sidebar, command palette, data tables, KPIs.',
    description: 'The shadcn-admin shape: collapsible sidebar, Cmd+K search, KPI cards with sparklines, sortable and filterable tables, settings pages.',
    accent: 'from-slate-800 via-slate-700 to-teal-600',
    stack: ['@tanstack/react-table', 'recharts', 'cmdk', 'date-fns', 'zustand'],
    pages: ['/ (overview: 4 KPI cards, revenue chart, recent activity table)', '/users (table with search, filter chips, row actions)', '/orders', '/analytics', '/settings (profile, team, billing tabs)'],
    rules: [
      'Layout: 240px collapsible sidebar (icons only at 64px) + top bar with breadcrumb, global search (Cmd+K via cmdk) and user menu. Content max-width 1400px, 24px padding.',
      'Data tables use @tanstack/react-table with column sorting, text filter, pagination (10/25/50), row selection and a right-aligned actions menu. Sticky header, zebra rows off, 40px rows.',
      'KPI card: label (12px muted), value (28px semibold, tabular-nums), delta chip (green up / red down) and a 40px sparkline (recharts). Four in a row on desktop, two on tablet, one on mobile.',
      'Charts: recharts with muted grid lines, no 3D, no gradients heavier than 15% alpha. One accent colour per chart.',
      'Dark and light theme from CSS variables in :root and .dark; never hardcode hex in components.',
      'Density: 14px base text, 8px spacing grid, rounded-lg (8px) cards with 1px borders, no drop shadows heavier than shadow-sm.',
    ],
    starterPrompt: 'Build the admin dashboard from the blueprint: overview page with four KPI cards and a revenue chart, a users table with search, filters and pagination, an orders page, and a settings page with profile and team tabs. Use a collapsible sidebar and a Cmd+K command palette. Seed realistic demo data in the database.',
  },
  {
    id: 'erp-suite',
    name: 'ERP suite',
    category: 'ERP',
    tagline: 'Modules, list → form → report, approvals.',
    description: 'ERPNext-style business system: module home, the list / form / report triad for every document type, status workflows and approvals, printable documents.',
    accent: 'from-zinc-900 via-blue-900 to-indigo-600',
    stack: ['@tanstack/react-table', 'react-hook-form', 'zod', 'recharts', 'date-fns'],
    pages: ['/ (module home: Sales, Purchasing, Inventory, Accounting, HR tiles with counts)', '/sales/quotations, /sales/orders, /sales/invoices', '/purchasing/orders, /purchasing/suppliers', '/inventory/items, /inventory/stock, /inventory/warehouses', '/accounting/ledger, /accounting/reports', '/hr/employees, /hr/leave', '/settings/company, /settings/roles'],
    rules: [
      'Every document type follows the triad: a List view (table, saved filters, bulk actions), a Form view (sections, line-item grid, status bar, Save / Submit / Cancel), and a Report view (grouped totals, date range, export CSV).',
      'Documents have a status workflow: Draft → Submitted → Approved/Rejected → Completed/Cancelled. Show the status as a coloured pill and a timeline of transitions with who and when.',
      'Line-item grids (order lines, invoice lines) are editable tables with add/remove rows, quantity × rate = amount, and a totals footer (subtotal, tax, grand total).',
      'Master data (items, customers, suppliers, employees) lives in its own tables with codes (ITEM-0001), and every transactional document references masters by id.',
      'Roles: admin, manager, clerk. Approve/Submit buttons appear only for roles allowed by the workflow; enforce the same rule in the edge function.',
      'Print view: a clean A4 layout for orders and invoices with company header, line items and totals; hide navigation with print styles.',
      'Navigation: module sidebar with collapsible groups; module home shows tiles with open-document counts pulled live from the database.',
    ],
    starterPrompt: 'Build the ERP suite from the blueprint. Start with master data (items, customers, suppliers, employees), then Sales Orders with the list / form / report triad and the Draft → Submitted → Approved workflow, then Inventory stock levels that update when an order is submitted. Seed demo masters and 20 orders.',
  },
  {
    id: 'crm',
    name: 'CRM',
    category: 'CRM',
    tagline: 'Pipeline kanban, contacts, companies, activity timeline.',
    description: 'Twenty / Refine style CRM: deals on a drag-and-drop pipeline, contact and company records with an activity timeline, tasks and notes, email-ready.',
    accent: 'from-fuchsia-900 via-purple-800 to-violet-600',
    stack: ['@dnd-kit/core', '@dnd-kit/sortable', '@tanstack/react-table', 'react-hook-form', 'zod', 'date-fns', 'recharts'],
    pages: ['/ (today: tasks due, deals closing this week, pipeline value)', '/pipeline (kanban by stage: Lead, Qualified, Proposal, Negotiation, Won, Lost)', '/contacts (table + record page)', '/companies (table + record page)', '/deals/:id (record with timeline)', '/tasks', '/settings/pipeline (rename stages, probabilities)'],
    rules: [
      'The pipeline is a kanban of deal cards (name, company, amount, owner avatar, days in stage) with drag-and-drop between stage columns using dnd-kit; each column shows count and total amount.',
      'A record page (contact, company, deal) has a left summary column with editable fields and a right activity timeline: notes, calls, emails, stage changes, tasks, newest first, with a composer at the top.',
      'Everything is relational: deals belong to a company and one or more contacts; tasks belong to a deal or contact; activities reference their record. Model this in the database with foreign keys.',
      'Inline editing: click a field on a record to edit it in place, save on blur, show a subtle saved indicator. No modal for single-field edits.',
      'Filters and views: tables support saved views (My deals, Closing this month) stored per user in the database.',
      'Design: white or near-black surfaces, one brand accent for primary actions, stage colours as soft pastel pills, 13 to 14px text, compact rows.',
    ],
    starterPrompt: 'Build the CRM from the blueprint: pipeline kanban with drag-and-drop across six stages, contacts and companies tables with record pages, deal records with an activity timeline and notes, and a tasks page. Store everything relationally in the database and seed 30 contacts, 12 companies and 20 deals.',
  },
  {
    id: 'saas-landing',
    name: 'SaaS landing page',
    category: 'Landing page',
    tagline: 'Hero, social proof, features, pricing, FAQ.',
    description: 'A conversion-focused product landing: bold hero with product shot, logo bar, feature grid, comparison, pricing table with toggle, FAQ, footer CTA.',
    accent: 'from-sky-900 via-cyan-700 to-emerald-500',
    stack: ['framer-motion', 'lucide-react'],
    pages: ['/ (hero, logos, features, how it works, pricing, testimonials, FAQ, CTA, footer)', '/pricing', '/changelog', '/legal/privacy, /legal/terms'],
    rules: [
      'Hero: one headline under 10 words, one sub-line under 25, primary and secondary CTA, and a product visual (screenshot frame or abstract UI mock built from divs). Nothing else above the fold.',
      'Section rhythm: 96px vertical padding on desktop, 64px on mobile; max-width 1200px; every section has an eyebrow label, heading, and one-sentence lede.',
      'Type scale: display 56/64px, h2 36px, body 18px on marketing pages, letter-spacing -0.02em on headings. One display font and one text font maximum.',
      'Motion: fade-up on scroll with framer-motion, 300 to 400ms, once per element, disabled when prefers-reduced-motion is set. No parallax, no autoplay carousels.',
      'Pricing: three tiers with a monthly/yearly toggle, the middle tier highlighted, a feature checklist, and the CTA copy differing per tier.',
      'Social proof: a logo bar (grayscale, 6 to 8 logos) directly under the hero and three testimonials with name, role and avatar.',
      'Performance: no images above 200KB, lazy-load below the fold, no third-party scripts.',
    ],
    starterPrompt: 'Build the SaaS landing page from the blueprint for a product of my choice (ask me the product name and one-line pitch first, then build): hero, logo bar, six-feature grid, how-it-works in three steps, pricing with a monthly/yearly toggle, testimonials, FAQ accordion and a footer CTA. Add a waitlist form that stores emails in the database through an edge function.',
  },
  {
    id: 'creative-agency',
    name: 'Creative agency site',
    category: 'Landing page',
    tagline: 'Editorial type, big imagery, case-study grid.',
    description: 'A creative studio site: oversized editorial typography, full-bleed work grid, case-study pages, marquee, contact page. Bold, image-led, motion-rich.',
    accent: 'from-orange-700 via-rose-600 to-pink-500',
    stack: ['framer-motion', 'lenis'],
    pages: ['/ (statement hero, selected work grid, services, clients marquee, contact CTA)', '/work (filterable grid)', '/work/:slug (case study: hero image, brief, approach, results, next project)', '/studio (team, values)', '/contact'],
    rules: [
      'Typography leads: a display face at 96 to 140px for statements, tight leading (0.95), mixed weights, and generous whitespace. Body text 16 to 18px.',
      'Work grid: asymmetric two-column masonry with hover reveal of title and category; images use aspect-ratio boxes with object-cover.',
      'Smooth scrolling with lenis; section reveals with framer-motion; a horizontal marquee of client names; a custom cursor is allowed but must not break touch.',
      'Colour: one near-black, one off-white, one saturated accent used sparingly (links, hover, one highlight per page). Dark or light, not both.',
      'Case study page: full-bleed hero, a two-column brief (client, year, services, role), then alternating image and text blocks, results in big numbers, and a next-project link.',
      'Contact: a short form (name, email, budget select, message) submitted through an edge function, plus email and social links.',
    ],
    starterPrompt: 'Build the creative agency site from the blueprint: statement hero with oversized type, selected work grid with hover reveals, services list, client marquee, a filterable work page, a case-study template with three sample projects, a studio page and a contact form saved to the database.',
  },
  {
    id: 'three-d-showcase',
    name: '3D product showcase',
    category: '3D UI',
    tagline: 'react-three-fiber scene, scroll-driven camera, glass UI.',
    description: 'A 3D landing built with react-three-fiber and drei: a hero scene, scroll-driven camera moves between feature stops, floating glass panels for copy.',
    accent: 'from-indigo-950 via-blue-800 to-cyan-400',
    stack: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'framer-motion'],
    pages: ['/ (fixed canvas + scroll sections)', '/specs', '/buy'],
    rules: [
      'One full-viewport Canvas fixed behind the page; HTML sections scroll over it. Use drei ScrollControls or a scroll progress value to move the camera between named stops (hero, feature 1, feature 2, CTA).',
      'Scene: a primary object built from primitives or a loaded GLTF (drei useGLTF with Suspense fallback), drei Environment for lighting, soft ContactShadows, Float for idle motion, and a bloom pass at low intensity.',
      'UI over 3D: glass panels (backdrop-blur, 1px white/10 border, white/5 fill) with white text; keep copy short; CTA buttons solid, not glass.',
      'Performance: dpr capped at [1, 1.5], frameloop="demand" when nothing animates, no shadows above 1024 map size, and a static image fallback when WebGL is unavailable.',
      'Interaction: pointer parallax on the hero object (small rotation, eased), and hover states on feature stops. No orbit controls on the marketing page.',
      'Typography: geometric sans, 64 to 96px hero, tracking -0.03em; colour white on deep navy or black.',
    ],
    starterPrompt: 'Build the 3D product showcase from the blueprint: a fixed react-three-fiber canvas with a floating product built from primitives, scroll-driven camera stops for hero, two features and a CTA, glass UI panels over the scene, bloom post-processing, dpr cap, and a static fallback when WebGL is missing.',
  },
  {
    id: 'math-textbook',
    name: 'Math textbook',
    category: 'Math book',
    tagline: 'Chapters, numbered theorems, KaTeX, exercises.',
    description: 'A textbook-style site: chapter and section navigation, KaTeX-rendered equations with numbering, theorem/definition/proof boxes, worked examples, exercises with hidden solutions.',
    accent: 'from-stone-900 via-amber-900 to-yellow-600',
    stack: ['katex', 'react-katex', 'react-markdown', 'remark-math', 'rehype-katex'],
    pages: ['/ (book cover, table of contents)', '/ch/:chapter (chapter page with section anchors)', '/ch/:chapter/:section', '/exercises/:chapter', '/glossary', '/search'],
    rules: [
      'Content is Markdown with $inline$ and $$display$$ math stored in the database per section; render with react-markdown + remark-math + rehype-katex. Load katex/dist/katex.min.css once.',
      'Reading layout: 720px measure, serif body at 18/1.7, a sticky left table of contents (chapter → sections) and a right "on this page" list; previous/next section footer.',
      'Numbered environments: Theorem, Lemma, Definition, Example, Proof boxes with a left border colour per type and automatic numbering (Theorem 2.3) computed from position; display equations get right-aligned numbers (2.1).',
      'Exercises: each has a difficulty dot, a "Show solution" disclosure, and progress saved per signed-in reader in the database.',
      'Search: full-text over section titles and body from the database, results grouped by chapter.',
      'Print and dark mode: a print stylesheet that keeps math crisp, and a dark theme with warm off-white text; math colour inherits from text.',
    ],
    starterPrompt: 'Build the math textbook from the blueprint on a subject of my choice (ask which subject, then build): a cover with table of contents, chapter and section pages rendered from Markdown with KaTeX, numbered theorem/definition/proof boxes, worked examples, exercises with hidden solutions and reader progress. Seed two chapters of real content.',
  },
  {
    id: 'learning-platform',
    name: 'Learning platform',
    category: 'Learning',
    tagline: 'Courses, lessons, progress, quizzes, certificates.',
    description: 'A course platform: catalog, course page with curriculum, lesson player with notes, progress tracking, quizzes with instant feedback, certificates.',
    accent: 'from-emerald-900 via-green-700 to-lime-500',
    stack: ['react-markdown', 'recharts', 'react-hook-form', 'zod'],
    pages: ['/ (catalog with categories and search)', '/course/:slug (overview, curriculum, instructor, enroll)', '/learn/:course/:lesson (player, notes, next lesson)', '/quiz/:id', '/me (enrolled courses, progress, certificates)', '/admin/courses (author: create course, lessons, quiz questions)'],
    rules: [
      'Data model: courses → modules → lessons; quizzes with questions and options; enrollments and lesson_progress per user. Everything in the database with row level security so learners only see their own progress.',
      'Lesson player: left content (video embed or Markdown), right column with curriculum (checkmarks for done), a notes textarea autosaved to the database, and Mark complete / Next lesson.',
      'Progress: a course card shows a ring or bar with percent complete; the /me page shows streak and total minutes.',
      'Quiz: one question per screen, instant right/wrong feedback with explanation, score at the end, best score stored; passing 70% unlocks the certificate.',
      'Author area behind a role check (author or admin): course form, drag-to-reorder lessons, quiz question editor.',
      'Design: friendly and calm; 16px base, rounded-xl cards, a single accent colour, soft category colours, illustrations built from CSS shapes rather than stock images.',
    ],
    starterPrompt: 'Build the learning platform from the blueprint: course catalog, course page with curriculum and enroll, lesson player with notes and progress, a quiz flow with scoring and certificates, a learner dashboard, and an author area to create courses and lessons. Seed two courses with lessons and quizzes.',
  },
  {
    id: 'research-hub',
    name: 'Research hub',
    category: 'Research',
    tagline: 'Paper library, reader with highlights, notes, citations.',
    description: 'A research workspace: paper library with tags, a reader with highlights and margin notes, a lab notebook, citation export, and a knowledge graph of references.',
    accent: 'from-slate-900 via-cyan-900 to-teal-500',
    stack: ['react-markdown', 'remark-math', 'rehype-katex', 'katex', 'date-fns', 'recharts'],
    pages: ['/ (library: table of papers with tags, status, year, venue)', '/paper/:id (metadata, abstract, highlights, notes, related)', '/notebook (dated entries in Markdown with math)', '/collections', '/graph (citation graph)', '/export (BibTeX)'],
    rules: [
      'Library table: title, authors, year, venue, tags, reading status (to read, reading, read), rating; sortable, filterable by tag and status; add a paper by DOI or manually.',
      'Paper page: two columns, metadata and abstract left, highlights and notes right; highlights are quotes with a colour and an optional comment, notes are Markdown with math.',
      'Notebook: dated entries in Markdown, math via KaTeX, a left list by month, and backlinks to papers using [[title]] syntax resolved against the library.',
      'Citations: store BibTeX fields per paper; /export produces a .bib for a collection; copy-cite buttons for APA and BibTeX.',
      'Graph: a simple SVG force layout of papers connected by references you record (no heavy graph library); click a node to open the paper.',
      'Design: quiet, monochrome, dense but readable; 14px UI, 16px reading text, serif for abstracts and notes, tags as small outlined pills.',
    ],
    starterPrompt: 'Build the research hub from the blueprint: a paper library with tags and reading status, a paper page with highlights and Markdown notes with math, a dated lab notebook with backlinks, collections with BibTeX export, and a simple SVG citation graph. Seed ten papers and a week of notebook entries.',
  },
  {
    id: 'storefront',
    name: 'Storefront',
    category: 'Storefront',
    tagline: 'Catalog, product page, cart, checkout, orders.',
    description: 'A modern shop: category navigation, filterable catalog, product page with gallery and variants, slide-out cart, checkout with address and payment steps, order history.',
    accent: 'from-neutral-900 via-red-900 to-orange-500',
    stack: ['zustand', 'react-hook-form', 'zod', 'framer-motion'],
    pages: ['/ (hero, featured collections, best sellers)', '/shop (grid, filters, sort)', '/product/:slug (gallery, variants, add to cart, reviews)', '/cart (sheet) and /checkout (steps)', '/account/orders'],
    rules: [
      'Product grid: 4 columns desktop, 2 mobile, 4:5 image boxes, price with compare-at strikethrough, quick add on hover; filters in a left rail (desktop) or a sheet (mobile).',
      'Product page: sticky buy box (price, variant pickers as pills, quantity, Add to cart), gallery with thumbnails, tabs for details, shipping and reviews.',
      'Cart: a right-side sheet with line items, quantity steppers, subtotal, and a checkout button; cart state in zustand, persisted per signed-in user in the database.',
      'Checkout: three steps (contact and address, shipping, payment) with a sticky order summary; payment is a placeholder handled by an edge function that creates the order record.',
      'Orders: order number, status pill (paid, packed, shipped, delivered), line items and totals; admin can change status from a small admin page behind a role check.',
      'Design: product photography first, neutral surfaces, one accent for buttons and sale badges, 14px UI text, 18px product titles.',
    ],
    starterPrompt: 'Build the storefront from the blueprint: home with featured collections, a filterable shop grid, product pages with variants and a sticky buy box, a slide-out cart, a three-step checkout that creates orders through an edge function, and an account page with order history. Seed 24 products across 4 categories.',
  },
  {
    id: 'booking',
    name: 'Booking system',
    category: 'Booking',
    tagline: 'Services, availability calendar, slots, confirmations.',
    description: 'Appointments for a clinic, salon or studio: services and staff, weekly availability, slot picker, booking flow, customer confirmations, admin calendar.',
    accent: 'from-teal-900 via-emerald-800 to-cyan-500',
    stack: ['date-fns', 'react-hook-form', 'zod', '@dnd-kit/core'],
    pages: ['/ (services, staff, book now)', '/book (service → staff → date → slot → details → confirm)', '/booking/:id (confirmation, reschedule, cancel)', '/admin (day/week calendar, drag to move)', '/admin/services, /admin/staff, /admin/availability'],
    rules: [
      'Availability is computed, not stored per slot: staff weekly hours plus exceptions, minus existing bookings, sliced by service duration; do this in an edge function so the client never guesses.',
      'Slot picker: a month calendar with available days highlighted, then a list of time chips for the chosen day grouped Morning / Afternoon / Evening; show the customer\'s timezone.',
      'Booking flow is a stepper with a persistent summary card; the final confirm creates the booking through an edge function that re-checks the slot (no double booking).',
      'Admin calendar: day and week views with 15-minute rows, bookings as blocks coloured by service, drag to reschedule (dnd-kit) with a confirm prompt.',
      'Notifications: a confirmation view with an Add to calendar (.ics) link; email sending is a stubbed edge function call.',
      'Design: calm and trustworthy; 16px base, rounded-xl, a single accent, large tap targets (44px) throughout the booking flow.',
    ],
    starterPrompt: 'Build the booking system from the blueprint: services and staff pages, a five-step booking flow with a computed slot picker (edge function), confirmation page with reschedule and cancel, and an admin week calendar with drag-to-reschedule. Seed three services, two staff members and a week of availability.',
  },
  {
    id: 'portfolio',
    name: 'Personal portfolio',
    category: 'Portfolio',
    tagline: 'Intro, projects, writing, contact. Fast and quiet.',
    description: 'A designer or developer portfolio: short intro, selected projects with case pages, a writing list, about page, contact. Minimal, fast, typographic.',
    accent: 'from-neutral-900 via-neutral-700 to-neutral-400',
    stack: ['framer-motion', 'react-markdown'],
    pages: ['/ (intro, selected projects, latest writing)', '/projects and /projects/:slug', '/writing and /writing/:slug (Markdown)', '/about', '/contact'],
    rules: [
      'Measure 640 to 720px, 18px body, one typeface, generous line height; headings only two sizes. Whitespace does the design.',
      'Projects: a list, not a grid: title, one-line summary, year, and a single image on hover or on the case page; case pages are Markdown from the database.',
      'Writing: Markdown posts with dates, reading time, and a simple tag filter.',
      'Navigation: a two-line header (name and role, three links); footer with email and socials; no hamburger unless there are more than four links.',
      'Motion: only opacity and 8px translate on route change; nothing on scroll.',
      'Light and dark follow the system; a small toggle in the footer.',
    ],
    starterPrompt: 'Build the personal portfolio from the blueprint: intro with name and role, a list of selected projects with case pages, a writing section from Markdown posts, an about page and a contact form saved to the database. Ask me for my name, role and three projects first, then build.',
  },
  {
    id: 'docs-site',
    name: 'Documentation site',
    category: 'Docs',
    tagline: 'Sidebar tree, Markdown pages, search, versioned.',
    description: 'Product documentation: sidebar navigation tree, Markdown pages with code blocks and callouts, on-page table of contents, search, versions and an API reference layout.',
    accent: 'from-gray-900 via-violet-900 to-purple-500',
    stack: ['react-markdown', 'remark-gfm', 'rehype-highlight', 'cmdk'],
    pages: ['/docs (getting started)', '/docs/:section/:page', '/api (three-column API reference: nav, content, code samples)', '/changelog', '/search (cmdk dialog)'],
    rules: [
      'Three-column layout: 260px sidebar tree (collapsible groups, active trail), content 760px, 220px on-page table of contents; the sidebar becomes a drawer on mobile.',
      'Pages are Markdown in the database with front matter (title, description, order, version); render with remark-gfm and syntax-highlighted code blocks with a copy button; callouts via blockquote prefixes (Note, Warning, Tip).',
      'API reference: endpoint pages with method badge, path, parameters table, request and response examples in tabs (curl, JS, Python), and a sticky code column.',
      'Search: Cmd+K dialog over page titles and headings from the database; results show breadcrumb section → page.',
      'Versions: a version switcher in the sidebar; pages carry a version field and links stay within the selected version.',
      'Design: 15px body, 1.65 line height, muted greys, a single accent for links and active items, code in a monospace at 13px with a dark block background in both themes.',
    ],
    starterPrompt: 'Build the documentation site from the blueprint: sidebar tree with groups, Markdown pages with code blocks, callouts and a copy button, an on-page table of contents, a Cmd+K search, a version switcher and a three-column API reference. Seed a Getting started guide, five pages and three API endpoints, editable from a small admin page.',
  },
];

export function findBlueprint(id: string): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}

/** The rules as one knowledge note the agent reads on every run. */
export function blueprintKnowledge(b: Blueprint): { heading: string; content: string } {
  const lines = [
    `Template: ${b.name} (${b.category}). ${b.description}`,
    '',
    'Install first: ' + b.stack.join(', '),
    '',
    'Pages:',
    ...b.pages.map((p) => `- ${p}`),
    '',
    'Build rules:',
    ...[...b.rules, ...SHARED_RULES].map((r) => `- ${r}`),
  ];
  return { heading: `Template rules: ${b.name}`, content: lines.join('\n') };
}
