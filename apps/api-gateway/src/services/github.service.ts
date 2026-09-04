import { Octokit } from '@octokit/rest';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { projectService } from './project.service.js';

export interface GithubExportResult {
  repoUrl: string;
}

export interface FileItem {
  path: string;
  content: string;
}

/**
 * Programmatically exports sandboxed project files to a user's GitHub repository.
 */
export async function exportToGithub(
  projectId: string,
  userId: string,
  githubToken: string,
  repoName: string,
  isPrivate: boolean = true
): Promise<GithubExportResult> {
  if (!githubToken || !githubToken.trim()) {
    throw new Error('GitHub Personal Access Token is required');
  }

  if (!repoName || !repoName.trim()) {
    throw new Error('Repository name is required');
  }

  // Step 0: Verify project ownership/access -- was previously fetched by
  // project_id alone with no owner check, letting any authenticated user
  // export any other user's generated source (IDOR).
  await projectService.getProject(projectId, userId);

  // Step 1: Initialize Octokit client with user's PAT
  const octokit = new Octokit({
    auth: githubToken.trim(),
  });

  // Step 2: Fetch latest project files from Supabase revisions table
  const { data: revision, error: revError } = await supabase
    .from('revisions')
    .select('generated_files')
    .eq('project_id', projectId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (revError) {
    logger.error(`[exportToGithub] Error reading revision for project ${projectId}: ${revError.message}`);
    throw new Error(`Failed to fetch project revision: ${revError.message}`);
  }

  if (!revision || !revision.generated_files) {
    throw new Error('No code generated yet for this project');
  }

  const gf = revision.generated_files;
  let parsedFiles: FileItem[] = [];

  // Parse generated_files JSONB payload across potential structural formats
  if (Array.isArray(gf)) {
    parsedFiles = gf.map((item: any) => ({
      path: String(item.file || item.path || '').trim(),
      content: String(item.data || item.content || ''),
    }));
  } else if (gf && typeof gf === 'object' && Array.isArray((gf as any).files)) {
    parsedFiles = (gf as any).files.map((item: any) => ({
      path: String(item.file || item.path || '').trim(),
      content: String(item.data || item.content || ''),
    }));
  } else if (gf && typeof gf === 'object') {
    parsedFiles = Object.entries(gf).map(([filepath, content]) => ({
      path: filepath.trim(),
      content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    }));
  }

  // Filter out invalid empty paths
  parsedFiles = parsedFiles.filter((f) => f.path.length > 0);

  if (parsedFiles.length === 0) {
    throw new Error('No valid project files found to export');
  }

  // Inject default boilerplate if missing
  const existingPaths = new Set(parsedFiles.map((f) => f.path.replace(/^\//, '')));
  if (!existingPaths.has('package.json')) {
    parsedFiles.push({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          private: isPrivate,
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
          },
        },
        null,
        2
      ),
    });
  }

  if (!existingPaths.has('README.md')) {
    parsedFiles.push({
      path: 'README.md',
      content: `# ${repoName}\n\nExported from [SMEsAgent AI IDE](https://SMEsAgent.dev).\n`,
    });
  }

  // Step 3: Create a new repository for the authenticated user
  const sanitizedRepoName = repoName.trim().replace(/\s+/g, '-');
  logger.info(`[exportToGithub] Creating repository "${sanitizedRepoName}" (private: ${isPrivate})`);

  let repo;
  try {
    const response = await octokit.rest.repos.createForAuthenticatedUser({
      name: sanitizedRepoName,
      private: isPrivate,
      auto_init: true,
      description: 'Generated with SMEsAgent AI IDE',
    });
    repo = response.data;
  } catch (err: any) {
    logger.error(`[exportToGithub] Failed to create repository "${sanitizedRepoName}": ${err?.message}`);
    if (err?.status === 422) {
      throw new Error(`Repository name "${sanitizedRepoName}" already exists on your GitHub account`);
    } else if (err?.status === 401) {
      throw new Error('Invalid or expired GitHub Personal Access Token');
    }
    throw new Error(`GitHub API error: ${err?.message || 'Failed to create repository'}`);
  }

  // Step 4: Commit files to the newly created repository
  logger.info(`[exportToGithub] Committing ${parsedFiles.length} files to ${repo.html_url}`);

  for (const file of parsedFiles) {
    const cleanPath = file.path.replace(/^\//, '');
    if (!cleanPath) continue;

    let existingSha: string | undefined;
    try {
      const existingFile = await octokit.rest.repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: cleanPath,
      });

      if (!Array.isArray(existingFile.data) && 'sha' in existingFile.data) {
        existingSha = existingFile.data.sha;
      }
    } catch {
      // File does not exist in repo yet
    }

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: repo.owner.login,
        repo: repo.name,
        path: cleanPath,
        message: `Add ${cleanPath} via SMEsAgent AI IDE`,
        content: Buffer.from(file.content).toString('base64'),
        sha: existingSha,
      });
    } catch (commitErr: any) {
      logger.warn(`[exportToGithub] Failed to commit file "${cleanPath}": ${commitErr?.message}`);
    }
  }

  logger.info(`[exportToGithub] Export complete for project ${projectId}: ${repo.html_url}`);

  return { repoUrl: repo.html_url };
}

/**
 * Helper function for agent-tools / internal tool invocation.
 */
export async function pushFilesToGithub(
  userId: string,
  projectId: string,
  files: Array<{ path: string; content: string }>
): Promise<{ success: boolean; error?: string; filesPushed?: number; commitUrl?: string }> {
  try {
    const githubToken = process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      return { success: false, error: 'GITHUB_TOKEN environment variable not set' };
    }
    const repoName = `SMEsAgent-export-${projectId.slice(0, 8)}`;
    const result = await exportToGithub(projectId, userId, githubToken, repoName, true);
    return {
      success: true,
      filesPushed: files.length,
      commitUrl: result.repoUrl,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to push files to GitHub',
    };
  }
}
