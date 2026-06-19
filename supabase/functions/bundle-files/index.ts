import * as esbuild from 'https://deno.land/x/esbuild@v0.20.1/wasm.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface GeneratedFile {
  path: string;
  content: string;
  type?: string;
}

interface BundleRequest {
  files: GeneratedFile[];
  entryPoint?: string;
}

interface BundleResponse {
  success: boolean;
  bundledFiles?: GeneratedFile[];
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { files, entryPoint } = await req.json() as BundleRequest;
    
    console.log(`[bundle-files] Bundling ${files.length} files`);
    
    // Initialize esbuild-wasm
    await esbuild.initialize({
      wasmURL: "https://deno.land/x/esbuild@v0.20.1/esbuild.wasm",
      worker: false
    });
    
    console.log('[bundle-files] esbuild initialized');

    // Create virtual filesystem for esbuild
    const virtualFS: Record<string, string> = {};
    files.forEach(file => {
      const normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
      virtualFS[normalizedPath] = file.content;
    });

    // Find entry point
    const entry = entryPoint || files.find(f => 
      f.path.match(/src\/main\.(tsx|ts|jsx|js)$/)
    )?.path.replace(/^\//, '') || 'src/main.tsx';

    console.log(`[bundle-files] Entry point: ${entry}`);

    // Bundle with esbuild
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      platform: 'browser',
      write: false,
      plugins: [
        {
          name: 'virtual-fs',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              // Normalize helper
              const normalize = (p: string) => {
                let out = p.replace(/^\/+/, '');
                out = out.replace(/\/\.\//g, '/');
                while (out.includes('/../')) out = out.replace(/\/[^/]+\/\.\.\//g, '/');
                return out;
              };

              // Entry point - no importer
              if (!args.importer) {
                const p1 = normalize(args.path);
                if (virtualFS[p1]) return { path: p1, namespace: 'virtual' };
              }
              
              // Handle relative imports
              if (args.path.startsWith('.')) {
                const importer = normalize(args.importer || '');
                const dir = importer.split('/').slice(0, -1).join('/');
                let resolved = dir ? `${dir}/${args.path}` : args.path;
                resolved = normalize(resolved);
                
                // Try with and without extensions
                for (const ext of ['', '.tsx', '.ts', '.jsx', '.js']) {
                  const withExt = resolved + ext;
                  if (virtualFS[withExt]) return { path: withExt, namespace: 'virtual' };
                }
              }
              
              // Handle @/ alias
              if (args.path.startsWith('@/')) {
                const aliasPath = normalize(args.path.replace('@/', 'src/'));
                for (const ext of ['', '.tsx', '.ts', '.jsx', '.js']) {
                  const withExt = aliasPath + ext;
                  if (virtualFS[withExt]) return { path: withExt, namespace: 'virtual' };
                }
              }

              // Handle absolute imports from src/
              const cleanPath = normalize(args.path.replace(/^\//, ''));
              for (const ext of ['', '.tsx', '.ts', '.jsx', '.js']) {
                const withExt = cleanPath + ext;
                if (virtualFS[withExt]) return { path: withExt, namespace: 'virtual' };
              }

              // External dependencies (React, etc.)
              if (!args.path.startsWith('.') && !args.path.startsWith('/') && !args.path.startsWith('@/')) {
                return { path: args.path, external: true };
              }

              console.warn(`[virtual-fs] Could not resolve: ${args.path} from ${args.importer}`);
              return null;
            });

            build.onLoad({ filter: /.*/, namespace: 'virtual' }, args => {
              const content = virtualFS[args.path];
              if (!content) {
                return { errors: [{ text: `File not found: ${args.path}` }] };
              }
              
              return {
                contents: content,
                loader: args.path.endsWith('.tsx') ? 'tsx' :
                        args.path.endsWith('.ts') ? 'ts' :
                        args.path.endsWith('.jsx') ? 'jsx' :
                        args.path.endsWith('.css') ? 'css' : 'js'
              };
            });
          }
        }
      ],
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react-router-dom',
        'lucide-react',
        '@supabase/supabase-js',
        '@tanstack/react-query'
      ]
    });

    console.log(`[bundle-files] Bundle complete: ${result.outputFiles.length} output files`);

    // Extract bundled files
    const bundledFiles: GeneratedFile[] = [];
    
    for (const file of result.outputFiles) {
      bundledFiles.push({
        path: 'bundle.js',
        content: new TextDecoder().decode(file.contents),
        type: 'application/javascript'
      });
    }

    // Extract CSS
    const cssFile = files.find(f => f.path === 'src/index.css' || f.path === '/src/index.css');
    if (cssFile) {
      bundledFiles.push({
        path: 'styles.css',
        content: cssFile.content,
        type: 'text/css'
      });
    }

    // Stop esbuild
    esbuild.stop();

    const response: BundleResponse = {
      success: true,
      bundledFiles
    };

    return new Response(
      JSON.stringify(response),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('[bundle-files] Error:', error);
    
    // Make sure to stop esbuild even on error
    try {
      esbuild.stop();
    } catch (e) {
      console.error('[bundle-files] Error stopping esbuild:', e);
    }

    const response: BundleResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown bundling error'
    };

    return new Response(
      JSON.stringify(response),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
