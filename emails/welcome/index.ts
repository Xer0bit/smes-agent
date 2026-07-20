// @ts-nocheck
// Supabase Edge Function   welcome email after registration is complete
// Trigger: after signup-complete function runs successfully
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { baseTemplate, safe } from '../_shared/base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/send-email.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, user_name, org_name } = body;

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://ecomgear.dev').replace(/\/$/, '');
    const safeName = safe(user_name, 'there');
    const safeOrg = safe(org_name);

    const html = baseTemplate({
      title: 'Welcome to EcomGear',
      preheader: 'Your account is ready   start building your first app.',
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Welcome to EcomGear${safeOrg ? `, ${safeOrg}` : ''}!</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">
          Hi ${safeName},
        </p>
        <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.6;">
          Your account is all set. EcomGear lets you build full-stack web apps by simply
          describing what you want   no boilerplate, no setup.
        </p>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          Here's how to get started:
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
          <tr>
            <td style="padding:8px 0;font-size:14px;color:#52525b;">
              <strong>1.</strong>&nbsp; Open your dashboard and create a new project
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:14px;color:#52525b;">
              <strong>2.</strong>&nbsp; Describe the app you want to build
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:14px;color:#52525b;">
              <strong>3.</strong>&nbsp; Watch the AI write and preview your code live
            </td>
          </tr>
        </table>
      `,
      button: { label: 'Go to Dashboard', url: `${frontendUrl}/dashboard` },
      footer: 'Questions? Reply to this email and we\'ll help you out.',
      frontendUrl,
    });

    await sendEmail({
      to: email,
      subject: 'Welcome to EcomGear   your account is ready',
      html,
    }, resendKey);

    return json({ success: true });
  } catch (e) {
    console.error('welcome email error:', e);
    return json({ error: String(e) }, 500);
  }
});
