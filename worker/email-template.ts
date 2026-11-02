export interface MailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface AccessEmailOptions {
  from: string;
  to: string;
  listName: string | null;
  accessUrl: string;
  recoveryUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!));
}

/** Renders message content without database, environment, or delivery access. */
export function renderAccessEmail({ from, to, listName, accessUrl, recoveryUrl }: AccessEmailOptions): MailPayload {
  const subject = listName ? 'Continue to your GimmePresents list' : 'Restore your GimmePresents access';
  const intro = listName ? `Continue to create “${listName}”.` : 'Continue to restore editing access to your lists.';

  return {
    from,
    to,
    subject,
    text: `${intro}\n\n${accessUrl}\n\nThis link expires in 30 minutes. Get a fresh link any time: ${recoveryUrl}\n\nIf you did not request this email, you can ignore it.`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(accessUrl)}">Continue to GimmePresents</a></p><p>This link expires in 30 minutes. <a href="${escapeHtml(recoveryUrl)}">Get a fresh link</a> any time.</p><p>If you did not request this email, you can ignore it.</p>`,
  };
}
