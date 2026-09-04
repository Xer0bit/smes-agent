/**
 * The one rule: nothing that preview-service could PRUNE may be stripped here.
 *
 * The client may fullSync this list back. preview-service refuses to prune
 * binary-extension files unconditionally, so dropping those is safe; dropping
 * anything else would hand the receiving end an incomplete set for a file it
 * IS willing to delete. That is the "images disappear on reload" bug, re-armed.
 */
import { describe, it, expect } from 'vitest';
import { stripBinariesForClient, payloadBytes } from '../clientFilePayload.js';

const SENTINEL = '__SMEsAgent_BIN64__';
const bin = (path: string, kb = 1) => ({ path, content: SENTINEL + 'A'.repeat(kb * 1024) });
const text = (path: string, content = 'export default function App() { return null; }') => ({ path, content });

describe('stripping binaries', () => {
  it('drops the base64 assets that dominate a real project', () => {
    // The measured shape: a handful of huge images against a little source.
    const out = stripBinariesForClient([
      bin('public/assets/about-hero.jpg', 6000),
      bin('public/assets/about-splash.jpg', 3690),
      text('src/App.tsx'),
      text('src/pages/Home.tsx'),
    ]);
    expect(out.map((f) => f.path)).toEqual(['src/App.tsx', 'src/pages/Home.tsx']);
  });

  it('leaves every text file untouched, content included', () => {
    // The editor's preview fallback builds from these when its workspace state
    // is empty, so thinning them would change behaviour, not just bandwidth.
    const src = [text('src/App.tsx', 'const a = 1;'), text('index.html', '<html></html>')];
    expect(stripBinariesForClient(src)).toEqual(src);
  });

  it('covers each never-pruned extension', () => {
    const exts = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp4', 'mp3', 'pdf', 'zip', 'svg'];
    const out = stripBinariesForClient(exts.map((e) => bin(`public/a.${e}`)));
    expect(out).toEqual([]);
  });
});

describe('what must NOT be stripped', () => {
  it('keeps a sentinel-carrying file whose extension IS prunable', () => {
    // .docx is not in NEVER_PRUNE_EXT_RE, so preview-service would delete it if
    // a fullSync omitted it. Both conditions must hold before dropping.
    const docx = { path: 'public/assets/terms.docx', content: SENTINEL + 'AAAA' };
    expect(stripBinariesForClient([docx])).toEqual([docx]);
  });

  it('keeps a binary-extension file that carries no sentinel', () => {
    // A .svg written as real text is source, not an encoded blob.
    const svg = text('public/logo.svg', '<svg viewBox="0 0 1 1"></svg>');
    expect(stripBinariesForClient([svg])).toEqual([svg]);
  });

  it('matches the sentinel only as a prefix, never anywhere in the content', () => {
    // Extension must be one of the never-pruned ones, otherwise the extension
    // guard alone would keep this file and the prefix check would go untested.
    const svg = text('public/logo.svg', `<!-- ${SENTINEL} --><svg></svg>`);
    expect(stripBinariesForClient([svg])).toEqual([svg]);
  });

  it('tolerates a missing content field without dropping the entry', () => {
    const odd = { path: 'src/App.tsx' } as unknown as { path: string; content: string };
    expect(stripBinariesForClient([odd])).toEqual([odd]);
  });
});

describe('measuring the saving', () => {
  it('reports a real reduction on the measured shape', () => {
    const files = [bin('public/a.jpg', 6000), bin('public/b.png', 2500), text('src/App.tsx')];
    const after = payloadBytes(stripBinariesForClient(files));
    expect(payloadBytes(files)).toBeGreaterThan(8_000_000);
    expect(after).toBeLessThan(1_000);
  });

  it('is a no-op on an all-text project', () => {
    const files = [text('src/App.tsx'), text('src/main.tsx')];
    expect(payloadBytes(stripBinariesForClient(files))).toBe(payloadBytes(files));
  });
});
