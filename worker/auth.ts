import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export type AppContext = Context<{ Bindings: Env }>;

const SESSION_COOKIE = 'gimme_session';
const SESSION_SECONDS = 180 * 24 * 60 * 60;
const RENEWAL_INTERVAL_SECONDS = 24 * 60 * 60;

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Anonymous ownership is a bearer credential. Only its hash is stored in D1. */
export async function currentOwner(c: AppContext): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    'SELECT owner_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?',
  ).bind(tokenHash, now).first<{ owner_id: string; expires_at: number }>();
  if (!row) return null;

  const renewalThreshold = now + SESSION_SECONDS - RENEWAL_INTERVAL_SECONDS;
  if (row.expires_at < renewalThreshold) {
    // Renew at most once a day, including when the owner is only reading a list.
    // The guard keeps concurrent requests from repeatedly extending the same session.
    const renewed = await c.env.DB.prepare(`
      UPDATE sessions SET expires_at = ?
      WHERE token_hash = ? AND expires_at > ? AND expires_at < ?
    `).bind(now + SESSION_SECONDS, tokenHash, now, renewalThreshold).run();
    if (renewed.meta.changes > 0) setSessionCookie(c, token);
  }
  return row.owner_id;
}

export async function newIdentity(db: D1Database, now: string) {
  const ownerId = crypto.randomUUID();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return {
    ownerId,
    token,
    statements: [
      db.prepare('INSERT INTO owners (id, created_at) VALUES (?, ?)').bind(ownerId, now),
      db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
        .bind(await hashToken(token), ownerId, Math.floor(Date.now() / 1000) + SESSION_SECONDS),
    ],
  };
}

export function setSessionCookie(c: AppContext, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'local' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}
