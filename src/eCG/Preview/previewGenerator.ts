/**
 * Preview Generator
 * Transforms workspace files (TSX, CSS) into a self-contained HTML preview.
 * Uses a simpler approach that embeds React via CDN and renders components directly.
 */

import { transform } from 'sucrase';

interface WorkspaceFile {
  path: string;
  content: string;
}

interface PreviewResult {
  html: string;
  errors: string[];
}

/**
 * Generates a self-contained HTML preview from workspace files.
 */
export function generatePreview(files: WorkspaceFile[]): PreviewResult {
  const errors: string[] = [];

  // Find CSS files
  const cssFiles = files.filter(f => f.path.endsWith('.css'));
  const cssContent = cssFiles.map(f => f.content).join('\n');

  // Find the main App component
  const appFile = files.find(f =>
    f.path.endsWith('/App.tsx') ||
    f.path === 'App.tsx' ||
    f.path.endsWith('/src/App.tsx')
  );

  if (!appFile) {
    // Don't fallback to raw index.html - it contains relative paths that break in srcDoc
    errors.push('No App.tsx found');
    return {
      html: generateErrorHtml(['No App.tsx found in workspace. Please ensure your project has an App.tsx file.']),
      errors,
    };
  }

  // Transform all TSX/TS files (but exclude config files, main entry, and server/backend files)
  const transformedFiles: Map<string, string> = new Map();

  // Files to skip in preview (they cause issues or aren't meant for browser)
  const skipPatterns = [
    /vite\.config/i, /tsconfig/i, /eslint/i, /tailwind\.config/i, /postcss\.config/i, /\.d\.ts$/,
    /main\.tsx?$/,  // Skip main.tsx - we handle bootstrapping ourselves
    /^server\//,    // Skip backend server files
    /^supabase\//,  // Skip supabase functions
    /^infrastructure\//, // Skip infra
    /^scripts\//,   // Skip scripts
    /^preview-service\//, // Skip preview service files
  ];

  // Preprocess files to fix common issues before transformation
  const preprocessedFiles = files.map(file => ({
    ...file,
    content: preprocessFileContent(file.path, file.content),
  }));

  for (const file of preprocessedFiles.filter(f => f.path.endsWith('.tsx') || f.path.endsWith('.ts'))) {
    // Skip config/backend files
    const shouldSkip = skipPatterns.some(pattern => pattern.test(file.path));
    if (shouldSkip) {
      // console.log(`[PreviewGenerator] Skipping excluded file: ${file.path}`);
      continue;
    }

    // Only include src/ files or root App.tsx (if any)
    // This prevents including random scripts from root that shouldn't be in the bundle
    const normalizedPath = file.path.replace(/^\/+/, '');
    if (!normalizedPath.startsWith('src/') && normalizedPath !== 'App.tsx') {
      // console.log(`[PreviewGenerator] Skipping non-src file: ${file.path}`);
      continue;
    }

    try {
      const result = transform(file.content, {
        transforms: ['typescript', 'jsx', 'imports'],
        jsxRuntime: 'classic',
        production: true,
      });
      // Strip source map comments to prevent DevTools errors in srcdoc
      const codeWithoutSourceMaps = result.code
        .replace(/\/\/# sourceMappingURL=.*/g, '')
        .replace(/\/\*# sourceMappingURL=.*\*\//g, '');
      transformedFiles.set(normalizeModulePath(file.path), codeWithoutSourceMaps);
    } catch (e: any) {
      // Try to provide a more helpful error message
      const errorMsg = formatTransformError(file.path, e);
      errors.push(errorMsg);
      console.error(`[PreviewGenerator] Transform error for ${file.path}:`, e);
    }
  }

  // Build the preview HTML
  const html = buildPreviewHtml(transformedFiles, cssContent, errors);
  return { html, errors };
}

/**
 * Preprocess file content to fix common syntax issues
 */
function preprocessFileContent(filePath: string, content: string): string {
  let fixed = content;

  // Only process TypeScript/JavaScript files
  if (!filePath.match(/\.(tsx?|jsx?)$/)) {
    return fixed;
  }

  // Fix 1: Remove .tsx/.ts extensions from imports
  fixed = fixed.replace(/from\s+['"]([^'"]+)\.(tsx?|jsx?)['"]/g, 'from "$1"');

  // Fix 2: Replace import.meta.env with safe fallback
  fixed = fixed.replace(/import\.meta\.env\.[A-Z_]+/g, 'undefined');

  // Fix 3: Fix class= to className=
  fixed = fixed.replace(/ class=/gi, ' className=');

  // Fix 4: Fix onclick to onClick (common HTML to JSX mistake)
  fixed = fixed.replace(/ onclick=/gi, ' onClick=');
  fixed = fixed.replace(/ onchange=/gi, ' onChange=');
  fixed = fixed.replace(/ onsubmit=/gi, ' onSubmit=');

  return fixed;
}

/**
 * Format transform errors with helpful context
 */
function formatTransformError(filePath: string, error: any): string {
  const message = error.message || String(error);
  
  // Extract line number if available
  const lineMatch = message.match(/line\s*(\d+)/i);
  const lineInfo = lineMatch ? ` (line ${lineMatch[1]})` : '';
  
  // Provide helpful hints for common errors
  let hint = '';
  if (message.includes('Unexpected token')) {
    hint = ' - Check for missing brackets, parentheses, or invalid JSX syntax';
  } else if (message.includes('import')) {
    hint = ' - Check import paths and ensure all dependencies are available';
  }
  
  return `Transform error in ${filePath}${lineInfo}: ${message}${hint}`;
}

function normalizeModulePath(path: string): string {
  // Remove leading slashes and src/ prefix
  return path
    .replace(/^\/+/, '')
    .replace(/^src\//, '')
    .replace(/\.tsx?$/, '');
}

function buildPreviewHtml(modules: Map<string, string>, css: string, errors: string[]): string {
  // Convert modules to a registry
  const moduleAssignments: string[] = [];

  for (const [path, code] of modules.entries()) {
    // Escape backticks and backslashes for embedding in template literal
    const escapedCode = escapeForTemplate(code);
    moduleAssignments.push(`modules["${path}"] = function(exports, module) {
${escapedCode}
};`);
  }

  const moduleRegistryScript = `
      // Simple module system
      const modules = {};
      ${moduleAssignments.join('\n\n')}
  `;

  // Get list of module paths for resolution
  const modulePaths = Array.from(modules.keys());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <base target="_blank">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
    .preview-error { color: #ff4444; background: #1a1a1a; padding: 20px; font-family: monospace; }
    :root {
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 222.2 47.4% 11.2%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
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
      --popover: 222.2 84% 4.9%;
      --popover-foreground: 210 40% 98%;
      --primary: 210 40% 98%;
      --primary-foreground: 222.2 47.4% 11.2%;
      --secondary: 217.2 32.6% 17.5%;
      --secondary-foreground: 210 40% 98%;
      --muted: 217.2 32.6% 17.5%;
      --muted-foreground: 215 20.2% 65.1%;
      --accent: 217.2 32.6% 17.5%;
      --accent-foreground: 210 40% 98%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 210 40% 98%;
      --border: 217.2 32.6% 17.5%;
      --input: 217.2 32.6% 17.5%;
      --ring: 212.7 26.8% 83.9%;
    }
    ${escapeForHtml(css)}
  </style>
  <script src="https://cdn.tailwindcss.com/3.4.1"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            border: "hsl(var(--border))",
            input: "hsl(var(--input))",
            ring: "hsl(var(--ring))",
            background: "hsl(var(--background))",
            foreground: "hsl(var(--foreground))",
            primary: {
              DEFAULT: "hsl(var(--primary))",
              foreground: "hsl(var(--primary-foreground))",
            },
            secondary: {
              DEFAULT: "hsl(var(--secondary))",
              foreground: "hsl(var(--secondary-foreground))",
            },
            destructive: {
              DEFAULT: "hsl(var(--destructive))",
              foreground: "hsl(var(--destructive-foreground))",
            },
            muted: {
              DEFAULT: "hsl(var(--muted))",
              foreground: "hsl(var(--muted-foreground))",
            },
            accent: {
              DEFAULT: "hsl(var(--accent))",
              foreground: "hsl(var(--accent-foreground))",
            },
            popover: {
              DEFAULT: "hsl(var(--popover))",
              foreground: "hsl(var(--popover-foreground))",
            },
            card: {
              DEFAULT: "hsl(var(--card))",
              foreground: "hsl(var(--card-foreground))",
            },
          },
        }
      }
    }
  </script>
  <script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
</head>
<body>
  <div id="root"></div>
  <script>
    (function() {
      // Global communication helper
      window.sendToParent = function(type, message, source = 'runtime') {
        try {
          if (type === 'navigation') {
             window.parent.postMessage({
               type: 'navigation',
               pathname: message.pathname || message
             }, '*');
             return;
          }

          window.parent.postMessage({
            type: 'PREVIEW_LOG',
            log: {
              type: type,
              message: message,
              timestamp: Date.now(),
              source: source
            }
          }, '*');
        } catch (e) {
          console.error('Failed to send log to parent:', e);
        }
      };

      // clsx - simple class name utility
      window.clsx = function(...args) {
        return args.filter(Boolean).map(arg => {
          if (typeof arg === 'string') return arg;
          if (typeof arg === 'object' && arg !== null) {
            return Object.entries(arg).filter(([k, v]) => v).map(([k]) => k).join(' ');
          }
          return '';
        }).join(' ').trim();
      };
      
      // tailwind-merge stub - just concatenates classes (simplified)
      window.twMerge = function(...args) {
        return args.filter(Boolean).join(' ').trim();
      };
      
      // cn utility (common pattern)
      window.cn = function(...args) {
        return window.twMerge(window.clsx(...args));
      };
      
      // React Router DOM stub with minimal in-memory history
      window.ReactRouterDOM = (function() {
        const { useState, useEffect, createContext, useContext, createElement, useCallback, useMemo } = React;
        
        // Simple history context
        const HistoryContext = createContext({
          pathname: '/',
          push: (path) => {},
          replace: (path) => {},
          search: '',
          hash: ''
        });

        function MemoryRouter({ children }) {
          const [location, setLocation] = useState({ pathname: '/', search: '', hash: '' });

          useEffect(() => {
             // Sync initial path
             window.sendToParent('navigation', { pathname: location.pathname });
          }, []);

          const navigate = useCallback((to, replace = false) => {
            let newPath = to;
            if (typeof to === 'number') return; // Ignore delta navigation for now
            if (typeof to === 'object' && to.pathname) newPath = to.pathname;
            
            setLocation(prev => ({ ...prev, pathname: newPath }));
            window.sendToParent('navigation', { pathname: newPath });
          }, []);

          const value = useMemo(() => ({
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            push: (path) => navigate(path, false),
            replace: (path) => navigate(path, true)
          }), [location, navigate]);

          return createElement(HistoryContext.Provider, { value }, children);
        }

        function useNavigate() {
          const { push } = useContext(HistoryContext);
          return push;
        }

        function useLocation() {
          const ctx = useContext(HistoryContext);
          return { pathname: ctx.pathname, search: ctx.search, hash: ctx.hash };
        }

        function useParams() {
          return {}; // URL params not fully supported in simple stub
        }

        function Routes({ children }) {
            // Flatten children
            const routes = [];
            React.Children.forEach(children, child => {
                if (child && child.props) routes.push(child);
            });
            
            const { pathname } = useContext(HistoryContext);
            
            // Allow exact match or simple prefix (very basic)
            // Ideally we'd match based on hierarchy but this is a stub
            for (const route of routes) {
                const { path, element } = route.props;
                if (path === pathname || (path === '*' && !routes.find(r => r.props.path === pathname))) {
                    return element;
                }
            }
            return null;
        }

        function Route({ element }) {
            return element;
        }

        function Link({ to, children, className, ...props }) {
           const { push } = useContext(HistoryContext);
           return createElement('a', {
               href: to,
               className,
               onClick: (e) => {
                   e.preventDefault();
                   push(to);
               },
               ...props
           }, children);
        }

        return {
           BrowserRouter: MemoryRouter, // Treat BrowserRouter as MemoryRouter for preview
           HashRouter: MemoryRouter,    // Treat HashRouter as MemoryRouter for preview (prevents URL changes)
           Routes,
           Route,
           Link,
           NavLink: Link,
           useNavigate,
           useLocation,
           useParams,
           Outlet: () => null
        };
      })();
      
      Object.assign(window, window.ReactRouterDOM);
      
      // Global Error Handler & Terminal Logic
    (function() {
      function sendToParent(type, message, source = 'runtime') {
        window.sendToParent(type, message, source);
      }

      function renderLog(type, args) {
        const msg = args.map(a => 
          typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' ');
        
        // Console log locally for debugging
        // Send to parent for the TerminalPanel
        sendToParent(type, msg);
      }
      
      const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info
      };
      
      console.log = function(...args) { originalConsole.log(...args); renderLog('info', args); };
      console.error = function(...args) { originalConsole.error(...args); renderLog('error', args); };
      console.warn = function(...args) { originalConsole.warn(...args); renderLog('warn', args); };
      
      window.onerror = function(msg, url, line, col, error) {
        const location = (url || 'inline') + ':' + line + ':' + col;
        sendToParent('error', msg + ' at ' + location);
        return false;
      };
      
      window.addEventListener('unhandledrejection', function(e) {
        sendToParent('error', 'Unhandled Promise Rejection: ' + e.reason);
      });
    })();
      
      // Lucide React icons stub - creates simple span placeholders
      window.lucideReact = new Proxy({}, {
        get: function(target, prop) {
          if (prop === '__esModule') return true;
          if (prop === 'default') return target;
          // Return a component that renders an icon placeholder
          return function IconStub(props) {
            const size = props.size || 24;
            return React.createElement('span', {
              className: props.className || '',
              style: { 
                display: 'inline-flex', 
                width: size + 'px', 
                height: size + 'px',
                alignItems: 'center',
                justifyContent: 'center'
              }
            }, '□');
          };
        }
      });

      // Stub common icons globally to prevent ReferenceErrors if transforms fail to rename imports
      window.ChevronRight = window.lucideReact.ChevronRight;
      window.ChevronLeft = window.lucideReact.ChevronLeft;
      window.ChevronsRight = window.lucideReact.ChevronsRight;
      window.ChevronsLeft = window.lucideReact.ChevronsLeft;
      window.MoreHorizontal = window.lucideReact.MoreHorizontal;
      window.Menu = window.lucideReact.Menu;
      window.X = window.lucideReact.X;
      window.Search = window.lucideReact.Search;
      window.User = window.lucideReact.User;
      window.Bell = window.lucideReact.Bell;
      window.Settings = window.lucideReact.Settings;
      window.Loader2 = window.lucideReact.Loader2;

      // Available module paths for resolution
      const modulePaths = ${JSON.stringify(modulePaths)};

      // Prevent internal navigation from breaking the preview
      window.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link) {
          const href = link.getAttribute('href');
          if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !link.target) {
            const url = new URL(href, window.location.href);
            if (url.origin === window.location.origin) {
              e.preventDefault();
              console.warn('[Preview] Internal navigation blocked:', href);
            }
          }
        }
      }, true);

      // Simple module system
      ${moduleRegistryScript}

      const cache = {};

      function resolveRelativePath(fromPath, relativePath) {
        // Handle relative imports like ../components/Navbar
        if (!relativePath.startsWith('.')) return relativePath;
        
        const fromParts = fromPath.split('/');
        fromParts.pop(); // Remove filename
        
        const relativeParts = relativePath.split('/');
        
        for (const part of relativeParts) {
          if (part === '..') {
            fromParts.pop();
          } else if (part !== '.') {
            fromParts.push(part);
          }
        }
        
        return fromParts.join('/');
      }

      // Current module being executed (for relative path resolution)
      let currentModule = null;

      function require(path) {
        // Normalize path
        let normalized = path.replace(/^\\.\\//g, '').replace(/\\.tsx?$/, '');
        if (normalized.startsWith('src/')) normalized = normalized.slice(4);

        // Ignore CSS/Assets - return empty module
        if (normalized.match(/\\.(css|less|scss|sass|svg|png|jpg|jpeg|gif|json|webp|ico)(\\?.*)?$/)) {
          return {};
        }
        
        // Handle React
        if (path === 'react' || path.startsWith('react/')) return React;
        if (path === 'react-dom' || path === 'react-dom/client') return ReactDOM;
        
        // Handle react-router-dom
        if (path === 'react-router-dom') return window.ReactRouterDOM;
        
        // Handle lucide-react
        if (path === 'lucide-react' || path.startsWith('lucide-react/')) return window.lucideReact;
        
        // Handle clsx
        if (path === 'clsx') return { default: window.clsx, clsx: window.clsx };
        
        // Handle tailwind-merge
        if (path === 'tailwind-merge') return { twMerge: window.twMerge, default: window.twMerge };
        
        // Handle class-variance-authority
        if (path === 'class-variance-authority') return { 
          cva: function(base, config) {
            return function(props) { return base + ' ' + (props?.className || ''); };
          }
        };
        
        // Handle framer-motion - return stub
        if (path === 'framer-motion' || path.startsWith('framer-motion/')) {
          return {
            motion: new Proxy({}, {
              get: function(target, prop) {
                return function MotionStub(props) {
                  return React.createElement(prop, { className: props.className, style: props.style }, props.children);
                };
              }
            }),
            AnimatePresence: function(props) { return props.children; },
            useAnimation: function() { return {}; },
            useMotionValue: function(v) { return { get: () => v, set: () => {} }; },
            useTransform: function(v) { return v; },
          };
        }
        
        // Handle date-fns
        if (path === 'date-fns' || path.startsWith('date-fns/')) {
          return {
            format: function(date, fmt) { return date?.toLocaleDateString?.() || ''; },
            parseISO: function(str) { return new Date(str); },
            addDays: function(date, days) { return new Date(date.getTime() + days * 86400000); },
          };
        }
        
        // Handle @radix-ui components - return stub components
        if (path.startsWith('@radix-ui/')) {
          return new Proxy({}, {
            get: function(target, prop) {
              if (prop === '__esModule') return true;
              return function RadixStub(props) {
                return React.createElement('div', { className: props.className }, props.children);
              };
            }
          });
        }
        
        // Handle @/lib/utils and @/components/* paths (common alias patterns)
        if (path.startsWith('@/')) {
          normalized = path.slice(2); // Remove @/
        }

        // Handle relative paths using current module context
        if (path.startsWith('.') && currentModule) {
          normalized = resolveRelativePath(currentModule, path);
        }

        // Check cache
        if (cache[normalized]) return cache[normalized].exports;
        
        // Try to find module with various path variations
        let moduleFn = modules[normalized];
        if (!moduleFn) {
          // Try with /index suffix
          moduleFn = modules[normalized + '/index'];
        }
        if (!moduleFn) {
          // Try finding by basename
          const basename = normalized.split('/').pop();
          for (const key of Object.keys(modules)) {
            if (key.endsWith('/' + basename) || key === basename) {
              moduleFn = modules[key];
              normalized = key;
              break;
            }
          }
        }
        
        if (!moduleFn) {
          console.warn('[Preview] Module not found:', path, '->', normalized);
          return {};
        }
        
        // Execute module with context tracking
        const module = { exports: {} };
        cache[normalized] = module;
        const previousModule = currentModule;
        currentModule = normalized;
        try {
          moduleFn(module.exports, module);
        } catch (e) {
          console.error('[Preview] Error executing module:', normalized, e);
        }
        currentModule = previousModule;
        return module.exports;
      }

      // Debug: List available modules
      console.log('[Preview] Available modules:', Object.keys(modules));

      // Simple Error Boundary for catching render errors
      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { hasError: false, error: null };
        }
        static getDerivedStateFromError(error) {
          return { hasError: true, error };
        }
        componentDidCatch(error, errorInfo) {
          console.error('[Preview] Render error:', error, errorInfo);
        }
        render() {
          if (this.state.hasError) {
            return React.createElement('pre', { 
              className: 'preview-error',
              style: { color: '#ff4444', background: '#1a1a1a', padding: '20px', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }
            }, 'Render Error: ' + (this.state.error?.message || 'Unknown error'));
          }
          return this.props.children;
        }
      }

      // Boot the app
      try {
        const AppModule = require('App');
        const App = AppModule.default || AppModule;
        
        if (!App || typeof App !== 'function') {
          throw new Error('App component not found, not exported, or not a valid component. Available modules: ' + Object.keys(modules).join(', '));
        }
        
        console.log('[Preview] Booting App component...');
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(
          React.createElement(ErrorBoundary, null,
            React.createElement(App)
          )
        );
        console.log('[Preview] App rendered successfully');
      } catch (e) {
        console.error('[Preview] Boot error:', e);
        document.getElementById('root').innerHTML = '<pre style=\"color: #ff4444; background: #1a1a1a; padding: 20px; font-family: monospace; white-space: pre-wrap;\">Boot Error: ' + (e.message || e) + '</pre>';
      }
    })();
  </script>
</body>
</html>`;
}

function escapeForTemplate(code: string): string {
  // Polyfill import.meta.env
  let processed = code.replace(
    /import\.meta\.env/g,
    '{ BASE_URL: "/", DEV: true, MD: true }'
  );

  // Escape closing script tags to prevent breaking the parent script block
  // We do not need to escape backticks or ${} as they are preserved in interpolation
  return processed.replace(/<\/script/gi, '<\\/script');
}

function escapeForHtml(str: string): string {
  // Only escape closing script/style tags to prevent HTML injection
  // Do NOT escape > or < generally as it breaks CSS (e.g. div > span)
  return str.replace(/<\/script/gi, '<\\/script').replace(/<\/style/gi, '<\\/style');
}

function generateErrorHtml(errors: string[]): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #1a1a1a; color: #ff4444; padding: 20px; font-family: monospace; }
    h2 { color: #ff6666; }
    pre { background: #2a2a2a; padding: 15px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <h2>⚠️ Preview Error</h2>
  ${errors.map(e => `<pre>${e.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`).join('')}
</body>
</html>`;
}
