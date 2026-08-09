/**
 * Build Service - Orchestrates build process
 * Extracted from supabase/functions/build-preview/index.ts (buildInBackground)
 */
import { BuildParams, GeneratedFile, BuildStatus } from './types';

/**
 * Generate production HTML with import map
 */
function generateProductionHTML(cssContent: string): string {
  return `<!DOCTYPE html>
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
      // Forward console output to parent - silently fail if sandboxed
      const post = (type, ...args) => {
        try { parent.postMessage({ __previewLog: true, type, payload: args }, '*'); } catch(e) { /* Intentionally silent - iframe may be sandboxed */ }
      };
      ['log', 'warn', 'error'].forEach(m => {
        const orig = console[m];
        console[m] = function(...a) { post('console.' + m, ...a); try { orig && orig.apply(console, a); } catch(e) { /* Fallback silently */ } };
      });
      window.addEventListener('error', e => post('error', e.message, e.filename, e.lineno));
      window.addEventListener('unhandledrejection', e => post('unhandledrejection', String(e.reason || e)));
    })();
  </script>
</body>
</html>`;
}

export const buildService = {
  /**
   * Main background build orchestration
   * Extracted from build-preview/index.ts buildInBackground()
   */
  async buildInBackground(params: BuildParams): Promise<void> {
    const { revisionId, projectId, userId, revisionNumber, workingFiles, dbClient, storageUrl, anonKey } = params;

    console.log(`[BuildService] Starting background build for revision ${revisionId}`);

    try {
      // Step 1: Call bundle-files function to do the heavy bundling work
      console.log('[BuildService] Calling bundle-files function...');
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
      console.log(`[BuildService] ✓ Bundled ${bundledFiles.length} files`);

      // Step 4: Save files to Supabase storage (user-projects-free bucket)
      const { storageService } = await import('@/services/storageService');
      const saveResult = await storageService.saveProjectFiles(
        projectId,
        revisionId,
        bundledFiles.map(f => ({ path: f.path, content: f.content }))
      );

      if (!saveResult.success) {
        throw new Error(saveResult.error || 'Failed to save files to storage');
      }

      console.log(`[BuildService] ✓ Files saved to storage`);

      // Step 5: Generate preview URL (signed URL for index.html)
      const previewUrl = await storageService.getSignedUrl(
        projectId,
        revisionId,
        'index.html'
      );

      // Step 6: Update database with success
      await this.updateBuildStatus(dbClient, revisionId, {
        status: 'ready',
        previewUrl: previewUrl || null,
      });

      console.log(`[BuildService] ✓ Build complete for revision ${revisionId}`);
      if (previewUrl) {
        console.log(`[BuildService] Preview URL: ${previewUrl}`);
      }

    } catch (error) {
      console.error('[BuildService] Build failed:', error);

      // Update database with failure
      await this.updateBuildStatus(dbClient, revisionId, {
        status: 'failed',
        buildError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * Update build status in revision_preview table
   */
  async updateBuildStatus(
    dbClient: any,
    revisionId: string,
    status: BuildStatus
  ): Promise<void> {
    const updateData: any = {
      preview_status: status.status,
      updated_at: new Date().toISOString(),
    };

    if (status.previewUrl) updateData.preview_url = status.previewUrl;
    if (status.cloudflareUrl) updateData.cloudflare_url = status.cloudflareUrl;
    if (status.buildError) updateData.build_error = status.buildError;

    const { error } = await dbClient
      .from('revision_preview')
      .update(updateData)
      .eq('revision_id', revisionId);

    if (error) {
      console.error('[BuildService] Failed to update build status:', error);
      throw error;
    }
  },

  /**
   * Initialize build status in database
   */
  async initializeBuildStatus(
    dbClient: any,
    revisionId: string,
    projectId: string
  ): Promise<void> {
    const { error } = await dbClient
      .from('revision_preview')
      .upsert({
        revision_id: revisionId,
        project_id: projectId,
        preview_status: 'building',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'revision_id',
      });

    if (error) {
      console.error('[BuildService] Failed to initialize build status:', error);
      throw error;
    }
  },
};
