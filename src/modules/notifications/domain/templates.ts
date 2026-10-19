/** Pure email templates. No framework or provider imports (domain purity rule). */
export type EmailMessage = { to: string; subject: string; text: string; html?: string };

const BRAND = 'DOPAMEAN';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function wrap(
  title: string,
  lines: string[],
  action?: { label: string; url: string },
): Pick<EmailMessage, 'text' | 'html'> {
  const text = [
    ...lines,
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '',
    `- ${BRAND}`,
  ].join('\n');
  const body = lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('');
  const button = action
    ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : '';
  const html = `<div style="font-family:monospace;font-size:14px"><h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>${body}${button}<p>- ${BRAND}</p></div>`;
  return { text, html };
}

export function verifyEmailMessage(to: string, name: string, url: string): EmailMessage {
  return {
    to,
    subject: `Verify your email for ${BRAND}`,
    ...wrap(
      'Verify your email',
      [`Hi ${name || 'there'},`, 'Confirm your email address to finish creating your account.'],
      { label: 'Verify email', url },
    ),
  };
}

export function resetPasswordMessage(to: string, name: string, url: string): EmailMessage {
  return {
    to,
    subject: `Reset your ${BRAND} password`,
    ...wrap(
      'Reset your password',
      [
        `Hi ${name || 'there'},`,
        'We received a request to reset your password. If this was not you, ignore this email.',
      ],
      { label: 'Reset password', url },
    ),
  };
}

export function staffInviteMessage(
  to: string,
  name: string,
  role: string,
  url: string,
): EmailMessage {
  return {
    to,
    subject: `You have been added to ${BRAND} admin`,
    ...wrap(
      'Admin access',
      [`Hi ${name},`, `You now have the ${role} role. Set your password to sign in.`],
      { label: 'Set password', url },
    ),
  };
}
