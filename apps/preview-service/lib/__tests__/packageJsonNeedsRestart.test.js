import { describe, expect, it } from 'vitest';
import { packageJsonNeedsRestart, harmonizePackageJson } from '../materialize.js';

// A Vite restart wipes the project's 22MB .vite-cache and forces a cold
// dependency pre-bundle (~5-25s). It must fire ONLY when the incoming
// package.json genuinely asks for something the on-disk copy lacks.
//
// The regression this guards: what lands on disk is
// harmonizePackageJson(preprocess(incoming)), which injects preview-provided
// deps and re-serialises with 2-space indent, so disk is a SUPERSET of
// incoming by construction. The previous `diskContent !== incoming` byte
// compare could therefore never be false -- 218 of 256 production updates
// (85%) took a needless restart (measured 2026-08-16).

const pkg = (deps = {}, devDeps = undefined) =>
  JSON.stringify(
    devDeps === undefined
      ? { name: 'app', dependencies: deps }
      : { name: 'app', dependencies: deps, devDependencies: devDeps },
    null,
    2
  );

describe('packageJsonNeedsRestart', () => {
  it('does NOT restart when disk is a harmonized superset of incoming (the 85% case)', () => {
    const incoming = pkg({ react: '^18.3.1' });
    // Disk has extra injected deps, exactly what harmonizePackageJson produces.
    const disk = pkg({ react: '^18.3.1', papaparse: '^5.4.1', 'lucide-react': '^0.4.0' });
    expect(packageJsonNeedsRestart(disk, incoming)).toBe(false);
  });

  it('does NOT restart on formatting/key-order differences alone', () => {
    const disk = JSON.stringify({ dependencies: { react: '^18.3.1', zod: '^3.0.0' } }, null, 2);
    const incoming = JSON.stringify({ dependencies: { zod: '^3.0.0', react: '^18.3.1' } });
    expect(packageJsonNeedsRestart(disk, incoming)).toBe(false);
  });

  it('restarts when incoming introduces a dependency disk does not have', () => {
    expect(packageJsonNeedsRestart(pkg({ react: '^18.3.1' }), pkg({ react: '^18.3.1', papaparse: '^5.4.1' }))).toBe(true);
  });

  it('restarts when incoming pins a different version of an existing dependency', () => {
    expect(packageJsonNeedsRestart(pkg({ react: '^18.3.1' }), pkg({ react: '^19.0.0' }))).toBe(true);
  });

  it('restarts on a new devDependency', () => {
    const disk = pkg({ react: '^18.3.1' }, { vite: '^5.0.0' });
    const incoming = pkg({ react: '^18.3.1' }, { vite: '^5.0.0', vitest: '^2.0.0' });
    expect(packageJsonNeedsRestart(disk, incoming)).toBe(true);
  });

  it('treats a missing dependencies block as "asks for nothing new"', () => {
    expect(packageJsonNeedsRestart(pkg({ react: '^18.3.1' }), JSON.stringify({ name: 'app' }))).toBe(false);
  });

  it('propagates a parse error so the caller can fall back to a byte compare', () => {
    expect(() => packageJsonNeedsRestart('{not json', pkg({}))).toThrow();
  });

  it('agrees with the real harmonizePackageJson output it exists to compensate for', () => {
    // End-to-end: harmonize an incoming file the way materialize does, then
    // confirm the harmonized result does not read as "needs restart" against
    // the very input that produced it.
    const incoming = pkg({ react: '^18.3.1' });
    const files = [{ path: 'src/App.tsx', content: "import React from 'react';\nexport default () => null;\n" }];
    const onDisk = harmonizePackageJson(incoming, files);
    expect(packageJsonNeedsRestart(onDisk, incoming)).toBe(false);
  });
});
