import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
        const body = await req.json().catch(() => null);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const { project_name, inviter_name, email, token } = body;

        if (!email || typeof email !== 'string') return json({ error: 'Missing email' }, 400);
        if (!token || typeof token !== 'string') return json({ error: 'Missing token' }, 400);

        // Basic email format guard
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return json({ error: 'Invalid email address' }, 400);
        }

        const resendKey = Deno.env.get('RESEND_API_KEY');
        if (!resendKey) {
            console.error('RESEND_API_KEY not configured');
            return json({ error: 'Email service not configured' }, 500);
        }

        const frontendUrl = (Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL') || 'https://ecomgear.dev').replace(/\/$/, '');
        const acceptUrl = `${frontendUrl}/project-invite/${token}`;
        const displayProject = (project_name as string | undefined)?.trim() || 'a project';
        const displayInviter = (inviter_name as string | undefined)?.trim() || 'Someone';
        const safeProject = displayProject.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeInviter = displayInviter.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#18181b;padding:24px 32px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">⚡ EcomGear</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">You've been invited to collaborate</h1>
            <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
              <strong>${safeInviter}</strong> has invited you to access the project
              <strong>"${safeProject}"</strong> on EcomGear.
            </p>
            <a href="${acceptUrl}"
               style="display:inline-block;padding:13px 28px;background:#4f46e5;color:#ffffff;
                      border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;
                      letter-spacing:-0.2px;">
              Accept Invitation →
            </a>
            <p style="margin:28px 0 0;font-size:12px;color:#a1a1aa;line-height:1.6;">
              This invitation expires in 7 days. If you don't have an EcomGear account yet,
              you'll be asked to create one after clicking the button above.<br><br>
              If you weren't expecting this invitation, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e4e4e7;">
            <p style="margin:0;font-size:11px;color:#a1a1aa;">
              © ${new Date().getFullYear()} EcomGear · 
              <a href="${frontendUrl}" style="color:#a1a1aa;">ecomgear.dev</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'EcomGear <noreply@ecomgear.dev>',
                to: [email],
                subject: `${displayInviter} invited you to "${displayProject}" on EcomGear`,
                html,
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('Resend API error:', res.status, errText);
            return json({ error: 'Failed to send email' }, 500);
        }

        return json({ success: true });
    } catch (e) {
        console.error('send-project-invitation error:', e);
        return json({ error: String(e) }, 500);
    }
});
