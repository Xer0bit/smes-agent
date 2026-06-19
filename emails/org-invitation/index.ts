// @ts-nocheck
// Supabase Edge Function — organisation invitation
// Refactored version of supabase/functions/send-org-invitation using shared base
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { baseTemplate, safe } from '../_shared/base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/send-email.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, token, org_name, inviter_name, role } = body;

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);
    if (!token || typeof token !== 'string') return json({ error: 'Missing token' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://ecomgear.dev').replace(/\/$/, '');
    const acceptUrl = `${frontendUrl}/invite/${token}`;
    const safeOrg = safe(org_name, 'an organization');
    const safeInviter = safe(inviter_name, 'Someone');
    const safeRole = safe(role, 'member');

    const html = baseTemplate({
      title: "You're invited to join a team on EcomGear",
      preheader: `${safeInviter} invited you to join ${safeOrg} on EcomGear.`,
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">You're invited to join a team</h1>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          <strong>${safeInviter}</strong> invited you to join
          <strong>${safeOrg}</strong> on EcomGear as <strong>${safeRole}</strong>.
        </p>
      `,
      button: { label: 'Accept Invitation', url: acceptUrl },
      footer: 'This invitation expires in 7 days. If you don\'t have an EcomGear account yet, you\'ll be asked to create one after clicking the button above.<br><br>If you weren\'t expecting this invitation, you can safely ignore this email.',
      frontendUrl,
    });

    await sendEmail({
      to: email,
      subject: `${safeInviter} invited you to join ${safeOrg} on EcomGear`,
      html,
    }, resendKey);

    return json({ success: true });
  } catch (e) {
    console.error('org-invitation email error:', e);
    return json({ error: String(e) }, 500);
  }
});
