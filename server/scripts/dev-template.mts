/**
 * Materialize server/agent-template/ into a local, runnable Vite project and
 * start its dev server -- so eCG dashboard template changes can be eyeballed
 * on localhost instead of push-to-VPS3-and-hope.
 *
 * Run with: npx tsx scripts/dev-template.mts [--theme=light] [--agents=1] [--port=5199] [--empty] [--llm]
 *
 * Themes: light | dark | ocean | forest | sunset | slate (THEME_DEFAULTS in
 * ecg-template.ts). --agents=2 seeds a second agent so the AgentSwitcher shows.
 *
 * By default this also starts a tiny local mock API (local-mock-api.mts) on
 * the proxy port, serving realistic fixture data -- agents, posts in every
 * status, connectors, schedulers, runs, knowledge -- so every page shows its
 * POPULATED state instead of an EmptyState. Pass --empty to skip the mock API
 * and see the bare empty/first-run view instead.
 *
 * --llm simulates a project with an AI model configured, so the Create Agent
 * wizard's "Preview a sample post" returns a real sample instead of the
 * graceful "not available" state (the honest default, since most projects
 * won't have this set -- see App Builder -> AI Model).
 *
 * Output lands in server/agent-template-preview.local/ (gitignored via the
 * repo's `*.local` rule) -- safe to delete any time, it's fully regenerated
 * on every run.
 */
import { initProjectFromTemplate } from '../src/services/baseTemplateService.js';
import { seedEcgTemplate } from '../src/services/ecg-template.js';
import { startMockApi } from './local-mock-api.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// initProjectFromTemplate()'s ensureBaseTemplate() runs a buffered `npm
// install` (execAsync, not inherited stdio) into ~/.ecomgear/base-template/
// the first time it's ever called on a machine -- nothing prints until it
// finishes, which can take a minute or more and looks exactly like a hang.
// Warn up front so that wait isn't mistaken for a broken script.
const baseTemplateDir = process.env.BASE_TEMPLATE_DIR || path.join(os.homedir(), '.ecomgear', 'base-template');
if (!fs.existsSync(path.join(baseTemplateDir, 'node_modules'))) {
  console.log(`[dev-template] First run on this machine: building the shared base template into ${baseTemplateDir}`);
  console.log('[dev-template] This runs `npm install` with no live progress output -- can take 1-3 min. Not stuck, just quiet.');
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const theme = arg('theme', 'light');
const agentCount = Math.max(1, Number(arg('agents', '1')) || 1);
const port = arg('port', '5199');
const empty = process.argv.includes('--empty');
const llm = process.argv.includes('--llm');
const apiPort = 5001;

const outDir = path.resolve(__dirname, '../agent-template-preview.local');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await initProjectFromTemplate(outDir);
console.log('[dev-template] Base scaffold + node_modules ready');

const agentIds = Array.from({ length: agentCount }, (_, i) => `preview-agent-${i + 1}`);
const agentNames = Object.fromEntries(agentIds.map((id, i) => [id, i === 0 ? 'LinkedIn Growth' : `Test Agent ${i + 1}`]));

const files = seedEcgTemplate(outDir, {
  orgName: 'Preview Org',
  modules: [],
  agentIds,
  agentNames,
  config: { theme },
  projectId: 'local-preview',
  proxyUrl: 'http://localhost:5001',
});
for (const [rel, content] of Object.entries(files)) {
  const full = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}
console.log(`[dev-template] Overlaid ${Object.keys(files).length} template files (theme=${theme}, agents=${agentCount})`);

let apiServer: ReturnType<typeof startMockApi> | null = null;
if (empty) {
  console.log(`[dev-template] --empty: no mock API -- every page will show its EmptyState.`);
} else {
  apiServer = startMockApi(apiPort, agentIds, agentNames, llm);
  console.log(`[dev-template] Local mock API on http://localhost:${apiPort} -- pages will show populated fixture data.`);
}
console.log(`[dev-template] Starting Vite on http://127.0.0.1:${port}`);

const vite = spawn('npx', ['vite', '--port', port, '--host', '127.0.0.1'], { cwd: outDir, stdio: 'inherit' });
vite.on('exit', code => { apiServer?.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => { apiServer?.close(); vite.kill('SIGINT'); });
