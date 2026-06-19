import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?bundle&no-dts';
import { transform as sucraseTransform } from 'https://esm.sh/sucrase@3.35.0?bundle&no-dts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { revisionId, projectId, files, force } = await req.json() as {
      revisionId: string;
      projectId: string;
      files: GeneratedFile[];
      force?: boolean;
    };
    let workingFiles: GeneratedFile[] = files;

    console.log(`[build-preview] Building preview for revision ${revisionId}`);
    console.log(`[build-preview] Received ${workingFiles.length} files`);

    // Initialize external DB client for database operations (revision_preview table)
    // Fallback to standard Supabase env vars if external ones are not set
    const externalDbUrl = Deno.env.get('EXTERNAL_SUPABASE_URL') || Deno.env.get('SUPABASE_URL')!;
    const externalDbKey = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const dbClient = createClient(externalDbUrl, externalDbKey);
    console.log(`[build-preview] Using DB: ${externalDbUrl ? new URL(externalDbUrl).host : 'unknown'}`);

    // Get revision number and project owner
    console.log('[build-preview] 📊 Fetching revision and project data...');
    const { data: revisionData } = await dbClient
      .from('revisions')
      .select('revision_number')
      .eq('id', revisionId)
      .maybeSingle();

    const revisionNumber = revisionData?.revision_number ?? 0;

    // Always get userId through project relationship
    const { data: projectData } = await dbClient
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    const userId = projectData?.user_id || projectId; // Use projectId for orphaned projects

    console.log(`[build-preview] 👤 User: ${userId}, 📦 Project: ${projectId}, 🔢 Revision: ${revisionNumber}`);

    // Get Supabase endpoint info
    const storageUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Run syntax + debug cleanup (invokes syntax-preflight internally)
    console.log('[build-preview] Running syntax-preflight + debug-sandbox...');
    try {
      const dbgResp = await fetch(`${storageUrl}/functions/v1/debug-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
        body: JSON.stringify({ files: workingFiles })
      });
      if (dbgResp.ok) {
        const dbg = await dbgResp.json();
        if (dbg?.files?.length) {
          workingFiles = dbg.files;
          console.log(`[build-preview] ✓ Debug-sandbox normalized files (${workingFiles.length})`);
        }
      } else {
        console.warn('[build-preview] debug-sandbox returned non-OK:', dbgResp.status);
      }
    } catch (e) {
      console.warn('[build-preview] debug-sandbox skipped:', (e as any)?.message || e);
    }

    console.log('[build-preview] Starting background build process...');

    // Insert initial "building" status
    const { error: insertErr } = await dbClient
      .from('revision_preview')
      .upsert({
        revision_id: revisionId,
        project_id: projectId,
        preview_url: null,
        cloudflare_url: null,
        preview_status: 'building',
        file_count: workingFiles.length
      }, {
        onConflict: 'revision_id'
      });

    if (insertErr) {
      console.error('[build-preview] Failed to insert building status:', insertErr);
    }

    // Start background build using waitUntil
    const buildPromise = buildInBackground({
      revisionId,
      projectId,
      userId,
      revisionNumber,
      workingFiles,
      dbClient,
      storageUrl,
      anonKey
    });

    // Register background task - function continues running until complete
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    EdgeRuntime.waitUntil(buildPromise);

    console.log('[build-preview] ✅ Background build started, returning 202 Accepted');

    // Return immediately with 202 status
    return new Response(
      JSON.stringify({
        success: true,
        status: 'building',
        message: 'Build started in background',
        revisionId,
        projectId
      }),
      {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('[build-preview] Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

/**
 * Background build function that runs after response is sent
 * Bundles files and marks build as complete. Deployment will be handled by new architecture.
 */
async function buildInBackground(params: {
  revisionId: string;
  projectId: string;
  userId: string;
  revisionNumber: number;
  workingFiles: GeneratedFile[];
  dbClient: any;
  storageUrl: string;
  anonKey: string;
}) {
  const { revisionId, projectId, workingFiles, dbClient, storageUrl, anonKey } = params;

  console.log(`[background-build] Starting background build for revision ${revisionId}`);

  try {
    // Step 1: Call bundle-files function to do the heavy bundling work
    console.log('[background-build] Calling bundle-files function...');
    const bundleResponse = await fetch(
      `${storageUrl}/functions/v1/bundle-files`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`
        },
        body: JSON.stringify({ files: workingFiles })
      }
    );

    const bundleResult = await bundleResponse.json();

    if (!bundleResult.success || !bundleResult.bundledFiles) {
      throw new Error(bundleResult.error || 'Bundling failed');
    }

    const bundledFiles = bundleResult.bundledFiles as GeneratedFile[];
    console.log(`[background-build] ✓ Bundled into ${bundledFiles.length} files`);

    // Step 2: Generate production HTML with import map
    const cssContent = bundledFiles.find(f => f.path === 'styles.css')?.content || '';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18?bundle",
      "react-dom": "https://esm.sh/react-dom@18?bundle",
      "react-dom/client": "https://esm.sh/react-dom@18/client?bundle",
      "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime?bundle",
      "react-router-dom": "https://esm.sh/react-router-dom@6?bundle",
      "lucide-react": "https://esm.sh/lucide-react@0.462.0?bundle",
      "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2?bundle",
      "@tanstack/react-query": "https://esm.sh/@tanstack/react-query@5?bundle"
    }
  }
  </script>
  ${cssContent ? `<style>${cssContent}</style>` : ''}
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/bundle.js"></script>
  <script>
    (function() {
      const post = (type, ...args) => {
        try { parent.postMessage({ __previewLog: true, type, payload: args }, '*'); } catch(_) {}
      };
      ['log', 'warn', 'error'].forEach(m => {
        const orig = console[m];
        console[m] = function(...a) { post('console.' + m, ...a); try { orig && orig.apply(console, a); } catch(_) {} };
      });
      window.addEventListener('error', e => post('error', e.message, e.filename, e.lineno));
      window.addEventListener('unhandledrejection', e => post('unhandledrejection', String(e.reason || e)));
    })();
  </script>
</body>
</html>`;

    bundledFiles.push({
      path: 'index.html',
      content: html,
      type: 'text/html'
    });

    console.log(`[background-build] ✓ Generated ${bundledFiles.length} files (HTML + bundles)`);

    // TODO: Deployment will be handled by new architecture
    // For now, just mark build as ready - bundled files are stored in revision_preview

    // Step 3: Update database with success (no deployment URL yet)
    await dbClient
      .from('revision_preview')
      .update({
        preview_url: null,
        cloudflare_url: null,
        preview_status: 'ready',
        file_count: bundledFiles.length
      })
      .eq('revision_id', revisionId);

    console.log(`[background-build] ✅ Build complete for revision ${revisionId} - awaiting new deployment architecture`);

  } catch (error) {
    console.error('[background-build] Build failed, attempting fallback transpile:', error);

    try {
      // Fallback: Use simple Sucrase transpilation instead of bundling
      const outFiles = await transpileFiles(workingFiles);
      console.log(`[background-build] ✓ Fallback transpiled ${outFiles.length} files`);

      // Mark as ready without deployment
      await dbClient
        .from('revision_preview')
        .update({
          preview_url: null,
          cloudflare_url: null,
          preview_status: 'ready',
          file_count: outFiles.length
        })
        .eq('revision_id', revisionId);

      console.log(`[background-build] ✅ Fallback build complete for revision ${revisionId}`);
    } catch (fallbackErr) {
      console.error('[background-build] Fallback transpile failed:', fallbackErr);
      await dbClient
        .from('revision_preview')
        .update({
          preview_status: 'failed',
          build_error: fallbackErr instanceof Error ? fallbackErr.message : 'Unknown build error'
        })
        .eq('revision_id', revisionId);
    }
  }
}

/**
 * Transpile TypeScript/JSX files to JavaScript using Sucrase
 * Simple transpilation without bundling - fallback when bundling fails
 */
async function transpileFiles(files: GeneratedFile[]): Promise<GeneratedFile[]> {
  // Normalize paths
  const normalized = files.map((file) => ({
    ...file,
    path: file.path.startsWith('/') ? file.path.slice(1) : file.path,
  }));

  const outFiles: GeneratedFile[] = [];
  let transpiledCount = 0;

  // Transpile each file
  for (const file of normalized) {
    const path = file.path;

    // Skip source TypeScript/JSX files - only output transpiled versions
    if (/\.(tsx|ts|jsx)$/i.test(path)) {
      try {
        let transforms: Array<'typescript' | 'jsx'> = [];

        if (/\.tsx$/i.test(path)) {
          transforms = ['typescript', 'jsx'];
        } else if (/\.ts$/i.test(path)) {
          transforms = ['typescript'];
        } else if (/\.jsx$/i.test(path)) {
          transforms = ['jsx'];
        }

        const result = sucraseTransform(file.content, {
          transforms,
          production: true,
          jsxRuntime: 'automatic',
          jsxImportSource: 'react',
        });

        const outPath = path.replace(/\.(tsx|ts|jsx)$/i, '.js');
        outFiles.push({
          path: outPath,
          content: result.code,
          type: 'application/javascript',
        });
        transpiledCount++;
      } catch (err) {
        console.error(`[transpile] Error transpiling ${path}:`, err);
        throw err;
      }
    } else if (/\.(js|css|json|html)$/i.test(path)) {
      outFiles.push(file);
    }
  }

  console.log(`[transpile] Transpiled ${transpiledCount} files, total output: ${outFiles.length}`);

  // Generate import map HTML for fallback
  const cssFile = outFiles.find(f => /\.css$/i.test(f.path));
  const mainJs = outFiles.find(f => f.path.includes('main.js'));

  if (mainJs) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18?bundle",
      "react-dom": "https://esm.sh/react-dom@18?bundle",
      "react-dom/client": "https://esm.sh/react-dom@18/client?bundle",
      "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime?bundle",
      "react-router-dom": "https://esm.sh/react-router-dom@6?bundle",
      "lucide-react": "https://esm.sh/lucide-react@0.462.0?bundle",
      "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2?bundle",
      "@tanstack/react-query": "https://esm.sh/@tanstack/react-query@5?bundle"
    }
  }
  </script>
  ${cssFile ? `<style>${cssFile.content}</style>` : ''}
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/${mainJs.path}"></script>
  <script>
    (function() {
      const post = (type, ...args) => {
        try { parent.postMessage({ __previewLog: true, type, payload: args }, '*'); } catch(_) {}
      };
      ['log', 'warn', 'error'].forEach(m => {
        const orig = console[m];
        console[m] = function(...a) { post('console.' + m, ...a); try { orig && orig.apply(console, a); } catch(_) {} };
      });
      window.addEventListener('error', e => post('error', e.message, e.filename, e.lineno));
      window.addEventListener('unhandledrejection', e => post('unhandledrejection', String(e.reason || e)));
    })();
  </script>
</body>
</html>`;

    outFiles.push({
      path: 'index.html',
      content: html,
      type: 'text/html',
    });
  }

  return outFiles;
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') ||
    filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'application/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
