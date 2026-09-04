#!/usr/bin/env node
// Run: RESEND_API_KEY=re_xxx node emails/test-send.mjs
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREVIEW = resolve(__dirname, 'preview');
const TO = 'sameersamiullah02@gmail.com';
const KEY = process.env.RESEND_API_KEY;

if (!KEY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

const emails = [
  { file: '2-welcome.html',          from: 'SMEsAgent <noreply@SMEsAgent.dev>',         subject: 'Welcome to SMEsAgent   your account is ready' },
  { file: '4-project-invitation.html', from: 'SMEsAgent Invites <invite@SMEsAgent.dev>', subject: 'Jane Smith invited you to collaborate on "My Storefront"' },
  { file: '5-org-invitation.html',   from: 'SMEsAgent Invites <invite@SMEsAgent.dev>', subject: 'Jane Smith invited you to join Acme Co on SMEsAgent' },
  { file: '6-quota-alert-80.html',   from: 'SMEsAgent <noreply@SMEsAgent.dev>',         subject: "You've used 80% of your SMEsAgent quota" },
  { file: '7-quota-alert-100.html',  from: 'SMEsAgent <noreply@SMEsAgent.dev>',         subject: "You've reached your SMEsAgent usage limit" },
];

async function send({ file, from, subject }) {
  const html = readFileSync(resolve(PREVIEW, file), 'utf8');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [TO], subject, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.id;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`\nSending ${emails.length} test emails to ${TO}...\n`);
for (const email of emails) {
  try {
    const id = await send(email);
    console.log(`  ✓  ${email.file.replace('.html', '')}  (${id})`);
  } catch (e) {
    console.error(`  ✗  ${email.file.replace('.html', '')}    ${e.message}`);
  }
  await sleep(600); // stay under Resend's 2 req/sec limit
}
console.log('\nDone. Check your inbox.\n');
