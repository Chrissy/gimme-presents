import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { hash, randomToken } from './email-crypto';

export type AppContext = Context<{ Bindings: Env }>;
const SESSION_SECONDS = 180 * 24 * 60 * 60;
export interface Session { owner_id: string; token_hash: string; verified: number; email_address: string | null; expires_at: number }

async function session(c: AppContext, cookie: string, verified: boolean): Promise<Session | null> {
  const token = getCookie(c, cookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(`SELECT sessions.*, owners.email_address FROM sessions
    JOIN owners ON owners.id = sessions.owner_id WHERE token_hash = ? AND expires_at > ? AND verified = ?
    ${verified ? 'AND owners.email_verified_at IS NOT NULL' : ''}`)
    .bind(await hash(token), now, verified ? 1 : 0).first<Session>();
  if (!row) return null;
  if (row.expires_at < now + SESSION_SECONDS - 86400) {
    const changed = await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ? AND expires_at < ?')
      .bind(now + SESSION_SECONDS, row.token_hash, now, now + SESSION_SECONDS - 86400).run();
    if (changed.meta.changes) setSessionCookie(c, token, verified);
  }
  return row;
}
export const verifiedSession = (c: AppContext) => session(c, 'gimme_verified', true);
export const anonymousSession = (c: AppContext) => session(c, 'gimme_session', false);
export async function currentOwner(c: AppContext): Promise<string | null> {
  return ((await verifiedSession(c)) ?? (await anonymousSession(c)))?.owner_id ?? null;
}
export async function requireVerified(c: AppContext): Promise<Session> {
  const owner = await verifiedSession(c);
  if (!owner) throw new HTTPException(401, { message: 'Verify your email to create a list or add images.' });
  return owner;
}
export async function newIdentity(db: D1Database, now: string) {
  const ownerId = crypto.randomUUID(); const token = randomToken();
  return { ownerId, token, statements: [
    db.prepare('INSERT INTO owners (id, created_at) VALUES (?, ?)').bind(ownerId, now),
    db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
      .bind(await hash(token), ownerId, Math.floor(Date.now() / 1000) + SESSION_SECONDS),
  ] };
}
export function setSessionCookie(c: AppContext, token: string, verified = false): void {
  setCookie(c, verified ? 'gimme_verified' : 'gimme_session', token, {
    httpOnly: true, secure: c.env.ENVIRONMENT !== 'local' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS,
  });
}
export async function logout(c: AppContext) {
  for (const key of ['gimme_verified', 'gimme_session']) {
    const token = getCookie(c, key);
    if (token && /^[a-f0-9]{64}$/.test(token)) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(token)).run();
    deleteCookie(c, key, { path: '/' });
  }
  return c.json({ ok: true });
}
