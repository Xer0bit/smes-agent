/**
 * shadcn_component tool — return the exact, tested source for a shadcn/ui
 * component on demand, instead of making the model re-author it from memory
 * (which produced subtle inconsistencies across projects and runs).
 *
 * The scaffold pre-builds exactly 12 shadcn primitives + src/lib/utils.ts.
 * Everything else the model used to write from memory against conventions.
 * This serves the canonical file for the commonly-needed remainder, matching
 * this platform's Vite + Tailwind + pre-installed @radix-ui versions.
 *
 * Kept as a separate read-only tool (rather than a giant prompt block) so the
 * ~6-8K tokens of component source are only paid when a component is actually
 * needed. One small tool schema per step is far cheaper than the templates in
 * the system prompt every turn.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { SHADCN_COMPONENT_TEMPLATES } from '../prompts/shadcn-templates.js';

const schema = z.object({
  name: z
    .string()
    .describe(
      'shadcn/ui component name. Examples: "checkbox", "accordion", "switch", "tooltip", "progress", "scroll-area", "slider". Do NOT request the 12 pre-built components (button, card, input, label, badge, textarea, separator, avatar, dialog, select, tabs, table) or utils — those already exist in the scaffold; import them directly.'
    ),
});

const PREBUILT_HINT =
  'button, card, input, label, badge, textarea, separator, avatar, dialog, select, tabs, table and utils.ts are PRE-BUILT in every project: import them, never request or rewrite them.';

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.tsx?$/, '')
    .replace(/^.*\//, '');
}

export const shadcnComponentTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'shadcn_component',
  description:
    'Get the exact, tested source for a shadcn/ui component file. Call this BEFORE writing ANY shadcn/ui component that is not one of the 12 pre-built ones. Pass the component name (e.g. "checkbox", "accordion", "switch", "tooltip", "progress", "scroll-area", "slider"); it returns the full file content to write to src/components/ui/<name>.tsx, with the correct @radix-ui imports and cn() usage. If it returns "not available", author the component yourself using React.forwardRef, cn from @/lib/utils, and a displayName.',
  inputSchema: schema,
  getConsentPreview: (args) => `Fetch the exact shadcn/ui source for "${args.name}"`,

  execute: async (args, _ctx: AgentContext) => {
    const name = normalizeName(args.name);
    const PREBUILT_KEYS = new Set([
      'src/components/ui/button.tsx', 'src/components/ui/card.tsx', 'src/components/ui/input.tsx',
      'src/components/ui/label.tsx', 'src/components/ui/badge.tsx', 'src/components/ui/textarea.tsx',
      'src/components/ui/separator.tsx', 'src/components/ui/avatar.tsx', 'src/components/ui/dialog.tsx',
      'src/components/ui/select.tsx', 'src/components/ui/tabs.tsx', 'src/components/ui/table.tsx',
      'src/lib/utils.ts',
    ]);
    const key = `src/components/ui/${name}.tsx`;
    if (PREBUILT_KEYS.has(key)) {
      return `\`${name}\` is a PRE-BUILT shadcn/ui component: it already exists in every project scaffold. Import it directly (e.g. \`import { ${name[0].toUpperCase() + name.slice(1)} } from "@/components/ui/${name}"\`); do NOT request or rewrite it.`;
    }
    const content = SHADCN_COMPONENT_TEMPLATES[key];
    if (content) {
      return (
        `Exact source for the shadcn/ui \`${name}\` component.\n` +
        `Write this EXACT content to \`${key}\` with write_file (do not modify it, do not rewrite existing pre-built files):\n\n` +
        '```tsx\n' +
        content +
        '\n```'
      );
    }
    const available = Object.keys(SHADCN_COMPONENT_TEMPLATES)
      .filter((k) => !PREBUILT_KEYS.has(k))
      .map((k) => k.replace('src/components/ui/', '').replace('.tsx', ''))
      .join(', ');
    return (
      `No tested template available for shadcn/ui "${name}". ${PREBUILT_HINT}\n` +
      `Available on-demand templates: ${available}.\n` +
      'For any other component, author it per the conventions: `import * as React from "react"`, `cn` from `@/lib/utils`, `React.forwardRef` for leaf components, `.displayName` set, matching the shadcn/ui API of the installed @radix-ui package.'
    );
  },
};
