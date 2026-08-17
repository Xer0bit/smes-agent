import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { placeAssetTool } from '../place_asset.js';
import type { AgentContext } from '../types.js';

const UPLOAD_BASE = path.join(os.tmpdir(), 'ecomgear-chat-uploads');

// Minimal valid PNG (1x1 transparent pixel) -- enough to pass validateImage's
// magic-byte check.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c6360000002000155a5ee0c0000000049454e44ae426082',
  'hex',
);

function makeCtx(appPath: string): AgentContext {
  return {
    appPath,
    projectId: 'test-project',
    onXmlComplete: () => {},
  };
}

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('place_asset self-heal', () => {
  it('recovers via publicUrl when the /tmp file is gone but a durable copy is registered', async () => {
    const appPath = tmpDir('ecg-place-asset-app-');
    const missingTmpPath = path.join(UPLOAD_BASE, `does-not-exist-${Date.now()}.png`);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
    })));

    const ctx = makeCtx(appPath);
    ctx.attachmentPublicUrls = new Map([[path.resolve(missingTmpPath), 'https://example.com/durable/logo.png']]);

    const result = await placeAssetTool.execute({ tmpPath: missingTmpPath, destName: 'logo.png' }, ctx);

    expect(result).toContain('✓ Image copied to public/assets/logo.png');
    expect(fs.existsSync(path.join(appPath, 'public', 'assets', 'logo.png'))).toBe(true);
  });

  it('fails cleanly when the file is gone and no publicUrl is registered', async () => {
    const appPath = tmpDir('ecg-place-asset-app-');
    const missingTmpPath = path.join(UPLOAD_BASE, `does-not-exist-${Date.now()}.png`);

    const ctx = makeCtx(appPath);

    const result = await placeAssetTool.execute({ tmpPath: missingTmpPath, destName: 'logo.png' }, ctx);

    expect(result).toContain('ERROR: Uploaded file not found');
    expect(fs.existsSync(path.join(appPath, 'public', 'assets', 'logo.png'))).toBe(false);
  });
});
