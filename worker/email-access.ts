import { HTTPException } from 'hono/http-exception';
import { anonymousSession, setSessionCookie, type AppContext } from './auth';
import { badRequest, jsonBody, name } from './validation';
import { encrypt, decrypt, hash, localMail, randomToken } from './email-crypto';
import { rate, deliver, type MailPayload } from './email-delivery';
import { assertChanged, listReservations, quotaBatch } from './owner-budget';

interface AccessRequest {
  id: string; client_key_hash: string; token_hash: string; email_key: string; email_address: string;
  list_name: string | null; list_slug: string | null; return_list_id: number | null;
  claim_owner_id: string | null; claim_session_hash: string | null;
  expires_at: number; consumed_at: number | null; owner_id: string | null;
}
export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return badRequest('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    || email.includes('..') || email.startsWith('.') || email.includes('.@')) return badRequest('Enter a valid email address.');
  return email;
}
function localHost(c: AppContext) { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname); }
function appOrigin(c: AppContext): string {
  return localMail(c.env) && localHost(c) ? new URL(c.req.url).origin : c.env.APP_ORIGIN;
}
function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

export async function requestAccess(c: AppContext): Promise<Response> {
  const body = await jsonBody(c); const email = normalizeEmail(body.email);
  if (typeof body.clientKey !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientKey)) return badRequest('Start a new email request.');
  const listName = body.name === undefined ? null : name(body.name, 'list');
  const returnId = Number.isSafeInteger(body.returnListId) && Number(body.returnListId) > 0 ? Number(body.returnListId) : null;
  const clientHash = await hash(body.clientKey);
  const now = Math.floor(Date.now() / 1000);
  const previous = await c.env.DB.prepare('SELECT * FROM auth_requests WHERE client_key_hash = ?').bind(clientHash).first<AccessRequest>();
  if (previous?.consumed_at) throw new HTTPException(409, { message: 'This request was already completed. Open the list or start a new recovery request.' });
  if (previous && previous.expires_at > now && !previous.consumed_at) {
    if ((previous.email_key !== email || previous.list_name !== listName) && body.replace !== true) return badRequest('Start a new request after changing the email or list name.');
    if (body.resend === true) {
      const recipient = await hash(email);
      await quotaBatch(c.env.DB, [...rate(c.env.DB, `recipient:minute:${recipient}`, 60, 1, now),
        ...rate(c.env.DB, `recipient:hour:${recipient}`, 3600, 3, now),
        ...rate(c.env.DB, `recipient:day:${recipient}`, 86400, 10, now)], 'Please wait before requesting another email.');
      // A resend keeps the list intent but issues a fresh proof below.
      // Sent jobs have already erased their encrypted payload.
    } else if (body.replace !== true) {
      await deliver(c.env, previous.id);
      return requestStatus(c, previous.id);
    }
  }
  if (!localMail(c.env) && (!c.env.RESEND_API_KEY || !c.env.EMAIL_ENCRYPTION_KEY)) {
    throw new HTTPException(503, { message: 'Email is temporarily unavailable. Please try again later.' });
  }
  const anonymous = body.claim === true ? await anonymousSession(c) : null;
  if (body.claim === true && !anonymous) return badRequest('Open this request in the browser that can edit your existing lists.');
  const token = randomToken(); const id = crypto.randomUUID();
  const slug = listName ? `${listName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'list'}-${id.replace(/-/g, '').slice(0, 12)}` : null;
  const link = `${appOrigin(c)}/auth/access#token=${token}`;
  const recovery = `${appOrigin(c)}/auth/recover`;
  const subject = listName ? 'Continue to your GimmePresents list' : 'Restore your GimmePresents access';
  const intro = listName ? `Continue to create “${listName}”.` : 'Continue to restore editing access to your lists.';
  const payload: MailPayload = { from: c.env.EMAIL_FROM, to: email, subject,
    text: `${intro}\n\n${link}\n\nThis link expires in 30 minutes. Get a fresh link any time: ${recovery}\n\nIf you did not request this email, you can ignore it.`,
    html: `<p>${escape(intro)}</p><p><a href="${escape(link)}">Continue to GimmePresents</a></p><p>This link expires in 30 minutes. <a href="${escape(recovery)}">Get a fresh link</a> any time.</p><p>If you did not request this email, you can ignore it.</p>`,
  };
  const recipient = await hash(email);
  const ip = await hash(`${c.env.EMAIL_ENCRYPTION_KEY || 'local'}:${c.req.header('CF-Connecting-IP') || 'unknown'}`);
  const statements: D1PreparedStatement[] = [
    ...rate(c.env.DB, 'requests:day', 86400, 180, now),
    ...rate(c.env.DB, `ip:hour:${ip}`, 3600, 10, now), ...rate(c.env.DB, `ip:day:${ip}`, 86400, 30, now),
  ];
  if (!(previous && previous.expires_at > now && !previous.consumed_at && body.resend === true)) statements.push(
    ...rate(c.env.DB, `recipient:minute:${recipient}`, 60, 1, now), ...rate(c.env.DB, `recipient:hour:${recipient}`, 3600, 3, now),
    ...rate(c.env.DB, `recipient:day:${recipient}`, 86400, 10, now));
  if (previous) statements.push(
    c.env.DB.prepare('DELETE FROM auth_requests WHERE id = ? AND consumed_at IS NULL').bind(previous.id),
    ...assertChanged(c.env.DB));
  statements.push(
    c.env.DB.prepare(`INSERT INTO auth_requests
      (id, client_key_hash, token_hash, email_key, email_address, list_name, list_slug, return_list_id, claim_owner_id, claim_session_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, clientHash, await hash(token), email, email, listName, slug, returnId, anonymous?.owner_id ?? null, anonymous?.token_hash ?? null, now, now + 1800),
    c.env.DB.prepare('INSERT INTO email_outbox (id, email_key, payload, next_attempt_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, email, await encrypt(c.env, payload), now, now + 1200),
  );
  await quotaBatch(c.env.DB, statements, 'Please wait before requesting another email.');
  await deliver(c.env, id);
  return requestStatus(c, id);
}
async function requestStatus(c: AppContext, id: string) {
  const status = await c.env.DB.prepare('SELECT status FROM email_outbox WHERE id = ?').bind(id).first<string>('status');
  if (status === 'failed') throw new HTTPException(503, { message: 'We couldn’t send that email. Check the address and try again later.' });
  return c.json({ ok: true, delivery: status === 'sent' ? 'sent' : 'pending', expiresIn: 1800 });
}
async function accessRequest(c: AppContext): Promise<AccessRequest> {
  const body = await jsonBody(c);
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new HTTPException(410, { message: 'This access link is invalid or expired. Request a fresh email.' });
  const row = await c.env.DB.prepare('SELECT * FROM auth_requests WHERE token_hash = ?').bind(await hash(body.token)).first<AccessRequest>();
  if (!row || row.consumed_at || row.expires_at <= Math.floor(Date.now() / 1000)) throw new HTTPException(410, { message: 'This access link has expired or was already used. Request a fresh email.' });
  return row;
}
export async function inspectAccess(c: AppContext) {
  const row = await accessRequest(c);
  return c.json({ email: row.email_address, name: row.list_name, claim: !!row.claim_owner_id });
}
export async function confirmAccess(c: AppContext): Promise<Response> {
  const row = await accessRequest(c); const now = Math.floor(Date.now() / 1000); const iso = new Date().toISOString();
  // The proof is already valid. Creating an empty verified owner is harmless if a
  // subsequent list allowance fails, and makes concurrent email requests converge.
  await c.env.DB.prepare('INSERT OR IGNORE INTO owners (id, created_at, email_key, email_address, email_verified_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), iso, row.email_key, row.email_address, iso).run();
  const ownerId = await c.env.DB.prepare('SELECT id FROM owners WHERE email_key = ?').bind(row.email_key).first<string>('id');
  if (!ownerId) throw new Error('Owner unavailable');
  const token = randomToken(); const day = iso.slice(0, 10);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare('UPDATE auth_requests SET consumed_at = ?, owner_id = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?')
      .bind(now, ownerId, row.id, now), ...assertChanged(c.env.DB),
  ];
  if (row.claim_owner_id && row.claim_session_hash) {
    statements.push(
      c.env.DB.prepare(`UPDATE sessions SET expires_at = expires_at WHERE token_hash = ? AND owner_id = ? AND verified = 0 AND expires_at > ?`)
        .bind(row.claim_session_hash, row.claim_owner_id, now), ...assertChanged(c.env.DB),
      c.env.DB.prepare(`UPDATE owner_usage SET reserved_bytes = reserved_bytes + (SELECT reserved_bytes FROM owner_usage WHERE owner_id = ?),
        lists = (CASE WHEN list_day = ? THEN lists ELSE 0 END) + (SELECT CASE WHEN list_day = ? THEN lists ELSE 0 END FROM owner_usage WHERE owner_id = ?), list_day = ?,
        uploads = (CASE WHEN upload_day = ? THEN uploads ELSE 0 END) + (SELECT CASE WHEN upload_day = ? THEN uploads ELSE 0 END FROM owner_usage WHERE owner_id = ?),
        upload_bytes = (CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END) + (SELECT CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END FROM owner_usage WHERE owner_id = ?), upload_day = ?
        WHERE owner_id = ?`).bind(row.claim_owner_id, day, day, row.claim_owner_id, day, day, day, row.claim_owner_id, day, day, row.claim_owner_id, day, ownerId),
      ...assertChanged(c.env.DB),
      c.env.DB.prepare('UPDATE lists SET owner_id = ?, revision = revision + 1 WHERE owner_id = ?').bind(ownerId, row.claim_owner_id),
      c.env.DB.prepare('DELETE FROM sessions WHERE owner_id = ?').bind(row.claim_owner_id),
      c.env.DB.prepare('DELETE FROM owner_usage WHERE owner_id = ?').bind(row.claim_owner_id),
    );
  }
  if (row.list_name && row.list_slug) statements.push(...listReservations(c.env.DB, ownerId, day),
    c.env.DB.prepare('INSERT INTO lists (name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(row.list_name, row.list_slug, ownerId, iso, iso));
  statements.push(c.env.DB.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at, verified) VALUES (?, ?, ?, 1)')
    .bind(await hash(token), ownerId, now + 180 * 86400),
    c.env.DB.prepare("UPDATE email_outbox SET payload = NULL, status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END WHERE id = ?").bind(row.id));
  await quotaBatch(c.env.DB, statements, 'This link could not be completed. It may have been used already, or a list allowance has been reached. Request a fresh recovery email if needed.');
  setSessionCookie(c, token, true);
  const target = row.list_slug ?? await c.env.DB.prepare('SELECT slug FROM lists WHERE owner_id = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1')
    .bind(ownerId, row.return_list_id).first<string>('slug');
  return c.json({ path: target ? `/${encodeURIComponent(target)}` : '/' });
}
export async function localInbox(c: AppContext): Promise<Response> {
  if (!localMail(c.env) || !localHost(c)) throw new HTTPException(404, { message: 'Not found.' });
  const rows = await c.env.DB.prepare("SELECT id, payload FROM email_outbox WHERE payload IS NOT NULL ORDER BY rowid DESC LIMIT 20").all<{ id: string; payload: string }>();
  const messages = await Promise.all(rows.results.map(async row => ({ id: row.id, ...await decrypt<MailPayload>(c.env, row.payload) })));
  return c.json({ messages });
}
