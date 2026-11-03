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
  const intro = 'Welcome to Gimmesomefreakingpresents!';
  const action = listName ? 'Click here to create your list' : 'Click here to access your lists';

  return {
    from,
    to,
    subject,
    text: `${intro}\n\n${action}: ${accessUrl}\n\nThis stupid link expires in 30 minutes. You can Get a fresh link any time: ${recoveryUrl}`,
    html: `<p>${intro}</p><p><a href="${escapeHtml(accessUrl)}">${action}</a></p><p>This stupid link expires in 30 minutes. You can <a href="${escapeHtml(recoveryUrl)}">Get a fresh link</a> any time.</p>`,
  };
}
