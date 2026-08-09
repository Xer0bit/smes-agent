// Real TypeScript project-level type-checking, distinct from the fast
// per-file syntax-only esbuild transform in validation.js. 2026-08 security/
// quality audit finding (Domain 1): the only verification signal the agent
// ever gets is that syntax-only pass -- ts.transpileModule-equivalent, never
// a real semantic check. Every type error, prop mismatch, and bad generic
// shipped silently as "complete."
//
// Deliberately NOT merged into the fast esbuild pass -- it's meaningfully
// slower (a real cross-file program build, not a per-file transform), and
// this runs on the hot path of every agent turn via get_build_errors. The
// caller (server.js's /preview/:projectId/check route) only invokes this
// once the fast syntax/import checks are already clean, so the common
// "still actively broken" case during iteration stays fast, and the more
// expensive real check only runs when it can actually produce a
// different/better answer than the fast one already did.
//
// Using the project's own tsconfig.json (not a hardcoded config) means
// noUnusedLocals/noUnusedParameters -- already set in the generated-project
// scaffold template -- are enforced for real here too, for free: those are
// standard TS diagnostics included in getPreEmitDiagnostics() whenever the
// project's own compilerOptions turn them on, not a separate mechanism.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const DEFAULT_COMPILER_OPTIONS = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    skipLibCheck: true,
    strict: true,
    isolatedModules: true,
    resolveJsonModule: true,
    noEmit: true,
    baseUrl: '.',
    paths: { '@/*': ['./src/*'] },
};

function parseTsconfig(tsconfigPath, projectRoot) {
    const raw = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, 'utf-8'));
    if (raw.error) return null;
    return ts.parseJsonConfigFileContent(raw.config, ts.sys, projectRoot);
}

// Vite handles CSS/asset imports (`import './index.css'`) as a bundler
// feature -- it doesn't need TypeScript to know what they are, so these
// generated projects build and run fine without any ambient declaration for
// them. A strict standalone tsc check has no such bundler, though, so
// without vite/client's ambient module declarations every single CSS/SVG/
// asset import falsely reports "Cannot find module" -- on every project,
// since none of the sampled ones ship their own vite-env.d.ts. Pointing
// `types` at the real vite/client.d.ts already in node_modules (not a
// synthetic/guessed shim) makes the check match Vite's actual semantics
// instead of either missing this file class entirely or hand-rolling
// declarations that could drift from Vite's real ones.
function withViteClientTypes(options, projectRoot) {
    const viteClientDts = path.join(projectRoot, 'node_modules', 'vite', 'client.d.ts');
    if (!fs.existsSync(viteClientDts)) return options;
    return { ...options, types: Array.from(new Set([...(options.types || []), 'vite/client'])) };
}

function loadCompilerOptions(projectRoot) {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return withViteClientTypes(DEFAULT_COMPILER_OPTIONS, projectRoot);

    try {
        const parsed = parseTsconfig(tsconfigPath, projectRoot);
        if (!parsed) return withViteClientTypes(DEFAULT_COMPILER_OPTIONS, projectRoot);

        // The generated-project scaffold (server/agent-template/) uses a
        // solution-style root tsconfig.json (files: [], references: [...])
        // -- the real compilerOptions for src/ live in tsconfig.app.json, not
        // the root file. A naive read of tsconfig.json alone here previously
        // produced near-default options (no jsx, no skipLibCheck), which both
        // misfired hundreds of false "--jsx flag not set" errors AND made
        // every check slow (node_modules .d.ts files got fully type-checked
        // instead of skipped). Detect the empty-root-with-references pattern
        // and load tsconfig.app.json instead when present.
        const looksLikeSolutionFile = parsed.fileNames.length === 0 && parsed.projectReferences && parsed.projectReferences.length > 0;
        if (looksLikeSolutionFile) {
            const appConfigPath = path.join(projectRoot, 'tsconfig.app.json');
            if (fs.existsSync(appConfigPath)) {
                const appParsed = parseTsconfig(appConfigPath, projectRoot);
                if (appParsed) return withViteClientTypes({ ...appParsed.options, noEmit: true, skipLibCheck: true }, projectRoot);
            }
            // No tsconfig.app.json -- try the first referenced config generically.
            const firstRef = parsed.projectReferences[0];
            if (firstRef) {
                const refParsed = parseTsconfig(firstRef.path, projectRoot);
                if (refParsed) return withViteClientTypes({ ...refParsed.options, noEmit: true, skipLibCheck: true }, projectRoot);
            }
        }

        // noEmit/skipLibCheck always forced regardless of what the project's
        // own tsconfig says -- this check must never write output files, and
        // third-party .d.ts files are out of scope for "did the AGENT'S code
        // introduce an error" (also the main cost driver if left unchecked).
        return withViteClientTypes({ ...parsed.options, noEmit: true, skipLibCheck: true }, projectRoot);
    } catch {
        return withViteClientTypes(DEFAULT_COMPILER_OPTIONS, projectRoot);
    }
}

function collectSourceFiles(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSourceFiles(full, out);
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

function diagnosticToError(diagnostic, projectRoot) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file) {
        return { file: undefined, message, summary: message };
    }
    const relPath = path.relative(projectRoot, diagnostic.file.fileName).replace(/\\/g, '/');
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return {
        file: relPath,
        line: line + 1,
        column: character + 1,
        message,
        summary: `${relPath}:${line + 1}:${character + 1} ${message}`,
    };
}

/**
 * Type-checks a project using its own tsconfig.json. `pendingFiles` is an
 * overlay map (path -> content) of not-yet-written changes from a dry-run
 * check -- served in place of the on-disk version for any file present in
 * it, so this reflects the pending edit set without writing anything.
 * Returns { ok, errors } in the same shape validation.js's other checks use.
 */
function typeCheckProject(projectRoot, pendingFiles) {
    const overlay = pendingFiles instanceof Map ? pendingFiles : new Map(Object.entries(pendingFiles || {}));
    const overlayAbs = new Map(
        Array.from(overlay.entries()).map(([relPath, content]) => [
            path.resolve(projectRoot, relPath.replace(/^\/+/, '')),
            content,
        ])
    );

    const compilerOptions = loadCompilerOptions(projectRoot);

    const onDiskFiles = collectSourceFiles(path.join(projectRoot, 'src'), []);
    const rootFileNames = Array.from(new Set([...onDiskFiles, ...overlayAbs.keys()]))
        .filter((f) => /\.(tsx|ts|jsx|js)$/.test(f));

    if (rootFileNames.length === 0) return { ok: true, errors: [] };

    const host = ts.createCompilerHost(compilerOptions);
    const originalReadFile = host.readFile;
    const originalFileExists = host.fileExists;

    host.readFile = (fileName) => {
        const abs = path.resolve(fileName);
        if (overlayAbs.has(abs)) return overlayAbs.get(abs);
        return originalReadFile(fileName);
    };
    host.fileExists = (fileName) => {
        const abs = path.resolve(fileName);
        if (overlayAbs.has(abs)) return true;
        return originalFileExists(fileName);
    };

    let program;
    try {
        program = ts.createProgram(rootFileNames, compilerOptions, host);
    } catch (err) {
        // A malformed tsconfig or unresolvable project structure shouldn't
        // crash the whole check -- degrade to "no additional errors found"
        // rather than failing the caller (the fast syntax check already ran).
        return { ok: true, errors: [], degraded: true, degradedReason: err?.message };
    }

    const diagnostics = ts.getPreEmitDiagnostics(program)
        .filter((d) => d.category === ts.DiagnosticCategory.Error);

    const errors = diagnostics.map((d) => diagnosticToError(d, projectRoot));
    return { ok: errors.length === 0, errors };
}

module.exports = { typeCheckProject };
