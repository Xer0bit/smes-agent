/**
 * grep tool   search for text patterns in the project workspace.
 * Uses execFileSync (no shell) to prevent command injection from AI-supplied patterns.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

const schema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  path: z.string().optional().describe('Directory or file path to search in (default: project root)'),
  case_sensitive: z.boolean().optional().describe('Whether the search is case-sensitive (default: false)'),
  include_pattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts")'),
});

export const grepTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'grep',
  description:
    'Search for a text pattern across files in the project using regex. Returns matching lines with file names and line numbers.',
  inputSchema: schema,
  getConsentPreview: (args) => `Search for "${args.pattern}" in ${args.path ?? '.'}`,

  execute: async (args, ctx: AgentContext) => {
    const searchPath = args.path ? safeJoin(ctx.appPath, args.path) : ctx.appPath;

    // Build args array   execFileSync bypasses shell entirely,
    // so patterns with $(), backticks, pipes, etc. are safe.
    const grepArgs: string[] = ['-rn'];
    if (!args.case_sensitive) grepArgs.push('-i');
    if (args.include_pattern) grepArgs.push(`--include=${args.include_pattern}`);
    grepArgs.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build');
    // -- terminates options; pattern and path follow as positional args
    grepArgs.push('--', args.pattern, searchPath);

    try {
      const output = execFileSync('grep', grepArgs, {
        cwd: ctx.appPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024 * 2,
      });

      // Make paths relative to project root for readability
      const relativized = output
        .split('\n')
        .map((line) => line.replace(ctx.appPath + '/', ''))
        .join('\n');

      return relativized.trim() || 'No matches found.';
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      // Exit code 1 = no matches (not an error), exit code 2 = real error
      if (e.status === 1) return 'No matches found.';
      const rawMsg: string = e.message ?? String(err);
      // Give the agent actionable context rather than a raw grep error
      if (rawMsg.includes('No such file') || rawMsg.includes('no such file')) {
        return `Error: Path does not exist   "${args.path ?? '.'}". Check the file tree with list_files and use a valid path.`;
      }
      if (rawMsg.includes('Invalid') || rawMsg.includes('repetition') || rawMsg.includes('range')) {
        return `Error: Invalid regex pattern   "${args.pattern}". Simplify the pattern or escape special characters.`;
      }
      return `Error running grep: ${rawMsg}`;
    }
  },
};
