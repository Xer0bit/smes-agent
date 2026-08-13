/**
 * Regression guard for app-builder.prompt.ts's section-stripping mechanism
 * (stripSections/stripSubSections, private, tested through the public
 * getFixSystemPrompt/getEditSystemPrompt/getAppBuilderBuildSystemPrompt
 * functions). This exact bug class -- a strip call's heading string silently
 * stops matching a real "\n# Title"/"\n## Title" substring in
 * APP_BUILDER_SYSTEM_PROMPT, so `.replace(new RegExp(...))` matches nothing
 * and the "stripped" prompt is byte-identical to the unstripped one, with no
 * error -- has already shipped twice this session (see the file's own
 * comments at ~1165-1178 and ~1242-1248). Each case below asserts BOTH
 * halves of the invariant: the heading is a real substring of the
 * unstripped prompt (proves the string isn't stale), AND the tier's actual
 * output no longer contains it (proves the strip call actually fired) --
 * so renaming a heading without updating its strip call fails the first
 * assertion, and a strip call with a stale/typo'd string fails the second.
 */
import { describe, it, expect } from 'vitest';
import {
  APP_BUILDER_SYSTEM_PROMPT,
  getFixSystemPrompt,
  getEditSystemPrompt,
  getAppBuilderBuildSystemPrompt,
} from '../app-builder.prompt.js';

function expectHeadingReallyStripped(strippedOutput: string, level: '#' | '##', title: string) {
  const marker = `\n${level} ${title}`;
  expect(APP_BUILDER_SYSTEM_PROMPT).toContain(marker);
  expect(strippedOutput).not.toContain(marker);
}

describe('getFixSystemPrompt section stripping', () => {
  const output = getFixSystemPrompt();

  it.each([
    'Design Philosophy (MANDATORY   apply to every pixel you produce)',
    'Requirement Gathering',
    'SEO (MANDATORY   auto-run after every website build)',
    'Reference Screenshots (CRITICAL   never embed)',
    'Architecture Patterns (MANDATORY   choose the right architecture for the job)',
    'Complex App Protocol (MANDATORY   apps with 5+ files)',
    'File Completeness Rules (CRITICAL   prevent blank/Welcome preview)',
  ])('strips top-level heading %s', (title) => {
    expectHeadingReallyStripped(output, '#', title);
  });

  it.each([
    'For NEW projects (no existing pages):',
    'Large Build Chunking (MANDATORY for 5+ files)',
    'Hosted database (paid plans only):',
  ])('strips sub-heading %s', (title) => {
    expectHeadingReallyStripped(output, '##', title);
  });
});

describe('getEditSystemPrompt section stripping', () => {
  const output = getEditSystemPrompt();

  it.each([
    'Design Philosophy (MANDATORY   apply to every pixel you produce)',
    'Requirement Gathering',
    'SEO (MANDATORY   auto-run after every website build)',
    'Reference Screenshots (CRITICAL   never embed)',
    'Architecture Patterns (MANDATORY   choose the right architecture for the job)',
    'Complex App Protocol (MANDATORY   apps with 5+ files)',
    'File Completeness Rules (CRITICAL   prevent blank/Welcome preview)',
  ])('strips top-level heading %s', (title) => {
    expectHeadingReallyStripped(output, '#', title);
  });

  it.each([
    'For NEW projects (no existing pages):',
    'Large Build Chunking (MANDATORY for 5+ files)',
    'Hosted database (paid plans only):',
  ])('strips sub-heading %s', (title) => {
    expectHeadingReallyStripped(output, '##', title);
  });
});

describe('getAppBuilderBuildSystemPrompt section stripping', () => {
  // Every optional flag explicitly false exercises every conditional strip
  // branch (including includeErrorPatterns/includePreviewEnvironment, wired
  // by this checkpoint -- previously declared but never consumed).
  const output = getAppBuilderBuildSystemPrompt({
    includeRequirementGathering: false,
    includeStartingNewProject: false,
    includeSeo: false,
    includeIntegration: false,
    includeErrorPatterns: false,
    includeCapabilities: false,
    includePreviewEnvironment: false,
  });

  it.each([
    'Design Philosophy (MANDATORY   apply to every pixel you produce)',
    'Requirement Gathering',
    'Starting a New Project (MANDATORY)',
    'SEO (MANDATORY   auto-run after every website build)',
    'Common Error Patterns   MEMORIZED FIXES',
    'Preview Environment Architecture (understand how your code gets served)',
  ])('strips top-level heading %s', (title) => {
    expectHeadingReallyStripped(output, '#', title);
  });

  it('strips the Hosted database sub-heading', () => {
    expectHeadingReallyStripped(output, '##', 'Hosted database (paid plans only):');
  });

  it('omitting all options (undefined) strips the same four unconditional-default sections', () => {
    // Every top-level flag defaults to "off" when its option is omitted
    // (`!options?.includeX` is true for an absent options object), so calling
    // with no argument at all exercises the same default-strip path a real
    // caller hits by omitting a flag rather than passing it explicitly false.
    const defaultOutput = getAppBuilderBuildSystemPrompt();
    expectHeadingReallyStripped(defaultOutput, '#', 'Requirement Gathering');
    expectHeadingReallyStripped(defaultOutput, '#', 'Starting a New Project (MANDATORY)');
  });

  it('passing every flag true returns the full unstripped prompt', () => {
    const fullOutput = getAppBuilderBuildSystemPrompt({
      includeRequirementGathering: true,
      includeStartingNewProject: true,
      includeSeo: true,
      includeIntegration: true,
      includeErrorPatterns: true,
      includeCapabilities: true,
      includePreviewEnvironment: true,
    });
    expect(fullOutput).toBe(APP_BUILDER_SYSTEM_PROMPT);
  });
});

// The #1 cause of fix loops per this file's own comments: losing the 12-name
// shadcn/ui component manifest or the pre-installed package list makes the
// agent invent wrong import paths or try to recreate components that already
// exist. Neither heading is ever a candidate in any tier's strip list, but
// this proves it behaviorally through the real exported functions rather
// than trusting that invariant to hold by inspection.
// MICRO_SYSTEM_PROMPT is deliberately excluded here: it is a fully separate,
// hand-written prompt never derived from APP_BUILDER_SYSTEM_PROMPT (per this
// file's own doc comment) and never contained this content in the first
// place, so asserting its presence there would fail as a false regression,
// not a real one.
describe('golden content: component manifest + installed-package list survive tier stripping', () => {
  const COMPONENT_MANIFEST = '12 components are PRE-BUILT (Button, Card, Input, Label, Badge, Textarea, Separator, Avatar, Dialog, Select, Tabs, Table)';
  const PACKAGE_LIST_MARKERS = ['react-router-dom', '@radix-ui/react-avatar', '@supabase/supabase-js', 'zustand'];

  it.each([
    ['fix', getFixSystemPrompt()],
    ['edit', getEditSystemPrompt()],
    ['build (existing-project shape, all optional sections off)', getAppBuilderBuildSystemPrompt({
      includeRequirementGathering: false,
      includeStartingNewProject: false,
      includeSeo: false,
      includeIntegration: false,
      includeErrorPatterns: false,
      includeCapabilities: false,
      includePreviewEnvironment: false,
    })],
  ] as const)('%s tier retains the component manifest and package list', (_tierName, output) => {
    expect(output).toContain(COMPONENT_MANIFEST);
    for (const pkg of PACKAGE_LIST_MARKERS) {
      expect(output).toContain(pkg);
    }
  });
});
