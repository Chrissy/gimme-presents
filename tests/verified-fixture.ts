import { env } from 'cloudflare:workers';
import { hash, randomToken } from '../worker/email-crypto';
export async function verifiedCookie(email = `${crypto.randomUUID()}@example.com`) {
  const owner = crypto.randomUUID(); const token = randomToken(); const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO owners (id, created_at, email_key, email_address, email_verified_at) VALUES (?, ?, ?, ?, ?)').bind(owner, now, email, email, now),
    env.DB.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at, verified) VALUES (?, ?, ?, 1)')
      .bind(await hash(token), owner, Math.floor(Date.now() / 1000) + 3600),
  ]);
  return `gimme_verified=${token}`;
}
