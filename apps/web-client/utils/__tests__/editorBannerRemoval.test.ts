/**
 * Bug 3 smoke test   static source analysis confirming the activity-message
 * banner and "Ask the assistant" placeholder text were removed from Editor.tsx.
 *
 * This is a grep/static check, not a component render test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const editorSource = readFileSync(
  resolve(__dirname, '../../pages/Editor.tsx'),
  'utf8',
);

describe('Editor.tsx banner removal (Bug 3)', () => {
  it('does not render activityMessage in JSX (no {activityMessage} expression)', () => {
    // The state declaration is allowed; rendering it is not.
    const jsxUsages = editorSource.match(/\{activityMessage\}/g) ?? [];
    expect(jsxUsages).toHaveLength(0);
  });

  it('does not contain the "Ask the assistant" generate-tab banner text', () => {
    expect(editorSource).not.toContain('Ask the assistant');
  });

  it('activityMessage state is declared (state machinery still present)', () => {
    // Confirms the state variable still exists; only its rendering was removed.
    expect(editorSource).toContain("useState('')");
  });
});
