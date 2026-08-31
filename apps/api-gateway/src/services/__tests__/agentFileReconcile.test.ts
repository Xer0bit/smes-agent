/**
 * The guard that ends the cross-project re-contamination loop.
 *
 * The agent trusted the client's file list wholesale, so a stale tab holding
 * another project's files re-injected them on every run (CardPro kept becoming
 * CQjobs). This reconciler makes HEAD the authority on MEMBERSHIP while still
 * honoring the client for CONTENT: a client path HEAD has never seen is dropped
 * as contamination; a client path that IS in HEAD passes through with its
 * (possibly edited) content. Fail-open when there is no HEAD baseline.
 */
import { describe, it, expect } from 'vitest';
import { reconcileClientFilesToHead, type ClientFile } from '../agentFileReconcile.js';

const cf = (path: string, content = 'x'): ClientFile => ({ path, content });

describe('reconcileClientFilesToHead', () => {
  it('drops client paths that HEAD has never seen (the contamination)', () => {
    const client = [cf('src/App.tsx'), cf('src/pages/GigDetailPage.tsx'), cf('src/pages/JobsPage.tsx')];
    const head = new Set(['src/App.tsx', 'src/pages/CardDetailPage.tsx']);
    const { files, dropped } = reconcileClientFilesToHead(client, head);
    expect(files.map(f => f.path)).toEqual(['src/App.tsx']);
    expect(dropped.sort()).toEqual(['src/pages/GigDetailPage.tsx', 'src/pages/JobsPage.tsx']);
  });

  it('keeps the client content for a legitimate edit (membership, not content, is authoritative)', () => {
    const client = [cf('src/App.tsx', 'EDITED BY USER')];
    const head = new Set(['src/App.tsx']);
    const { files, dropped } = reconcileClientFilesToHead(client, head);
    expect(files).toEqual([{ path: 'src/App.tsx', content: 'EDITED BY USER' }]);
    expect(dropped).toEqual([]);
  });

  it('fail-open: no HEAD baseline (new/empty project) trusts the client unchanged', () => {
    const client = [cf('src/App.tsx'), cf('src/pages/New.tsx')];
    expect(reconcileClientFilesToHead(client, null).files).toEqual(client);
    expect(reconcileClientFilesToHead(client, new Set()).files).toEqual(client);
    expect(reconcileClientFilesToHead(client, undefined).dropped).toEqual([]);
  });

  it('keeps every client file when all belong to HEAD (the normal, uncontaminated case)', () => {
    const client = [cf('src/App.tsx'), cf('src/pages/CardDetailPage.tsx')];
    const head = new Set(['src/App.tsx', 'src/pages/CardDetailPage.tsx', 'src/pages/CartPage.tsx']);
    const { files, dropped } = reconcileClientFilesToHead(client, head);
    expect(files).toEqual(client);
    expect(dropped).toEqual([]);
  });
});
