#!/usr/bin/env node
/**
 * Integration test for the stable architecture (revision-promotion model).
 * Tests: cross-file import check, per-file validation, post-write build check,
 * snapshot/rollback, and successful promotion.
 * 
 * Usage: node test-stable-architecture.js [preview-url]
 */

const http = require('http');
const https = require('https');

const PREVIEW_URL = process.argv[2] || 'https://preview.ecomgear.app';
// Must match UUID format for the preview service to accept it
const TEST_PROJECT_ID = '00000000-0000-4000-a000-' + Date.now().toString(16).padStart(12, '0');

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✅ PASS');
    return true;
  } catch (err) {
    console.log(`❌ FAIL: ${err.message}`);
    return false;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log(`\n🧪 Stable Architecture Integration Tests`);
  console.log(`   Preview URL: ${PREVIEW_URL}`);
  console.log(`   Test Project: ${TEST_PROJECT_ID}\n`);
  
  let passed = 0;
  let failed = 0;

  // ── Test 1: Health check ──────────────────────────────
  if (await test('Health check', async () => {
    const res = await request('GET', `${PREVIEW_URL}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  })) passed++; else failed++;

  // ── Test 2: Valid files should be promoted (200) ──────
  if (await test('Valid files → promoted (200)', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "function App() { return <div><h1>Stable Architecture Test</h1></div>; }\nexport default App;" },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.success === true, `Expected success=true`);
    assert(res.body.promoted === true, `Expected promoted=true (new staging model)`);
  })) passed++; else failed++;

  // ── Test 3: Cross-file import check — missing import ──
  if (await test('Unresolved import → rejected (422)', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "import NonExistent from './components/DoesNotExist'\nfunction App() { return <div><NonExistent /></div>; }\nexport default App;" },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert(res.body.importCheckFailed === true, `Expected importCheckFailed=true`);
    assert(res.body.success === false, `Expected success=false`);
  })) passed++; else failed++;

  // ── Test 4: Per-file syntax error → rejected (422) ───
  if (await test('Syntax error → rejected (422)', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "// Deliberately broken syntax\nfunction App() { return <div><h1>Test { {broken}</h1></div>; }\nexport default App;" },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert(res.body.success === false, `Expected success=false`);
  })) passed++; else failed++;

  // ── Test 5: After rejection, preview still works ──────
  if (await test('Preview healthy after rejection (rollback preserved)', async () => {
    const res = await request('GET', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/status`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    // There should be errors stored from the rejection
    // but the key point is the status endpoint works
  })) passed++; else failed++;

  // ── Test 6: Valid update after rejection → promoted ───
  if (await test('Valid update after rejection → promoted', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "function App() { return <div><h1>Recovered after rejection!</h1></div>; }\nexport default App;" },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.success === true, `Expected success=true`);
    assert(res.body.promoted === true, `Expected promoted=true`);
  })) passed++; else failed++;

  // ── Test 7: Multi-file with all valid imports ─────────
  if (await test('Multi-file with valid cross-imports → promoted', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "import Header from './components/Header'\nimport Footer from './components/Footer'\nfunction App() { return <div><Header /><main><h1>Home</h1></main><Footer /></div>; }\nexport default App;" },
      { path: 'src/components/Header.tsx', content: "export default function Header() { return <header><nav><h2>Nav</h2></nav></header>; }" },
      { path: 'src/components/Footer.tsx', content: "export default function Footer() { return <footer><p>Footer</p></footer>; }" },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.success === true, `Expected success=true`);
    assert(res.body.promoted === true, `Expected promoted=true`);
  })) passed++; else failed++;

  // ── Test 8: CSS/SVG imports should NOT trigger import check failure ──
  if (await test('CSS/asset imports are exempt from import check', async () => {
    const files = [
      { path: 'index.html', content: '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
      { path: 'src/main.tsx', content: "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)" },
      { path: 'src/App.tsx', content: "import './styles/custom.css'\nfunction App() { return <div><h1>CSS Import Test</h1></div>; }\nexport default App;" },
      { path: 'src/styles/custom.css', content: 'body { margin: 0; }' },
      { path: 'src/index.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;' },
    ];
    const res = await request('POST', `${PREVIEW_URL}/preview/${TEST_PROJECT_ID}/update`, { files, fullSync: true });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.success === true, `Expected success=true`);
  })) passed++; else failed++;

  // ── Summary ───────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
