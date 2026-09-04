export interface EmailButton {
  label: string;
  url: string;
}

export interface BaseTemplateOptions {
  title: string;
  preheader?: string;
  body: string;
  button?: EmailButton;
  footer?: string;
  frontendUrl: string;
}

const LOGO_URL = 'https://www.SMEsAgent.dev/assets/SMEsAgent-auth-logo-sfGodRbL.png';

export function baseTemplate(opts: BaseTemplateOptions): string {
  const { title, preheader, body, button, footer, frontendUrl } = opts;
  const year = new Date().getFullYear();

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
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;mso-line-height-rule:exactly;">
  ${preheaderHtml}

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#f1f5f9;padding:48px 16px;">
    <tr><td align="center">

      <!-- Card -->
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td align="center" style="background:#0f0f11;border-radius:14px 14px 0 0;padding:28px 40px 24px;">
            <a href="${frontendUrl}" style="text-decoration:none;display:inline-block;line-height:1;">
              <img src="${LOGO_URL}"
                   alt="SMEsAgent"
                   width="148"
                   style="display:block;height:auto;border:0;outline:0;margin:0 auto;" />
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
                  &copy; ${year} SMEsAgent &middot;
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

export function safe(s: string | undefined, fallback = ''): string {
  return (s?.trim() || fallback).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
