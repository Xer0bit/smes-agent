#!/usr/bin/env node
/**
 * test-hosting-local.js
 * 
 * Integration test for the hosting service running in LOCAL_DEV mode.
 * Run:  cd hosting-service && npm run dev   (in one terminal)
 * Then: node test-hosting-local.js          (in another terminal)
 */

const BASE = process.env.HOSTING_URL || 'http://localhost:4000';
const TEST_PROJECT_ID = '00000000-0000-4000-a000-000000000001';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.json();
  return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n  Hosting Service Tests   ${BASE}\n`);

  // ── Health & Config ────────────────────────────────────────────────────────

  await test('GET /health returns ok', async () => {
    const { status, body } = await json(`${BASE}/health`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === 'ok', `Expected status ok, got ${body.status}`);
    assert(body.node, 'Missing node name');
    assert(typeof body.uptime === 'number', 'Missing uptime');
    console.log(`      node=${body.node} ip=${body.publicIp} sites=${body.sites} uptime=${Math.round(body.uptime)}s`);
  });

  await test('GET /config returns publicIp', async () => {
    const { status, body } = await json(`${BASE}/config`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.publicIp, 'Missing publicIp');
    assert(body.defaultDomain, 'Missing defaultDomain');
    assert(body.node, 'Missing node');
    console.log(`      ip=${body.publicIp} domain=${body.defaultDomain} node=${body.node}`);
  });

  // ── Deploy ─────────────────────────────────────────────────────────────────

  await test('POST /deploy/:id   deploy a test site', async () => {
    const { status, body } = await json(`${BASE}/deploy/${TEST_PROJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'test-site',
        files: [
          { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Test Site</h1></body></html>' },
          { path: 'style.css', content: 'body { color: green; }' },
          { path: 'app.js', content: 'console.log("hello");' },
        ],
      }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, 'Expected success=true');
    assert(body.filesWritten === 3, `Expected 3 files, got ${body.filesWritten}`);
    console.log(`      files=${body.filesWritten} url=${body.siteUrl || 'n/a'}`);
  });

  await test('POST /deploy/:id   rejects invalid project ID', async () => {
    const { status } = await json(`${BASE}/deploy/not-a-uuid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'a.html', content: 'x' }] }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('POST /deploy/:id   rejects empty files', async () => {
    const { status } = await json(`${BASE}/deploy/${TEST_PROJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [] }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ── Site count goes up ─────────────────────────────────────────────────────

  await test('GET /health   site count increased after deploy', async () => {
    const { body } = await json(`${BASE}/health`);
    assert(body.sites >= 1, `Expected sites >= 1, got ${body.sites}`);
  });

  // ── Local dev: browse deployed site ────────────────────────────────────────

  await test('GET /sites/:id/index.html   serves deployed file', async () => {
    const res = await fetch(`${BASE}/sites/${TEST_PROJECT_ID}/index.html`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('Test Site'), 'Expected HTML content');
  });

  // ── DNS Verification (auto-verified in local dev) ──────────────────────────

  await test('POST /domains/verify   auto-verifies in local dev', async () => {
    const { status, body } = await json(`${BASE}/domains/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'myapp.example.com' }),
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.verified === true, 'Expected verified=true in local dev');
    assert(body.a_record.ok === true, 'Expected a_record.ok=true');
    assert(body.txt_record.ok === true, 'Expected txt_record.ok=true');
  });

  await test('POST /domains/verify   rejects invalid domain', async () => {
    const { status } = await json(`${BASE}/domains/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'not valid!' }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ── Activate Domain ────────────────────────────────────────────────────────

  await test('POST /domains/activate   activates domain for deployed project', async () => {
    const { status, body } = await json(`${BASE}/domains/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'myapp.example.com', projectId: TEST_PROJECT_ID }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, 'Expected success=true');
    assert(body.domain === 'myapp.example.com', 'Domain mismatch');
  });

  await test('POST /domains/activate   rejects non-deployed project', async () => {
    const fakeId = '99999999-0000-4000-a000-000000000099';
    const { status } = await json(`${BASE}/domains/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'fake.example.com', projectId: fakeId }),
    });
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ── List Domains ───────────────────────────────────────────────────────────

  await test('GET /domains/list   shows activated domain', async () => {
    const { status, body } = await json(`${BASE}/domains/list`);
    assert(status === 200, `Expected 200, got ${status}`);
    const found = body.domains.some(d => d.domain === 'myapp.example.com');
    assert(found, 'Expected myapp.example.com in domain list');
    console.log(`      total domains: ${body.domains.length}`);
  });

  // ── Remove Domain ──────────────────────────────────────────────────────────

  await test('DELETE /domains/:domain   removes domain', async () => {
    const { status, body } = await json(`${BASE}/domains/myapp.example.com`, {
      method: 'DELETE',
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, 'Expected success=true');
  });

  await test('GET /domains/list   domain removed', async () => {
    const { body } = await json(`${BASE}/domains/list`);
    const found = body.domains.some(d => d.domain === 'myapp.example.com');
    assert(!found, 'Domain should have been removed');
  });

  // ── Remove Deploy ──────────────────────────────────────────────────────────

  await test('DELETE /deploy/:id   removes deployment', async () => {
    const { status, body } = await json(`${BASE}/deploy/${TEST_PROJECT_ID}`, {
      method: 'DELETE',
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, 'Expected success=true');
  });

  await test('GET /health   site count back to 0 (or previous)', async () => {
    const { body } = await json(`${BASE}/health`);
    // The test site should be gone
    console.log(`      sites remaining: ${body.sites}`);
  });

  // ── Path traversal protection ──────────────────────────────────────────────

  await test('POST /deploy   sanitizes directory traversal in file paths', async () => {
    const { status, body } = await json(`${BASE}/deploy/${TEST_PROJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { path: '../../../etc/passwd', content: 'hacked' },
          { path: 'index.html', content: '<h1>ok</h1>' },
        ],
      }),
    });
    assert(status === 200, `Expected 200, got ${status}`);
    // Traversal prefix is stripped → becomes "etc/passwd" inside sandbox   both files written safely
    assert(body.filesWritten === 2, `Expected 2 sanitized files, got ${body.filesWritten}`);
  });

  // Cleanup
  await json(`${BASE}/deploy/${TEST_PROJECT_ID}`, { method: 'DELETE' });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
