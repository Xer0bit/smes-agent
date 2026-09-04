// @ts-nocheck
// Supabase Edge Function   project collaboration invitation
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/email-cors.ts';
import { baseTemplate, safe } from '../_shared/email-base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/email-send.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, token, project_name, inviter_name } = body;

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);
    if (!token || typeof token !== 'string') return json({ error: 'Missing token' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://SMEsAgent.dev').replace(/\/$/, '');
    const acceptUrl = `${frontendUrl}/project-invite/${token}`;
    const safeProject = safe(project_name, 'a project');
    const safeInviter = safe(inviter_name, 'Someone');

    const html = baseTemplate({
      title: 'Project collaboration invitation',
      preheader: `${safeInviter} invited you to collaborate on "${safeProject}".`,
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">You've been invited to collaborate</h1>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          <strong>${safeInviter}</strong> has invited you to access the project
          <strong>"${safeProject}"</strong> on SMEsAgent.
        </p>
      `,
      button: { label: 'Accept Invitation', url: acceptUrl },
      footer: 'This invitation expires in 7 days. If you don\'t have an SMEsAgent account yet, you\'ll be asked to create one after clicking the button above.<br><br>If you weren\'t expecting this invitation, you can safely ignore this email.',
      frontendUrl,
    });

    await sendEmail({
      to: email,
      subject: `${safeInviter} invited you to "${safeProject}" on SMEsAgent`,
      html,
    }, resendKey);

    return json({ success: true });
  } catch (e) {
    console.error('project-invitation email error:', e);
    return json({ error: String(e) }, 500);
  }
});
