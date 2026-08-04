import { describe, it, expect } from 'vitest';
import { extractMissingPackages } from '../get_build_errors.js';

describe('extractMissingPackages', () => {
  it('extracts a bare package name from a Vite/Rollup-style error', () => {
    const lines = ['Failed to resolve import "lodash" from "src/App.tsx". Does the file exist?'];
    expect(extractMissingPackages(lines)).toEqual(['lodash']);
  });

  it('extracts a Node-style Cannot find module error', () => {
    const lines = ["Error: Cannot find module 'zod'"];
    expect(extractMissingPackages(lines)).toEqual(['zod']);
  });

  it('reduces a subpath import to the installable package root', () => {
    const lines = ['Failed to resolve import "lodash/debounce" from "src/App.tsx".'];
    expect(extractMissingPackages(lines)).toEqual(['lodash']);
  });

  it('keeps the scope for a scoped package subpath', () => {
    const lines = ['Failed to resolve import "@radix-ui/react-dialog/Foo" from "src/App.tsx".'];
    expect(extractMissingPackages(lines)).toEqual(['@radix-ui/react-dialog']);
  });

  it('ignores relative imports and the @/ path alias', () => {
    const lines = [
      'Failed to resolve import "./Button" from "src/App.tsx".',
      'Failed to resolve import "@/components/Button" from "src/App.tsx".',
      'Failed to resolve import "../lib/utils" from "src/App.tsx".',
    ];
    expect(extractMissingPackages(lines)).toEqual([]);
  });

  it('ignores lines that are not module-not-found errors', () => {
    const lines = ['TypeError: Cannot read properties of undefined (reading "foo")'];
    expect(extractMissingPackages(lines)).toEqual([]);
  });

  it('dedupes repeated packages across multiple error lines', () => {
    const lines = [
      'Failed to resolve import "lodash" from "src/App.tsx".',
      'Failed to resolve import "lodash" from "src/Other.tsx".',
    ];
    expect(extractMissingPackages(lines)).toEqual(['lodash']);
  });
});
