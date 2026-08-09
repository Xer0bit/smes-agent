const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('preview-service-microvm', '1.0.0');

const READY_TIMEOUT_MS = 15_000;
const PROJECTS_BASE_DIR = process.env.SERVER_PROJECTS_DIR 
  || process.env.LOCAL_PREVIEW_DATA 
  || path.join(__dirname, '../projects');

/**
 * MicroVMManager: Orchestrates isolated, MicroVM-style sandbox runners using Node process permission boundaries.
 */
class MicroVMManager extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map(); // projectId -> { proc, port, projectId, projectRoot, pid, status, startedAt }
    this.allocatedPorts = new Set();
  }

  /**
   * Helper to resolve project root directory
   */
  getProjectRoot(projectId) {
    return path.join(PROJECTS_BASE_DIR, projectId);
  }

  /**
   * Boot an isolated MicroVM child process runner for a given project.
   * Restricts filesystem access using Node's permission model (--experimental-permission).
   */
  async bootInstance(projectId, port = 3000) {
    return tracer.startActiveSpan('microvm.boot', { attributes: { projectId, port } }, async (span) => {
      try {
        const result = await this._bootInstanceInner(projectId, port);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async _bootInstanceInner(projectId, port = 3000) {
    if (this.instances.has(projectId)) {
      const existing = this.instances.get(projectId);
      if (existing && existing.proc && !existing.proc.killed) {
        return existing;
      }
      await this.terminateInstance(projectId);
    }

    const projectRoot = this.getProjectRoot(projectId);
    await fs.promises.mkdir(projectRoot, { recursive: true });

    const runnerPath = path.join(__dirname, 'viteChildRunner.js');
    const nodeModulesPath = path.join(__dirname, '../node_modules');

    // Emulate MicroVM boundary via Node experimental permission flags
    // Restricts read/write access strictly to project root and node_modules
    const execArgs = [
      '--experimental-permission',
      `--allow-fs-read=${projectRoot}/*`,
      `--allow-fs-read=${nodeModulesPath}/*`,
      `--allow-fs-read=${__dirname}/*`,
      `--allow-fs-write=${projectRoot}/*`,
      '--max-old-space-size=384',
      runnerPath,
    ];

    const childEnv = {
      ...process.env,
      PROJECT_ID: projectId,
      PROJECT_ROOT: projectRoot,
      PORT: String(port),
    };

    let proc;
    try {
      proc = spawn(process.execPath, execArgs, {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (spawnErr) {
      // Fallback without --experimental-permission if Node runtime doesn't support permission flag
      console.warn(`[MicroVM:${projectId}] Permission flag spawn failed, falling back to standard isolated fork:`, spawnErr.message);
      proc = spawn(process.execPath, ['--max-old-space-size=384', runnerPath], {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    }

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          console.error(`[MicroVM:${projectId}] (stderr) ${line}`);
        }
      }
    });

    proc.stdout?.on('data', (chunk) => {
      const s = chunk.toString().trim();
      if (s) console.log(`[MicroVM:${projectId}] (stdout) ${s}`);
    });

    // Await process readiness handshake
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`MicroVM runner for project ${projectId} failed to become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      function onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          cleanup();
          resolve();
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message || 'MicroVM runner process failed to start'));
        }
      }

      function onExit(code) {
        cleanup();
        reject(new Error(`MicroVM runner for ${projectId} exited prematurely with code ${code}`));
      }

      function cleanup() {
        clearTimeout(timeout);
        proc.removeListener('message', onMessage);
        proc.removeListener('exit', onExit);
      }

      proc.once('message', onMessage);
      proc.once('exit', onExit);
    });

    const instanceRecord = {
      proc,
      port,
      projectId,
      projectRoot,
      pid: proc.pid,
      status: 'running',
      startedAt: Date.now(),
      lastAccessed: Date.now(),
    };

    this.instances.set(projectId, instanceRecord);
    this.allocatedPorts.add(port);

    proc.on('exit', () => {
      this.instances.delete(projectId);
      this.allocatedPorts.delete(port);
      this.emit('instance-exit', { projectId, port });
    });

    return instanceRecord;
  }

  /**
   * Materialize updated file snapshot into project sandbox directory and trigger HMR reload
   */
  async syncFiles(projectId, files) {
    const fileCount = files && typeof files === 'object' ? Object.keys(files).length : 0;
    return tracer.startActiveSpan('microvm.sync_files', { attributes: { projectId, fileCount } }, async (span) => {
      try {
        await this._syncFilesInner(projectId, files);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async _syncFilesInner(projectId, files) {
    const projectRoot = this.getProjectRoot(projectId);
    await fs.promises.mkdir(projectRoot, { recursive: true });

    if (files && typeof files === 'object') {
      for (const [relPath, content] of Object.entries(files)) {
        const targetPath = path.join(projectRoot, relPath);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, content, 'utf8');
      }
    }

    const instance = this.instances.get(projectId);
    if (instance && instance.proc && instance.proc.connected) {
      try {
        instance.proc.send({ type: 'full-reload' });
      } catch (err) {
        console.warn(`[MicroVM:${projectId}] Failed to send full-reload IPC signal:`, err.message);
      }
    }
  }

  /**
   * Terminate a running MicroVM instance and release allocated resources & ports
   */
  async terminateInstance(projectId) {
    const instance = this.instances.get(projectId);
    if (!instance) return false;

    const { proc, port } = instance;
    this.instances.delete(projectId);
    this.allocatedPorts.delete(port);

    if (proc && !proc.killed) {
      try {
        proc.send({ type: 'shutdown' });
      } catch {}

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }, 2000);

        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    return true;
  }

  getInstance(projectId) {
    return this.instances.get(projectId);
  }

  isInstanceRunning(projectId) {
    const inst = this.instances.get(projectId);
    return Boolean(inst && inst.proc && !inst.proc.killed);
  }

  listInstances() {
    return Array.from(this.instances.values()).map((inst) => ({
      projectId: inst.projectId,
      port: inst.port,
      pid: inst.pid,
      status: inst.status,
      startedAt: inst.startedAt,
    }));
  }
}

const microVMManager = new MicroVMManager();

module.exports = {
  MicroVMManager,
  microVMManager,
};
