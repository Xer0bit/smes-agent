// @ts-nocheck
// Supabase Edge Function   usage quota warning alert
// Trigger: when user hits 80% or 100% of their plan's message/token quota
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, json } from '../_shared/email-cors.ts';
import { baseTemplate, safe } from '../_shared/email-base-template.ts';
import { sendEmail, EMAIL_REGEX } from '../_shared/email-send.ts';

type AlertLevel = '80' | '100';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const { email, user_name, used, limit, level, plan } = body as {
      email: string;
      user_name?: string;
      used: number;
      limit: number;
      level: AlertLevel;
      plan?: string;
    };

    if (!email || !EMAIL_REGEX.test(email)) return json({ error: 'Invalid email' }, 400);
    if (typeof used !== 'number' || typeof limit !== 'number') {
      return json({ error: 'Missing used/limit numbers' }, 400);
    }
    if (level !== '80' && level !== '100') return json({ error: 'Invalid level   use "80" or "100"' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'Email service not configured' }, 500);

    const frontendUrl = (Deno.env.get('FRONTEND_URL') || 'https://SMEsAgent.dev').replace(/\/$/, '');
    const safeName = safe(user_name, 'there');
    const safePlan = safe(plan, 'Free');
    const pct = Math.round((used / limit) * 100);
    const isExhausted = level === '100';

    const alertColor = isExhausted ? '#dc2626' : '#d97706';
    const alertBg = isExhausted ? '#fef2f2' : '#fffbeb';
    const alertBorder = isExhausted ? '#fecaca' : '#fde68a';

    const subject = isExhausted
      ? 'You\'ve reached your SMEsAgent usage limit'
      : `You've used ${pct}% of your SMEsAgent quota`;

    const html = baseTemplate({
      title: subject,
      preheader: subject,
      body: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">
          ${isExhausted ? 'Usage limit reached' : `${pct}% of quota used`}
        </h1>
        <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.6;">
          Hi ${safeName},
        </p>
        <div style="background:${alertBg};border:1px solid ${alertBorder};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
          <p style="margin:0;font-size:14px;color:${alertColor};font-weight:600;">
            ${isExhausted
              ? 'Your account has reached its monthly usage limit. New AI requests are paused until your quota resets or you upgrade.'
              : `You've used ${used.toLocaleString()} of ${limit.toLocaleString()} messages on your ${safePlan} plan.`
            }
          </p>
        </div>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          ${isExhausted
            ? 'Upgrade your plan to continue building without interruption.'
            : 'Upgrade now to avoid hitting your limit mid-project.'
          }
        </p>
      `,
      button: { label: 'Upgrade Plan', url: `${frontendUrl}/pricing` },
      footer: 'Quotas reset on the 1st of each month. Visit your <a href="${frontendUrl}/dashboard/settings" style="color:#94a3b8;">settings</a> to track usage.',
      frontendUrl,
    });

    await sendEmail({ to: email, subject, html }, resendKey);
    return json({ success: true });
  } catch (e) {
    console.error('quota-alert email error:', e);
    return json({ error: String(e) }, 500);
  }
});
