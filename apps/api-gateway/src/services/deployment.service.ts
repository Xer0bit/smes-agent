import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { projectService } from './project.service.js';

export interface DeploymentResult {
  deploymentUrl: string;
}

export interface VercelFile {
  file: string;
  data: string;
}

/**
 * Deploy a sandboxed eComGear project to Vercel via Vercel Deployments API (v13).
 */
export async function deployProject(projectId: string, userId: string): Promise<DeploymentResult> {
  // Step 0: Verify project ownership/access
  await projectService.getProject(projectId, userId);

  // Step 1: Fetch the latest project files from Supabase revisions table
  const { data: revision, error: revError } = await supabase
    .from('revisions')
    .select('generated_files')
    .eq('project_id', projectId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (revError) {
    logger.error(`[deployProject] Error querying revisions for ${projectId}: ${revError.message}`);
    throw new Error(`Failed to read project revision: ${revError.message}`);
  }

  if (!revision || !revision.generated_files) {
    throw new Error('No code generated yet');
  }

  const gf = revision.generated_files;
  let parsedFiles: VercelFile[] = [];

  // Parse generated_files JSONB payload across potential structural formats
  if (Array.isArray(gf)) {
    parsedFiles = gf.map((item: any) => ({
      file: String(item.file || item.path || '').trim(),
      data: String(item.data || item.content || ''),
    }));
  } else if (gf && typeof gf === 'object' && Array.isArray((gf as any).files)) {
    parsedFiles = (gf as any).files.map((item: any) => ({
      file: String(item.file || item.path || '').trim(),
      data: String(item.data || item.content || ''),
    }));
  } else if (gf && typeof gf === 'object') {
    parsedFiles = Object.entries(gf).map(([filepath, content]) => ({
      file: filepath.trim(),
      data: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    }));
  }

  // Filter out any entries missing valid filenames
  parsedFiles = parsedFiles.filter((f) => f.file.length > 0);

  if (parsedFiles.length === 0) {
    throw new Error('No code generated yet');
  }

  // Step 2: Construct payload and inject standard Vite/React boilerplate files if missing
  const filePaths = new Set(parsedFiles.map((f) => f.file.replace(/^\//, '')));

  if (!filePaths.has('package.json')) {
    const defaultPackageJson = {
      name: `ecomgear-project-${projectId.slice(0, 8)}`,
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        'lucide-react': '^0.344.0',
      },
      devDependencies: {
        '@types/react': '^18.3.3',
        '@types/react-dom': '^18.3.0',
        '@vitejs/plugin-react': '^4.3.1',
        typescript: '^5.5.3',
        vite: '^5.4.1',
      },
    };
    parsedFiles.push({
      file: 'package.json',
      data: JSON.stringify(defaultPackageJson, null, 2),
    });
  }

  if (!filePaths.has('vite.config.ts') && !filePaths.has('vite.config.js')) {
    const defaultViteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;
    parsedFiles.push({
      file: 'vite.config.ts',
      data: defaultViteConfig,
    });
  }

  if (!filePaths.has('index.html')) {
    // Default the title to the project's real name, not a generic "App".
    let fallbackTitle = 'Web App';
    try {
      const { data: proj } = await supabase
        .from('projects')
        .select('name, website_name')
        .eq('id', projectId)
        .maybeSingle();
      fallbackTitle = ((proj?.website_name || proj?.name) as string)?.trim() || fallbackTitle;
    } catch { /* keep the neutral default */ }
    const defaultIndexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${fallbackTitle}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
    parsedFiles.push({
      file: 'index.html',
      data: defaultIndexHtml,
    });
  }

  const vercelFiles = parsedFiles.map((f) => ({
    file: f.file.replace(/^\//, ''),
    data: f.data,
  }));

  const projectName = `ecg-${projectId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase().slice(0, 20)}`;

  const payload = {
    name: projectName,
    files: vercelFiles,
    projectSettings: {
      framework: 'vite',
    },
  };

  // Step 3: Make authenticated call to Vercel Deployments API
  const vercelToken = process.env.VERCEL_API_TOKEN;
  if (!vercelToken) {
    logger.error('[deployProject] VERCEL_API_TOKEN environment variable is not set');
    throw new Error('VERCEL_API_TOKEN environment variable is not configured');
  }

  logger.info(`[deployProject] Dispatching ${vercelFiles.length} files for project ${projectId} to Vercel API`);

  const response = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let errorMessage = `Vercel API error (${response.status})`;

    try {
      const errJson = JSON.parse(errorText);
      if (errJson.error?.message) {
        errorMessage = `Vercel API error: ${errJson.error.message}`;
      } else if (errJson.message) {
        errorMessage = `Vercel API error: ${errJson.message}`;
      }
    } catch {
      if (errorText) {
        errorMessage += `: ${errorText.slice(0, 250)}`;
      }
    }

    logger.error(`[deployProject] Vercel API request failed: ${errorMessage}`);
    throw new Error(errorMessage);
  }

  // Step 4: Extract and return deployment URL
  const vercelData = (await response.json()) as { url: string };
  if (!vercelData || !vercelData.url) {
    throw new Error('Vercel API response missing deployment url field');
  }

  const rawUrl = vercelData.url;
  const deploymentUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
    ? rawUrl
    : `https://${rawUrl}`;

  logger.info(`[deployProject] Deployment successful for project ${projectId}: ${deploymentUrl}`);

  return { deploymentUrl };
}
