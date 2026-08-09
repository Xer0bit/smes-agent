export function normalizeProjectFiles(files: any[]) {
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
}
