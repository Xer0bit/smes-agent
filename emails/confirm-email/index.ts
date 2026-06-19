// @ts-nocheck
// Supabase Edge Function — email address confirmation
// Trigger: Supabase Auth "Confirm signup" hook or called directly after user registers
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { baseTemplate, safe } from '../_shared/base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/send-email.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, confirmation_url, user_name } = body;

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);
    if (!confirmation_url || typeof confirmation_url !== 'string') {
      return json({ error: 'Missing confirmation_url' }, 400);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://ecomgear.dev').replace(/\/$/, '');
    const safeName = safe(user_name, 'there');

    const html = baseTemplate({
      title: 'Confirm your EcomGear email',
      preheader: 'Please confirm your email address to activate your account.',
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Confirm your email address</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">
          Hi ${safeName},
        </p>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          Thanks for signing up to EcomGear. Click the button below to verify your
          email address and activate your account.
        </p>
      `,
      button: { label: 'Confirm email address', url: confirmation_url },
      footer: 'This link expires in 24 hours. If you did not create an EcomGear account, you can safely ignore this email.',
      frontendUrl,
    });

    await sendEmail({ to: email, subject: 'Confirm your EcomGear email address', html }, resendKey);
    return json({ success: true });
  } catch (e) {
    console.error('confirm-email error:', e);
    return json({ error: String(e) }, 500);
  }
});
