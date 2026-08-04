import { describe, it, expect } from 'vitest';
import { applySearchReplace } from '../edit_file.js';

describe('applySearchReplace', () => {
  it('edits the correct occurrence when the search text repeats verbatim earlier in the file', () => {
    const original = [
      'function a() {',
      '  return 1;',
      '}',
      '',
      'function b() {',
      '  return 1;',
      '}',
    ].join('\n');

    const diff =
      '<<<<<<< SEARCH\nfunction b() {\n  return 1;\n}\n=======\nfunction b() {\n  return 2;\n}\n>>>>>>> REPLACE';

    const result = applySearchReplace(original, diff);
    expect(result.success).toBe(true);
    expect(result.content).toBe(
      ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'].join('\n'),
    );
  });

  it('edits the correct occurrence via the whitespace-fuzzy path when it repeats earlier', () => {
    const original = [
      'function a() {',
      '  return 1; ', // trailing space so the exact-match tier misses
      '}',
      '',
      'function b() {',
      '  return 1;', // no trailing space -- exact tier would match here first if searched blindly
      '}',
    ].join('\n');

    const diff =
      '<<<<<<< SEARCH\nfunction a() {\n  return 1;\n}\n=======\nfunction a() {\n  return 99;\n}\n>>>>>>> REPLACE';

    const result = applySearchReplace(original, diff);
    expect(result.success).toBe(true);
    // Must patch the first function (the fuzzy match), not the second
    // (which happens to match the reconstructed text exactly).
    expect(result.content).toBe(
      ['function a() {', '  return 99;', '}', '', 'function b() {', '  return 1;', '}'].join('\n'),
    );
  });

  it('fails cleanly when the search text is not present', () => {
    const result = applySearchReplace('const x = 1;', '<<<<<<< SEARCH\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> REPLACE');
    expect(result.success).toBe(false);
  });
});
