

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_TEMPLATE_DIR =
  process.env.BASE_TEMPLATE_DIR ||
  path.join(os.homedir(), '.SMEsAgent', 'base-template');

// Stable versions of the most commonly requested packages.
// Update this list periodically   bump the hash file to force a re-install.
// ─── Pre-installed packages ───────────────────────────────────────────────────
// These are baked into the golden template AND the preview Docker image.
// The agent can import any of these without triggering a slow npm install.
// Keep this list in sync with preview-service/package.json.
const COMMON_PACKAGE_JSON = {
  name: 'SMEsAgent-base-template',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'tsc -b && vite build',
    preview: 'vite preview',
    test: 'vitest run',
  },
  dependencies: {
    // Core React
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^6.28.0',
    // UI primitives (shadcn/Radix)
    '@radix-ui/react-accordion': '^1.2.1',
    '@radix-ui/react-alert-dialog': '^1.1.4',
    '@radix-ui/react-aspect-ratio': '^1.1.0',
    '@radix-ui/react-avatar': '^1.1.1',
    '@radix-ui/react-checkbox': '^1.1.2',
    '@radix-ui/react-collapsible': '^1.1.1',
    '@radix-ui/react-context-menu': '^2.2.2',
    '@radix-ui/react-dialog': '^1.1.2',
    '@radix-ui/react-dropdown-menu': '^2.1.2',
    '@radix-ui/react-hover-card': '^1.1.2',
    '@radix-ui/react-label': '^2.1.0',
    '@radix-ui/react-menubar': '^1.1.2',
    '@radix-ui/react-navigation-menu': '^1.2.1',
    '@radix-ui/react-popover': '^1.1.2',
    '@radix-ui/react-progress': '^1.1.0',
    '@radix-ui/react-radio-group': '^1.2.1',
    '@radix-ui/react-scroll-area': '^1.2.0',
    '@radix-ui/react-select': '^2.1.2',
    '@radix-ui/react-separator': '^1.1.0',
    '@radix-ui/react-slider': '^1.2.1',
    '@radix-ui/react-slot': '^1.1.0',
    '@radix-ui/react-switch': '^1.1.1',
    '@radix-ui/react-tabs': '^1.1.1',
    '@radix-ui/react-toast': '^1.2.2',
    '@radix-ui/react-toggle': '^1.1.0',
    '@radix-ui/react-toggle-group': '^1.1.0',
    '@radix-ui/react-tooltip': '^1.1.3',
    // Styling utilities
    'class-variance-authority': '^0.7.0',
    clsx: '^2.1.1',
    'tailwind-merge': '^2.5.4',
    'tailwindcss-animate': '^1.0.7',
    // Icons & animation
    'lucide-react': '^0.462.0',
    'framer-motion': '^11.11.17',
    // Data & forms
    zod: '^3.23.8',
    'react-hook-form': '^7.61.1',
    '@hookform/resolvers': '^3.10.0',
    '@tanstack/react-query': '^5.83.0',
    '@tanstack/react-table': '^8.20.0',
    // Dates & charts
    'date-fns': '^3.6.0',
    recharts: '^2.13.0',
    'react-day-picker': '^8.10.1',
    // Notifications & overlays
    sonner: '^1.5.0',
    cmdk: '^1.1.1',
    vaul: '^0.9.9',
    'input-otp': '^1.4.2',
    // Layout & carousel
    'embla-carousel-react': '^8.6.0',
    'react-resizable-panels': '^2.1.9',
    // Commonly requested extras
    axios: '^1.7.0',
    lodash: '^4.17.21',
    uuid: '^9.0.0',
    '@supabase/supabase-js': '^2.78.0',
    'next-themes': '^0.3.0',
    'react-icons': '^5.4.0',
    'react-markdown': '^10.1.0',
    'react-hot-toast': '^2.4.1',
    zustand: '^5.0.0',
  },
  devDependencies: {
    '@types/react': '^18.3.5',
    '@types/react-dom': '^18.3.0',
    '@types/lodash': '^4.17.0',
    '@types/uuid': '^10.0.0',
    '@vitejs/plugin-react': '^4.3.1',
    typescript: '^5.5.4',
    vite: '^5.4.0',
    tailwindcss: '^3.4.14',
    autoprefixer: '^10.4.20',
    postcss: '^8.4.47',
    vitest: '^3.2.4',
    jsdom: '^20.0.3',
    '@testing-library/react': '^16.0.0',
    '@testing-library/jest-dom': '^6.6.0',
  },
};

/** Flat list of package names available without npm install. Exported so the
 *  agent prompt can tell the LLM which imports are free. */
export const PRE_INSTALLED_PACKAGES: string[] = [
  ...Object.keys(COMMON_PACKAGE_JSON.dependencies),
  ...Object.keys(COMMON_PACKAGE_JSON.devDependencies),
];

// ─── Internals ────────────────────────────────────────────────────────────────

function packageJsonHash(): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(COMMON_PACKAGE_JSON))
    .digest('hex')
    .slice(0, 16);
}

const HASH_FILE = path.join(BASE_TEMPLATE_DIR, '.SMEsAgent-hash');
const NODE_MODULES = path.join(BASE_TEMPLATE_DIR, 'node_modules');

function isMuslLibc(): boolean {
  try {
    return fs.readFileSync('/usr/bin/ldd', 'utf8').includes('musl');
  } catch {
    return false;
  }
}

/**
 * npm has a long-documented bug (npm/cli#4828) where installing an optional
 * native dependency -- Rollup's platform binary here -- can silently produce
 * a CORRUPTED file with no error (npm install exits 0 either way). Verified
 * directly: the registry tarball for this exact package/version has the
 * correct published shasum and extracts to a byte-perfect binary via plain
 * curl + tar, every time -- npm's own install/extraction step is what
 * corrupts it locally. Work around it by re-extracting this one small
 * package straight from its registry tarball, bypassing npm's install path
 * for just this file.
 */
async function verifyOrFixRollupNativeBinary(templateDir: string): Promise<void> {
  const platformPkg =
    process.platform === 'linux' ? (isMuslLibc() ? '@rollup/rollup-linux-x64-musl' : '@rollup/rollup-linux-x64-gnu') :
    process.platform === 'darwin' ? (process.arch === 'arm64' ? '@rollup/rollup-darwin-arm64' : '@rollup/rollup-darwin-x64') :
    null;
  if (!platformPkg) return; // Windows, or another platform this check doesn't cover

  const pkgDir = path.join(templateDir, 'node_modules', platformPkg);
  if (!fs.existsSync(pkgDir)) return; // nothing to verify (e.g. unsupported platform, wasm fallback)

  // Does the binary actually load? (Exit code from npm install says nothing
  // useful here -- that's the whole bug.)
  try {
    await execAsync(`node -e "require('${platformPkg}')"`, { cwd: templateDir, timeout: 15_000 });
    return; // already fine
  } catch {
    // fall through to the fix below
  }

  console.log(`[BaseTemplate] ${platformPkg} failed to load -- re-extracting it directly from the npm registry`);
  try {
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    const tarballUrl = `https://registry.npmjs.org/${platformPkg}/-/${platformPkg.split('/')[1]}-${version}.tgz`;
    const tmpTar = path.join(os.tmpdir(), `${platformPkg.split('/')[1]}-${version}-${Date.now()}.tgz`);
    const tmpExtract = `${tmpTar}.extract`;
    await execAsync(`curl -sL "${tarballUrl}" -o "${tmpTar}"`, { timeout: 60_000 });
    fs.mkdirSync(tmpExtract, { recursive: true });
    await execAsync(`tar -xzf "${tmpTar}" -C "${tmpExtract}"`, { timeout: 30_000 });
    // Overwrite the whole package dir with the freshly-extracted contents.
    fs.rmSync(pkgDir, { recursive: true, force: true });
    fs.renameSync(path.join(tmpExtract, 'package'), pkgDir);
    fs.rmSync(tmpTar, { force: true });
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    await execAsync(`node -e "require('${platformPkg}')"`, { cwd: templateDir, timeout: 15_000 });
    console.log(`[BaseTemplate] ${platformPkg} re-extracted and verified working`);
  } catch (e) {
    console.error(`[BaseTemplate] Could not fix ${platformPkg} -- Vite will fail to start:`, (e as Error).message.slice(0, 300));
  }
}

// ─── Scaffold files written into every new project ────────────────────────────
// These files are copied (not hard-linked) since each project may customise them.

// Test scaffolding (gap G7, 2026-08-12). Exported because run_command's
// verification preflight writes these into any project that has a test runner
// but no config -- measured live, only 1 of 190 projects had a vitest config,
// so a React component test would have died on "document is not defined" and
// sent the agent chasing a defect that was really a missing jsdom environment.
export const VITEST_CONFIG_TS = `import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // process.cwd() (not __dirname): vitest always runs from the project root,
  // and __dirname does not exist in an ESM config ("type": "module").
  resolve: { alias: { '@': path.resolve(process.cwd(), './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
`;

export const VITEST_SETUP_TS = `import '@testing-library/jest-dom';
`;

const SCAFFOLD_FILES: Record<string, string> = {
  'vitest.config.ts': VITEST_CONFIG_TS,
  'src/test/setup.ts': VITEST_SETUP_TS,
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`,
  'tsconfig.json': `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
`,
  'tsconfig.app.json': `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
`,
  'tsconfig.node.json': `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
`,
  'tailwind.config.js': `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
`,
  'postcss.config.js': `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{PROJECT_NAME}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
`,
  // A render-time throw anywhere in the tree unmounts React and leaves a blank
  // white page with nothing but a console error. This turns that into a visible
  // message plus the actual error text, so a broken build is diagnosable.
  'src/components/ErrorBoundary.tsx': `import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
        <div className="max-w-lg w-full space-y-4">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-muted-foreground">
            This page hit an unexpected error. Try reloading. If it keeps happening, the
            details below say why.
          </p>
          <pre className="text-xs whitespace-pre-wrap break-words rounded-md border border-border p-3 overflow-auto max-h-64">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
`,
  'src/App.tsx': `import { HashRouter, Routes, Route } from 'react-router-dom';

function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <h1 className="text-4xl font-bold">Welcome</h1>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </HashRouter>
  );
}
`,
  'src/index.css': `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`,
  // ─── Pre-built shadcn/ui components ──────────────────────────────────────────
  // Agent no longer needs to write these   saves 10-15 tool calls per build.
  'src/lib/utils.ts': `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
  // Centralized fetch for every network call generated code makes. One flaky
  // request should degrade to a retry, not a blank page or a dead login form.
  'src/lib/api.ts': `/**
 * apiFetch: use this for EVERY network request instead of bare fetch().
 * Adds a timeout, retries transient failures (network error / 5xx / 429)
 * twice with backoff, and throws a descriptive Error on failure so calling
 * code can show a real message instead of failing silently.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {},
  { retries = 2, timeoutMs = 15000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  let lastError: Error = new Error('Request failed');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: options.signal ?? controller.signal });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(\`Request to \${new URL(url, window.location.href).pathname} failed with status \${res.status}\`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError' && options.signal?.aborted) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastError;
}

/** apiFetch + JSON parse with a readable error on non-2xx or invalid JSON. */
export async function apiFetchJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(url, options);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    throw new Error(\`Request failed (\${res.status})\${detail ? ': ' + detail : ''}\`);
  }
  return res.json() as Promise<T>;
}
`,
  'src/components/ui/button.tsx': `import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
`,
  'src/components/ui/card.tsx': `import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props} />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
`,
  'src/components/ui/input.tsx': `import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
`,
  'src/components/ui/label.tsx': `import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
`,
  'src/components/ui/badge.tsx': `import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
`,
  'src/components/ui/textarea.tsx': `import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export { Textarea };
`,
  'src/components/ui/separator.tsx': `import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
      className
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
`,
  'src/components/ui/avatar.tsx': `import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} className={cn("aspect-square h-full w-full", className)} {...props} />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex h-full w-full items-center justify-center rounded-full bg-muted", className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
`,
  'src/components/ui/dialog.tsx': `import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export { Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
`,
  'src/components/ui/select.tsx': `import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className
      )}
      position={position}
      {...props}
    >
      <SelectPrimitive.Viewport
        className={cn("p-1", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem };
`,
  'src/components/ui/tabs.tsx': `import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
`,
  'src/components/ui/table.tsx': `import * as React from "react";
import { cn } from "@/lib/utils";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  )
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)} {...props} />
  )
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)} {...props} />
  )
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th ref={ref} className={cn("h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0", className)} {...props} />
  )
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
  )
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  )
);
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
`,
};

/** Pre-built component paths available in the scaffold (used by system prompt) */
export const PRE_BUILT_UI_COMPONENTS = [
  'src/lib/utils.ts',
  'src/components/ui/button.tsx',
  'src/components/ui/card.tsx',
  'src/components/ui/input.tsx',
  'src/components/ui/label.tsx',
  'src/components/ui/badge.tsx',
  'src/components/ui/textarea.tsx',
  'src/components/ui/separator.tsx',
  'src/components/ui/avatar.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/select.tsx',
  'src/components/ui/tabs.tsx',
  'src/components/ui/table.tsx',
];

/** Returns true when the base template is present and up-to-date. */
function isTemplateReady(): boolean {
  if (!fs.existsSync(NODE_MODULES)) return false;
  if (!fs.existsSync(HASH_FILE)) return false;
  return fs.readFileSync(HASH_FILE, 'utf8').trim() === packageJsonHash();
}

let buildPromise: Promise<void> | null = null;

/**
 * Ensure the golden template is installed.  Safe to call concurrently  
 * multiple callers share the same in-flight promise.
 */
export async function ensureBaseTemplate(): Promise<void> {
  if (isTemplateReady()) return;
  if (buildPromise) return buildPromise;

  buildPromise = (async () => {
    console.log('[BaseTemplate] Building base template at', BASE_TEMPLATE_DIR);
    fs.mkdirSync(BASE_TEMPLATE_DIR, { recursive: true });
    fs.mkdirSync(path.join(BASE_TEMPLATE_DIR, 'src'), { recursive: true });

    // Write package.json
    const pkgPath = path.join(BASE_TEMPLATE_DIR, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify(COMMON_PACKAGE_JSON, null, 2), 'utf8');

    // Write all scaffold files into the template
    for (const [relPath, content] of Object.entries(SCAFFOLD_FILES)) {
      const filePath = path.join(BASE_TEMPLATE_DIR, relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    }

    // Run npm install. --prefer-offline resolves versions from the LOCAL npm
    // cache metadata; when the lockfile pins a version published after the
    // cache last saw that package, every offline attempt fails ETARGET
    // identically and retrying changes nothing (44 failed template inits in
    // 48h, 2026-08-17: follow-redirects@1.16.0 existed on the registry but
    // not in VPS1's cache). On ETARGET/notarget, retry once online.
    const start = Date.now();
    let stderr: string;
    try {
      ({ stderr } = await execAsync('npm install --prefer-offline --no-audit --no-fund', {
        cwd: BASE_TEMPLATE_DIR,
        timeout: 300_000, // 5 min max
        env: { ...process.env, NODE_ENV: 'development' },
      }));
    } catch (installErr) {
      const message = installErr instanceof Error ? installErr.message : String(installErr);
      if (!/ETARGET|notarget/i.test(message)) throw installErr;
      console.warn('[BaseTemplate] offline install hit ETARGET (stale npm cache)   retrying online');
      ({ stderr } = await execAsync('npm install --prefer-online --no-audit --no-fund', {
        cwd: BASE_TEMPLATE_DIR,
        timeout: 300_000,
        env: { ...process.env, NODE_ENV: 'development' },
      }));
    }
    if (stderr && !stderr.includes('npm warn')) {
      console.warn('[BaseTemplate] npm install stderr:', stderr.slice(0, 500));
    }

    // Rollup's platform-native binary (an npm optionalDependency) has been
    // confirmed CORRUPTED by npm's own install/extraction step -- not a bad
    // download: the exact same registry tarball, fetched and extracted by
    // hand (curl + tar), produces a byte-perfect binary every time. This is
    // npm's own long-documented optional-dependency bug (npm/cli#4828).
    // Work around it by re-extracting this one small package directly from
    // its registry tarball, bypassing npm's extraction entirely.
    await verifyOrFixRollupNativeBinary(BASE_TEMPLATE_DIR);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[BaseTemplate] Base template ready in ${elapsed}s`);

    // Stamp the hash so we know what's installed
    fs.writeFileSync(HASH_FILE, packageJsonHash(), 'utf8');
    buildPromise = null;
  })();

  return buildPromise;
}

/**
 * Copy the base template's node_modules into `destDir` using hard links.
 *
 * Hard-link copies (`cp -al`) are nearly instant (milliseconds) and use
 * virtually no extra disk space.  Each project still has its own directory
 * structure so `npm install <new-pkg>` works correctly without affecting other
 * projects.
 *
 * Falls back to a regular recursive copy on platforms where `cp -al` is
 * unavailable (Windows).
 */
export async function initProjectFromTemplate(destDir: string, projectName?: string): Promise<void> {
  const destModules = path.join(destDir, 'node_modules');
  const destPkg = path.join(destDir, 'package.json');

  // Nothing to do if node_modules already exist
  if (fs.existsSync(destModules)) return;

  // Ensure the golden template is ready first
  await ensureBaseTemplate();

  console.log('[BaseTemplate] Initialising project node_modules via hardlink copy →', destDir);
  const start = Date.now();

  try {
    // `cp -al` creates hard links (Linux / macOS)
    await execAsync(`cp -al "${NODE_MODULES}" "${destModules}"`);
  } catch {
    // Fallback for Windows, or Linux filesystems that don't support hard links
    // (destDir on a different mount than BASE_TEMPLATE_DIR   cp -al fails with
    // EXDEV, which can leave a partially-created destModules behind). `cp -r`
    // treats an already-existing destModules as a directory to copy INTO, not
    // merge with, nesting the whole tree one level too deep
    // (destModules/node_modules/react instead of destModules/react) and
    // silently breaking every import in the scaffolded project. Clear any
    // partial state first and copy contents (trailing /.), not the directory.
    console.warn('[BaseTemplate] cp -al failed, falling back to cp -r');
    fs.rmSync(destModules, { recursive: true, force: true });
    fs.mkdirSync(destModules, { recursive: true });
    await execAsync(`cp -r "${NODE_MODULES}/." "${destModules}/"`);
  }

  // Rollup's platform-native binary has been observed corrupted specifically
  // when accessed through a hard link (this project's copy AND the golden
  // template's own copy going bad together, even though each verified fine
  // moments earlier) -- something about a shared inode + Vite/Node's dlopen
  // of a native addon doesn't survive on some filesystems. Break the link
  // for just this one file: delete the hardlinked copy and lay down a real,
  // independent copy instead. Cheap (one small binary) unlike falling back
  // to cp -r for the whole ~480-package tree.
  for (const nativePkg of ['@rollup/rollup-linux-x64-gnu', '@rollup/rollup-linux-x64-musl', '@rollup/rollup-darwin-arm64', '@rollup/rollup-darwin-x64']) {
    const srcPkgDir = path.join(NODE_MODULES, nativePkg);
    const destPkgDir = path.join(destModules, nativePkg);
    if (fs.existsSync(srcPkgDir)) {
      fs.rmSync(destPkgDir, { recursive: true, force: true });
      fs.cpSync(srcPkgDir, destPkgDir, { recursive: true });
    }
  }

  // Seed a package.json if the project doesn't have one yet
  if (!fs.existsSync(destPkg)) {
    fs.writeFileSync(destPkg, JSON.stringify(COMMON_PACKAGE_JSON, null, 2), 'utf8');
  }

  // Copy package-lock.json so npm doesn't re-resolve on the next install
  const srcLock = path.join(BASE_TEMPLATE_DIR, 'package-lock.json');
  const destLock = path.join(destDir, 'package-lock.json');
  if (fs.existsSync(srcLock) && !fs.existsSync(destLock)) {
    fs.copyFileSync(srcLock, destLock);
  }

  // Copy scaffold files (only if not already present   agent may have written them).
  // The scaffold index.html carries a {{PROJECT_NAME}} title placeholder so a new
  // project defaults to its real name instead of a generic "App" -- the agent then
  // refines full SEO (title/meta/OG/JSON-LD) during the build. Fallback is a neutral
  // "Web App", never "App".
  const projectTitle = (projectName ?? '').trim() || 'Web App';
  for (const [relPath, content] of Object.entries(SCAFFOLD_FILES)) {
    const destFile = path.join(destDir, relPath);
    if (!fs.existsSync(destFile)) {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      const out = content.includes('{{PROJECT_NAME}}')
        ? content.split('{{PROJECT_NAME}}').join(projectTitle)
        : content;
      fs.writeFileSync(destFile, out, 'utf8');
    }
  }

  // Re-check right here, on THIS project's copy, as late as possible before
  // Vite runs -- the corruption described in verifyOrFixRollupNativeBinary's
  // doc comment has been observed appearing minutes after a copy verified
  // fine, so checking immediately after ensureBaseTemplate() (which runs
  // once per machine, not per project) isn't late enough.
  await verifyOrFixRollupNativeBinary(destDir);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[BaseTemplate] node_modules ready in ${elapsed}s`);
}
