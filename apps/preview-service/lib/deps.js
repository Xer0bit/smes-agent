/**
 * Per-project dependencies, driven by the project's own package.json.
 *
 * Before: every project's node_modules was a symlink to the preview service's
 * single shared install, and the agent's run_command tool called
 * POST /packages/install after each npm install, which ran `npm install` into
 * that shared directory. One project upgrading zod upgraded zod for everyone,
 * the call was fire-and-forget (a failed install left the runner and the
 * preview disagreeing with no error anywhere), and `vite build` at publish
 * time used whatever the shared directory happened to hold.
 *
 * Now package.json is the source of truth:
 *
 *   extras = deps(project) that the shared install does not provide
 *
 *   <root>/.deps/package.json   { dependencies: extras }
 *   <root>/.deps/node_modules   npm install --prefix .deps (per project, exact
 *                               versions, --legacy-peer-deps so React and
 *                               friends resolve up to the shared copy instead
 *                               of being duplicated)
 *   <root>/node_modules/        a real directory of symlinks: every shared
 *                               package, then every extra on top (an extra
 *                               with the same name as a shared package wins,
 *                               so a project can pin its own version)
 *
 * Transitive dependencies of an extra resolve from .deps/node_modules because
 * Node and Vite resolve through the symlink's real path. Peers (react,
 * react-dom) resolve upward to <root>/node_modules/react → shared.
 *
 * ensureProjectDeps() is called on every update that carries package.json,
 * synchronously, and its result travels back in the update response so the
 * agent runner and the user see an install failure as a real failure. It is
 * also called before `vite build`, so publish builds from the same tree.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const SHARED_MODULES = path.join(__dirname, '..', 'node_modules');
const SHARED_PACKAGE_JSON = path.join(__dirname, '..', 'package.json');
const INSTALL_TIMEOUT_MS = 180_000;

/** Names the shared install provides (dependencies + devDependencies of the preview service). */
function sharedPackageNames() {
    try {
        const pkg = JSON.parse(fs.readFileSync(SHARED_PACKAGE_JSON, 'utf-8'));
        return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
    } catch {
        return new Set();
    }
}

/** { name: versionRange } for every dependency the project asks for that the shared install lacks. */
function computeExtras(projectPackageJson) {
    const shared = sharedPackageNames();
    const wanted = { ...(projectPackageJson.devDependencies || {}), ...(projectPackageJson.dependencies || {}) };
    const extras = {};
    for (const [name, range] of Object.entries(wanted)) {
        if (typeof range !== 'string' || !range.trim()) continue;
        if (range.startsWith('file:') || range.startsWith('link:') || range.startsWith('workspace:')) continue;
        if (shared.has(name)) continue;
        extras[name] = range;
    }
    return extras;
}

function extrasHash(extras) {
    const canon = Object.keys(extras).sort().map((k) => `${k}@${extras[k]}`).join('\n');
    return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function listPackages(modulesDir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === '.bin' || e.name === '.package-lock.json' || e.name.startsWith('.')) continue;
        if (e.name.startsWith('@')) {
            let scoped;
            try { scoped = fs.readdirSync(path.join(modulesDir, e.name), { withFileTypes: true }); } catch { continue; }
            for (const s of scoped) out.push(`${e.name}/${s.name}`);
        } else {
            out.push(e.name);
        }
    }
    return out;
}

function forceSymlink(target, linkPath) {
    try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === target) return;
        fs.rmSync(linkPath, { recursive: true, force: true });
    } catch { /* does not exist */ }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'dir');
}

/** The plain layout: <root>/node_modules → shared install (what every project had before). */
function linkShared(projectRoot) {
    const projectModules = path.join(projectRoot, 'node_modules');
    try {
        const st = fs.lstatSync(projectModules);
        if (st.isSymbolicLink() && fs.readlinkSync(projectModules) === SHARED_MODULES) return;
        fs.rmSync(projectModules, { recursive: true, force: true });
    } catch { /* absent */ }
    fs.symlinkSync(SHARED_MODULES, projectModules, 'dir');
}

/** The layered layout: a real node_modules directory of symlinks, extras on top of shared. */
function linkLayered(projectRoot) {
    const projectModules = path.join(projectRoot, 'node_modules');
    const depsModules = path.join(projectRoot, '.deps', 'node_modules');
    try {
        const st = fs.lstatSync(projectModules);
        if (st.isSymbolicLink()) fs.rmSync(projectModules, { force: true });
    } catch { /* absent */ }
    fs.mkdirSync(projectModules, { recursive: true });
    const linked = new Set();
    for (const name of listPackages(depsModules)) {
        forceSymlink(path.join(depsModules, name), path.join(projectModules, name));
        linked.add(name);
    }
    for (const name of listPackages(SHARED_MODULES)) {
        if (linked.has(name)) continue;
        forceSymlink(path.join(SHARED_MODULES, name), path.join(projectModules, name));
        linked.add(name);
    }
    // Stale links from a previous extras set.
    for (const name of listPackages(projectModules)) {
        if (!linked.has(name)) fs.rmSync(path.join(projectModules, name), { recursive: true, force: true });
    }
    forceSymlink(path.join(SHARED_MODULES, '.bin'), path.join(projectModules, '.bin'));
}

function run(cmd, cwd) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'development' } },
            (err, stdout, stderr) => resolve({ ok: !err, out: [stdout, stderr].filter(Boolean).join('\n') }));
    });
}

const inFlight = new Map();

/**
 * Bring <root>/node_modules in line with the project's package.json.
 * Returns { extras: number, installed: boolean, changed: boolean, error?: string }.
 * Never throws: an install failure is reported, and the previous layout is kept.
 */
async function ensureProjectDeps(projectRoot, packageJsonContent = null) {
    if (inFlight.has(projectRoot)) return inFlight.get(projectRoot);
    const task = (async () => {
        let pkg;
        try {
            pkg = JSON.parse(packageJsonContent ?? fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        } catch {
            linkShared(projectRoot);
            return { extras: 0, installed: false, changed: false };
        }
        const extras = computeExtras(pkg);
        const names = Object.keys(extras);
        const depsDir = path.join(projectRoot, '.deps');
        const hashFile = path.join(depsDir, '.extras-hash');

        if (names.length === 0) {
            const hadLayer = fs.existsSync(depsDir);
            if (hadLayer) fs.rmSync(depsDir, { recursive: true, force: true });
            linkShared(projectRoot);
            return { extras: 0, installed: false, changed: hadLayer };
        }

        const hash = extrasHash(extras);
        let current = null;
        try { current = fs.readFileSync(hashFile, 'utf-8').trim(); } catch { /* none */ }
        if (current === hash && fs.existsSync(path.join(depsDir, 'node_modules'))) {
            linkLayered(projectRoot);
            return { extras: names.length, installed: false, changed: false };
        }

        fs.mkdirSync(depsDir, { recursive: true });
        fs.writeFileSync(path.join(depsDir, 'package.json'), JSON.stringify({ name: 'SMEsAgent-project-deps', private: true, version: '0.0.0', dependencies: extras }, null, 2));
        const started = Date.now();
        const res = await run('npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --no-package-lock', depsDir);
        if (!res.ok) {
            console.error(`[deps] install failed in ${depsDir}: ${res.out.slice(0, 600)}`);
            // Keep whatever layout worked before; do not leave a half-written hash.
            try { fs.rmSync(hashFile, { force: true }); } catch { /* ignore */ }
            if (fs.existsSync(path.join(depsDir, 'node_modules'))) linkLayered(projectRoot); else linkShared(projectRoot);
            return { extras: names.length, installed: false, changed: false, error: summarizeNpmError(res.out, names) };
        }
        fs.writeFileSync(hashFile, hash);
        linkLayered(projectRoot);
        console.log(`[deps] installed ${names.length} extra package(s) for ${path.basename(projectRoot)} in ${Date.now() - started}ms: ${names.join(', ')}`);
        return { extras: names.length, installed: true, changed: true };
    })();
    inFlight.set(projectRoot, task);
    try { return await task; } finally { inFlight.delete(projectRoot); }
}

function summarizeNpmError(out, names) {
    const notFound = out.match(/404\s+Not Found[^\n]*'([^']+)'/i) || out.match(/E404[^\n]*\/([^\s/]+)/);
    if (notFound) return `Package not found on npm: ${notFound[1]}`;
    const etarget = out.match(/No matching version found for ([^\s]+)/);
    if (etarget) return `No matching version: ${etarget[1]}`;
    const line = out.split('\n').find((l) => /npm ERR!|ERR_|error/i.test(l));
    return `npm install failed for ${names.join(', ')}${line ? `: ${line.trim().slice(0, 200)}` : ''}`;
}

/** Cheap, synchronous: make node_modules match whatever layer already exists on disk (init path). */
function ensureLayoutSync(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, '.deps', 'node_modules'))) linkLayered(projectRoot);
    else linkShared(projectRoot);
}

module.exports = { ensureProjectDeps, ensureLayoutSync, computeExtras, extrasHash, SHARED_MODULES };
