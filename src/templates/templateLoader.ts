/**
 * Vite React Template Loader
 * 
 * Provides pre-built, SEO-optimized template files for new projects.
 * The App Builder uses this instead of generating boilerplate from scratch.
 */

export interface TemplateFile {
  path: string;
  content: string;
}

export const VITE_REACT_TEMPLATE: TemplateFile[] = [
  {
    path: "package.json",
    content: `{
  "name": "vite-react-app",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.18",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1",
    "tailwindcss-animate": "^1.0.7",
    "typescript": "^5.2.2",
    "vite": "^5.0.8"
  }
}`
  },
  {
    path: "tailwind.config.ts",
    content: `/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Legacy support
        coffee: {
          50: '#fafaf9',
          100: '#f5f5f4',
          200: '#e7e5e4',
          300: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          600: '#57534e',
          700: '#44403c',
          800: '#292524',
          900: '#1c1917',
          950: '#0c0a09',
        }
      }
    },
  },
  plugins: [require("tailwindcss-animate")],
}`
  },
  {
    path: "postcss.config.js",
    content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`
  },
  {
    path: "vite.config.ts",
    content: `import { defineConfig } from 'vite'
import path from "path"
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: true },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: { outDir: 'dist', sourcemap: true }
})`
  },
  {
    path: "tsconfig.json",
    content: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}`
  },
  {
    path: "tsconfig.node.json",
    content: `{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}`
  },
  {
    path: "index.html",
    content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <meta name="description" content="A modern web application" />
    <meta property="og:title" content="My App" />
    <meta property="og:description" content="A modern web application" />
    <meta name="twitter:card" content="summary_large_image" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <meta name="theme-color" content="#3b82f6" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`
  },
  {
    path: "src/main.tsx",
    content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`
  },
  {
    path: "src/App.tsx",
    content: `import React from 'react'
import './App.css'

function App() {
  return (
    <div className="app">
      <header className="header">
        <h1>Home</h1>
      </header>
      <main className="content">
        <p>Your content here.</p>
      </main>
    </div>
  )
}

export default App`
  },
  {
    path: "src/App.css",
    content: `.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  text-align: center;
  padding: 2rem;
}

.hero h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.hero p {
  font-size: 1.25rem;
  opacity: 0.9;
}

.content {
  margin-top: 2rem;
  background: rgba(255,255,255,0.1);
  padding: 1.5rem 2rem;
  border-radius: 12px;
  backdrop-filter: blur(10px);
}

.content code {
  background: rgba(0,0,0,0.2);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-family: monospace;
}`
  },
  {
    path: "src/index.css",
    content: `*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html { scroll-behavior: smooth; }
body {
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: #f7fafc;
  color: #1a202c;
}
#root { min-height: 100vh; }
::selection { background: #667eea; color: white; }`
  }
];

/**
 * Get all template files for initializing a new project
 */
export function getTemplateFiles(): TemplateFile[] {
  return VITE_REACT_TEMPLATE;
}

/**
 * Convert template files to workspace format
 */
export function templateToWorkspace(): Map<string, string> {
  const workspace = new Map<string, string>();
  VITE_REACT_TEMPLATE.forEach(file => {
    workspace.set(file.path, file.content);
  });
  return workspace;
}
