#!/usr/bin/env node
// Run: node emails/preview.mjs
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'preview');
mkdirSync(OUT, { recursive: true });

const FRONTEND_URL = 'https://SMEsAgent.dev';
const LOGO_URL = 'https://www.SMEsAgent.dev/assets/SMEsAgent-auth-logo-sfGodRbL.png';
const YEAR = new Date().getFullYear();

// ── base template (mirrors _shared/base-template.ts) ─────────────────────────
function safe(s, fallback = '') {
  return (s?.trim() || fallback).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function baseTemplate({ title, preheader, body, button, footer, frontendUrl }) {
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;color:#f9fafb;font-size:1px;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : '';

  const buttonHtml = button
    ? `<table cellpadding="0" cellspacing="0" style="margin:36px 0 0;">
         <tr>
           <td style="border-radius:8px;background:#4f46e5;box-shadow:0 2px 8px rgba(79,70,229,.28);">
             <a href="${button.url}"
                style="display:inline-block;padding:14px 32px;color:#ffffff;
                       text-decoration:none;font-weight:600;font-size:15px;
                       letter-spacing:-0.1px;white-space:nowrap;">
               ${button.label} &rarr;
             </a>
           </td>
         </tr>
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  ${preheaderHtml}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#f1f5f9;padding:48px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td align="center" style="background:#0f0f11;border-radius:14px 14px 0 0;padding:28px 40px 24px;">
            <a href="${frontendUrl}" style="text-decoration:none;display:inline-block;line-height:1;">
              <img src="${LOGO_URL}" alt="SMEsAgent" width="148"
                   style="display:block;height:auto;border:0;margin:0 auto;" />
            </a>
          </td>
        </tr>

        <!-- Accent bar -->
        <tr>
          <td style="background:linear-gradient(90deg,#4f46e5 0%,#7c3aed 100%);height:3px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:44px 40px 36px;">
            ${body}
            ${buttonHtml}
            ${footer
              ? `<p style="margin:32px 0 0;padding-top:28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.7;">${footer}</p>`
              : ''}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-radius:0 0 14px 14px;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:12px;color:#94a3b8;line-height:1.6;">
                  &copy; ${YEAR} SMEsAgent &middot;
                  <a href="${frontendUrl}" style="color:#94a3b8;text-decoration:underline;">SMEsAgent.dev</a>
                  &middot;
                  <a href="${frontendUrl}/dashboard/settings" style="color:#94a3b8;text-decoration:underline;">Manage preferences</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── shared body styles ────────────────────────────────────────────────────────
const h1 = `style="margin:0 0 16px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;line-height:1.3;"`;
const p  = `style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.75;"`;
const pl = `style="margin:0;font-size:15px;color:#475569;line-height:1.75;"`;

// ── templates ─────────────────────────────────────────────────────────────────
const templates = [
  {
    name: '2-welcome',
    subject: 'Welcome to SMEsAgent   your account is ready',
    from: 'SMEsAgent <noreply@SMEsAgent.dev>',
    html: baseTemplate({
      title: 'Welcome to SMEsAgent',
      preheader: 'Your account is ready   start building your first app in minutes.',
      body: `
        <h1 ${h1}>Welcome to SMEsAgent</h1>
        <p ${p}>Hi Jane,</p>
        <p ${p}>
          Your account is all set. SMEsAgent lets you build full-stack web apps by
          simply describing what you want   the AI writes the code, you see it live.
        </p>
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 0;">
          <tr>
            <td style="padding:14px 0;border-bottom:1px solid #f1f5f9;">
              <table cellpadding="0" cellspacing="0"><tr>
                <td style="width:32px;font-size:18px;vertical-align:top;">01</td>
                <td style="font-size:14px;color:#475569;line-height:1.6;padding-left:12px;">
                  <strong style="color:#0f172a;">Create a project</strong> from your dashboard
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 0;border-bottom:1px solid #f1f5f9;">
              <table cellpadding="0" cellspacing="0"><tr>
                <td style="width:32px;font-size:18px;vertical-align:top;">02</td>
                <td style="font-size:14px;color:#475569;line-height:1.6;padding-left:12px;">
                  <strong style="color:#0f172a;">Describe your app</strong> in plain language
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 0;">
              <table cellpadding="0" cellspacing="0"><tr>
                <td style="width:32px;font-size:18px;vertical-align:top;">03</td>
                <td style="font-size:14px;color:#475569;line-height:1.6;padding-left:12px;">
                  <strong style="color:#0f172a;">See it live</strong>   the AI writes and previews your code in real time
                </td>
              </tr></table>
            </td>
          </tr>
        </table>
      `,
      button: { label: 'Go to Dashboard', url: `${FRONTEND_URL}/dashboard` },
      footer: "Questions? Just reply to this email   we're happy to help.",
      frontendUrl: FRONTEND_URL,
    }),
  },
  {
    name: '4-project-invitation',
    subject: 'Jane Smith invited you to collaborate on "My Storefront"',
    from: 'SMEsAgent Invites <invite@SMEsAgent.dev>',
    html: baseTemplate({
      title: 'Project collaboration invitation',
      preheader: 'Jane Smith invited you to collaborate on "My Storefront" on SMEsAgent.',
      body: `
        <h1 ${h1}>You've been invited to collaborate</h1>
        <p ${p}>Hi there,</p>
        <table cellpadding="0" cellspacing="0"
               style="width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0 20px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Project</p>
              <p style="margin:0;font-size:17px;font-weight:700;color:#0f172a;">My Storefront</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 20px;">
              <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Invited by</p>
              <p style="margin:0;font-size:15px;color:#334155;font-weight:500;">Jane Smith</p>
            </td>
          </tr>
        </table>
        <p ${pl}>
          Accept the invitation to start collaborating. If you don't have an SMEsAgent
          account yet, you'll be guided to create one.
        </p>
      `,
      button: { label: 'Accept Invitation', url: `${FRONTEND_URL}/project-invite/preview_token` },
      footer: "This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.",
      frontendUrl: FRONTEND_URL,
    }),
  },
  {
    name: '5-org-invitation',
    subject: 'Jane Smith invited you to join Acme Co on SMEsAgent',
    from: 'SMEsAgent Invites <invite@SMEsAgent.dev>',
    html: baseTemplate({
      title: "You're invited to join a team on SMEsAgent",
      preheader: 'Jane Smith invited you to join Acme Co on SMEsAgent as editor.',
      body: `
        <h1 ${h1}>You're invited to join a team</h1>
        <p ${p}>Hi there,</p>
        <table cellpadding="0" cellspacing="0"
               style="width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0 20px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Organisation</p>
              <p style="margin:0;font-size:17px;font-weight:700;color:#0f172a;">Acme Co</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 12px;">
              <table cellpadding="0" cellspacing="0" style="width:100%"><tr>
                <td style="width:50%;padding-bottom:8px;">
                  <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Invited by</p>
                  <p style="margin:0;font-size:15px;color:#334155;font-weight:500;">Jane Smith</p>
                </td>
                <td style="width:50%;padding-bottom:8px;">
                  <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">Your role</p>
                  <p style="margin:0;font-size:15px;color:#334155;font-weight:500;">Editor</p>
                </td>
              </tr></table>
            </td>
          </tr>
        </table>
        <p ${pl}>
          Accept the invitation to join the team. If you don't have an SMEsAgent
          account yet, you'll be guided to create one.
        </p>
      `,
      button: { label: 'Accept Invitation', url: `${FRONTEND_URL}/invite/preview_token` },
      footer: "This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.",
      frontendUrl: FRONTEND_URL,
    }),
  },
  {
    name: '6-quota-alert-80',
    subject: "You've used 80% of your SMEsAgent quota",
    from: 'SMEsAgent <noreply@SMEsAgent.dev>',
    html: baseTemplate({
      title: "80% of quota used",
      preheader: "You've used 80% of your monthly messages   upgrade to keep building.",
      body: `
        <h1 ${h1}>You're approaching your usage limit</h1>
        <p ${p}>Hi Jane,</p>
        <table cellpadding="0" cellspacing="0"
               style="width:100%;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin:4px 0 24px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 12px;font-size:14px;color:#92400e;font-weight:600;">
                40 of 50 messages used &mdash; 80% of your Free plan quota
              </p>
              <!-- progress bar -->
              <table cellpadding="0" cellspacing="0" style="width:100%;">
                <tr>
                  <td style="background:#fde68a;border-radius:99px;height:8px;overflow:hidden;">
                    <div style="background:#d97706;width:80%;height:8px;border-radius:99px;"></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p ${pl}>
          Upgrade your plan to keep building without interruption   your quota resets
          on the 1st of each month.
        </p>
      `,
      button: { label: 'Upgrade Plan', url: `${FRONTEND_URL}/pricing` },
      footer: `You will receive another alert if you reach 100%. <a href="${FRONTEND_URL}/dashboard/settings" style="color:#94a3b8;">Visit Settings</a> to manage your subscription.`,
      frontendUrl: FRONTEND_URL,
    }),
  },
  {
    name: '7-quota-alert-100',
    subject: "You've reached your SMEsAgent usage limit",
    from: 'SMEsAgent <noreply@SMEsAgent.dev>',
    html: baseTemplate({
      title: "Usage limit reached",
      preheader: "Your monthly quota is exhausted   upgrade to resume AI requests.",
      body: `
        <h1 ${h1}>Usage limit reached</h1>
        <p ${p}>Hi Jane,</p>
        <table cellpadding="0" cellspacing="0"
               style="width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin:4px 0 24px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 12px;font-size:14px;color:#991b1b;font-weight:600;">
                50 of 50 messages used &mdash; Free plan quota exhausted
              </p>
              <table cellpadding="0" cellspacing="0" style="width:100%;">
                <tr>
                  <td style="background:#fecaca;border-radius:99px;height:8px;overflow:hidden;">
                    <div style="background:#dc2626;width:100%;height:8px;border-radius:99px;"></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p ${pl}>
          New AI requests are paused until your quota resets or you upgrade your plan.
          Upgrade now to continue building without interruption.
        </p>
      `,
      button: { label: 'Upgrade Plan', url: `${FRONTEND_URL}/pricing` },
      footer: `Quotas reset on the 1st of each month. <a href="${FRONTEND_URL}/dashboard/settings" style="color:#94a3b8;">Visit Settings</a> to manage your subscription.`,
      frontendUrl: FRONTEND_URL,
    }),
  },
];

// ── remove stale build-alert preview if it exists ────────────────────────────
const stale = resolve(OUT, '8-build-alert.html');
if (existsSync(stale)) unlinkSync(stale);

// ── write files + index ───────────────────────────────────────────────────────
const rows = templates.map(t => {
  writeFileSync(resolve(OUT, `${t.name}.html`), t.html);
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #f1f5f9;">
        <a href="${t.name}.html"
           style="font-size:14px;font-weight:600;color:#4f46e5;text-decoration:none;">
          ${t.name}
        </a>
        <span style="display:block;font-size:12px;color:#64748b;margin-top:3px;">
          <strong>From:</strong> ${t.from} &nbsp;&middot;&nbsp; <strong>Subject:</strong> ${t.subject}
        </span>
      </td>
    </tr>`;
}).join('');

writeFileSync(resolve(OUT, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SMEsAgent Email Previews</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;padding:48px 24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
    .card{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden;}
    .header{background:#0f0f11;padding:24px 32px;border-bottom:3px solid #4f46e5;}
    .header img{display:block;height:auto;}
    .body{padding:28px 32px 8px;}
    h1{margin:0 0 4px;font-size:18px;font-weight:700;color:#0f172a;}
    .meta{margin:0 0 24px;font-size:13px;color:#64748b;}
    table{width:100%;}
    a{color:#4f46e5;}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="${LOGO_URL}" alt="SMEsAgent" width="140">
    </div>
    <div class="body">
      <h1>Email Previews</h1>
      <p class="meta">${templates.length} templates &mdash; click any to open</p>
      <table cellpadding="0" cellspacing="0">${rows}</table>
    </div>
  </div>
</body>
</html>`);

console.log(`\n✓ ${templates.length} email previews → emails/preview/\n`);
console.log(`  file://${OUT}/index.html\n`);
try { execSync(`xdg-open ${OUT}/index.html 2>/dev/null || open ${OUT}/index.html 2>/dev/null`, { stdio: 'ignore' }); } catch {}
