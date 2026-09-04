/**
 * shadcn_component tool + template integrity.
 *
 * The templates in SHADCN_COMPONENT_TEMPLATES are plain strings to the
 * compiler, so a syntax error inside one would ship silently to every model
 * that calls the tool. Every entry is transpiled here as real TSX to catch
 * that class. The tool itself is also exercised for its three branches.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { SHADCN_COMPONENT_TEMPLATES } from '../../prompts/shadcn-templates.js';
import { shadcnComponentTool } from '../shadcn_component.js';

const PREBUILT = new Set([
  'src/components/ui/button.tsx', 'src/components/ui/card.tsx', 'src/components/ui/input.tsx',
  'src/components/ui/label.tsx', 'src/components/ui/badge.tsx', 'src/components/ui/textarea.tsx',
  'src/components/ui/separator.tsx', 'src/components/ui/avatar.tsx', 'src/components/ui/dialog.tsx',
  'src/components/ui/select.tsx', 'src/components/ui/tabs.tsx', 'src/components/ui/table.tsx',
  'src/lib/utils.ts',
]);

describe('SHADCN_COMPONENT_TEMPLATES integrity', () => {
  it('every stored template transpiles as valid TSX (no syntax errors)', () => {
    const bad: string[] = [];
    for (const [path, content] of Object.entries(SHADCN_COMPONENT_TEMPLATES)) {
      const result = ts.transpileModule(content, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2020,
          // Report as a real file so file-level diagnostics are included.
        },
        reportDiagnostics: true,
        fileName: path,
      });
      const diags = (result.diagnostics ?? []).filter((d) => d.file);
      if (diags.length > 0) {
        bad.push(`${path}: ${diags.map((d) => d.messageText).join('; ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('serves at least the components the prompt tells the model to fetch', () => {
    for (const name of ['accordion', 'checkbox', 'switch', 'tooltip', 'progress', 'scroll-area', 'slider']) {
      expect(SHADCN_COMPONENT_TEMPLATES[`src/components/ui/${name}.tsx`], name).toBeTruthy();
    }
  });
});

describe('shadcnComponentTool', () => {
  const ctx = {} as any;

  it('returns the exact file content for an available component', async () => {
    const out = await shadcnComponentTool.execute({ name: 'checkbox' }, ctx);
    expect(out).toContain('src/components/ui/checkbox.tsx');
    expect(out).toContain('@radix-ui/react-checkbox');
    expect(out).toContain(SHADCN_COMPONENT_TEMPLATES['src/components/ui/checkbox.tsx']);
  });

  it('normalizes .tsx suffix and path prefixes', async () => {
    const out = await shadcnComponentTool.execute({ name: 'src/components/ui/switch.tsx' }, ctx);
    expect(out).toContain('@radix-ui/react-switch');
  });

  it('tells the model to import pre-built components, never rewrite them', async () => {
    const out = await shadcnComponentTool.execute({ name: 'button' }, ctx);
    expect(out).toContain('PRE-BUILT');
    expect(out).not.toContain('Exact source');
  });

  it('reports unavailable components and lists what IS available (non-prebuilt only)', async () => {
    const out = await shadcnComponentTool.execute({ name: 'context-menu' }, ctx);
    expect(out).toContain('No tested template available');
    expect(out).toContain('slider');
    // the availability list must not advertise pre-built components
    const availLine = out.split('\n').find((l) => l.startsWith('Available on-demand templates:'));
    expect(availLine).toBeTruthy();
    expect(availLine!).not.toMatch(/\b(button|card|dialog|select|tabs|table|utils\.ts)\b/);
  });
});
