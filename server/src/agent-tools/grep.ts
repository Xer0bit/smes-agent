/**
 * grep tool — search for text patterns in the project workspace.
 * Uses execFileSync (no shell) to prevent command injection from AI-supplied patterns.
 * Mirrors Claude Code's Grep tool shape: output_mode + context lines.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

const schema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  path: z.string().optional().describe('Directory or file path to search in (default: project root)'),
  case_sensitive: z.boolean().optional().describe('Whether the search is case-sensitive (default: false)'),
  include_pattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts")'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .describe('"content" = matching lines (default), "files_with_matches" = just file paths, "count" = match counts per file'),
  context_lines: z.number().optional().describe('Lines of context to show before AND after each match (only for output_mode=content)'),
});

export const grepTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'grep',
  description:
    'Search for a text pattern across files in the project using regex. Returns matching lines with file names and line numbers. ' +
    'Use output_mode="files_with_matches" to just get file paths (cheaper when you don\'t need the line content), or ' +
    'context_lines to see surrounding code around each match.',
  inputSchema: schema,
  getConsentPreview: (args) => `Search for "${args.pattern}" in ${args.path ?? '.'}`,

  execute: async (args, ctx: AgentContext) => {
    const searchPath = args.path ? safeJoin(ctx.appPath, args.path) : ctx.appPath;

    // Build args array — execFileSync bypasses shell entirely,
    // so patterns with $(), backticks, pipes, etc. are safe.
    const grepArgs: string[] = ['-rn'];
    if (!args.case_sensitive) grepArgs.push('-i');
    if (args.include_pattern) grepArgs.push(`--include=${args.include_pattern}`);
    grepArgs.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build');

    const outputMode = args.output_mode ?? 'content';
    if (outputMode === 'files_with_matches') grepArgs.push('-l');
    else if (outputMode === 'count') grepArgs.push('-c');
    else if (args.context_lines && args.context_lines > 0) grepArgs.push(`-C${Math.min(args.context_lines, 20)}`);

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
      let relativized = output
        .split('\n')
        .map((line) => line.replace(ctx.appPath + '/', ''))
        .join('\n')
        .trim();

      // grep -c prints "path:0" for files with zero matches when run with -r
      // over a glob-filtered set; strip those to keep the result signal-only.
      if (outputMode === 'count') {
        relativized = relativized
          .split('\n')
          .filter((line) => !/:0$/.test(line))
          .join('\n');
      }

      return relativized || 'No matches found.';
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      // Exit code 1 = no matches (not an error), exit code 2 = real error
      if (e.status === 1) return 'No matches found.';
      const rawMsg: string = e.message ?? String(err);
      // Give the agent actionable context rather than a raw grep error
      if (rawMsg.includes('No such file') || rawMsg.includes('no such file')) {
        return `Error: Path does not exist — "${args.path ?? '.'}". Check the file tree with list_files and use a valid path.`;
      }
      if (rawMsg.includes('Invalid') || rawMsg.includes('repetition') || rawMsg.includes('range')) {
        return `Error: Invalid regex pattern — "${args.pattern}". Simplify the pattern or escape special characters.`;
      }
      return `Error running grep: ${rawMsg}`;
    }
  },
};
