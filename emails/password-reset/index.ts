// @ts-nocheck
// Supabase Edge Function — password reset email
// Trigger: Supabase Auth "Reset password" hook or called via auth route
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { baseTemplate, safe } from '../_shared/base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/send-email.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, reset_url, user_name } = body;

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);
    if (!reset_url || typeof reset_url !== 'string') {
      return json({ error: 'Missing reset_url' }, 400);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://ecomgear.dev').replace(/\/$/, '');
    const safeName = safe(user_name, 'there');

    const html = baseTemplate({
      title: 'Reset your EcomGear password',
      preheader: 'Click the link to set a new password for your account.',
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Reset your password</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">Hi ${safeName},</p>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          We received a request to reset the password for your EcomGear account.
          Click the button below to choose a new password.
        </p>
      `,
      button: { label: 'Reset password', url: reset_url },
      footer: 'This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email — your password will not change.',
      frontendUrl,
    });

    await sendEmail({ to: email, subject: 'Reset your EcomGear password', html }, resendKey);
    return json({ success: true });
  } catch (e) {
    console.error('password-reset email error:', e);
    return json({ error: String(e) }, 500);
  }
});
