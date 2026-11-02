import { HTTPException } from 'hono/http-exception';
import { Webhook } from 'svix';
import { assertChanged, quotaBatch } from './owner-budget';
import { decrypt, localMail } from './email-crypto';
import type { AppContext } from './auth';
import { bodyBytes } from './validation';

export interface MailPayload { from: string; to: string; subject: string; text: string; html: string }
export function rate(db: D1Database, key: string, seconds: number, limit: number, now: number): D1PreparedStatement[] {
  const window = Math.floor(now / seconds);
  return [db.prepare(`INSERT INTO email_rate (key, window, count, expires_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(key, window) DO UPDATE SET count = count + 1 WHERE count < ?`)
    .bind(key, window, (window + 1) * seconds, limit), ...assertChanged(db)];
}

/** Every actual provider attempt, including retries, reserves the shared budget. */
async function reserveSend(db: D1Database, now: number) {
  const month = new Date(now * 1000).toISOString().slice(0, 7);
  const end = new Date(now * 1000); end.setUTCMonth(end.getUTCMonth() + 1, 1); end.setUTCHours(0, 0, 0, 0);
  await quotaBatch(db, [
    ...rate(db, 'provider:day', 86400, 90, now),
    db.prepare(`INSERT INTO email_rate (key, window, count, expires_at) VALUES (?, 0, 1, ?)
      ON CONFLICT(key, window) DO UPDATE SET count = count + 1 WHERE count < 2500`)
      .bind(`provider:${month}`, Math.floor(end.getTime() / 1000)), ...assertChanged(db),
  ], 'Email is temporarily paused. Please try again later.');
}

export async function deliver(env: Env, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Lease before sending; a second invocation cannot send the same job concurrently.
  const job = await env.DB.prepare(`UPDATE email_outbox SET lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND lease_until <= ?
      AND expires_at > ? AND attempts < 3
    RETURNING *`).bind(now + 60, id, now, now, now).first<{
      payload: string; email_key: string; attempts: number; expires_at: number;
    }>();
  if (!job) return;
  if (await env.DB.prepare('SELECT 1 FROM email_suppression WHERE email_key = ?').bind(job.email_key).first()) {
    await env.DB.prepare("UPDATE email_outbox SET status = 'failed', payload = NULL WHERE id = ?").bind(id).run(); return;
  }
  try {
    await reserveSend(env.DB, now);
    const payload = await decrypt<MailPayload>(env, job.payload);
    if (localMail(env)) {
      await env.DB.prepare("UPDATE email_outbox SET status = 'sent', lease_until = 0 WHERE id = ?").bind(id).run(); return;
    }
    if (!env.RESEND_API_KEY) throw new Error('Email delivery unavailable');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `access/${id}` },
      body: JSON.stringify(payload),
    });
    // The endpoint response is small, but do not buffer an unbounded external body.
    const reader = response.body?.getReader(); let text = ''; let size = 0;
    if (reader) try { while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 16384) throw new Error('Invalid delivery response');
      text += new TextDecoder().decode(value);
    } } finally { await reader.cancel(); }
    if (!response.ok) {
      if (response.status < 500 && ![408, 429].includes(response.status)) {
        await env.DB.prepare("UPDATE email_outbox SET status = 'failed', payload = NULL WHERE id = ?").bind(id).run(); return;
      }
      throw new Error('Delivery retry');
    }
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('Invalid delivery response');
    await env.DB.prepare("UPDATE email_outbox SET status = 'sent', payload = NULL, provider_id = ?, lease_until = 0 WHERE id = ?")
      .bind(result.id, id).run();
  } catch {
    const final = job.attempts >= 3 || now + 120 >= job.expires_at;
    await env.DB.prepare(`UPDATE email_outbox SET status = ?, payload = CASE WHEN ? THEN NULL ELSE payload END,
      next_attempt_at = ?, lease_until = 0 WHERE id = ?`).bind(final ? 'failed' : 'pending', final ? 1 : 0, now + 120, id).run();
  }
}

export async function drainEmail(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE email_outbox SET status = 'failed', payload = NULL WHERE status = 'pending' AND (expires_at <= ? OR (attempts >= 3 AND lease_until <= ?))").bind(now, now),
    env.DB.prepare('DELETE FROM auth_requests WHERE expires_at < ?').bind(now - 86400),
    env.DB.prepare('DELETE FROM email_rate WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
  ]);
  const jobs = await env.DB.prepare("SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? AND lease_until <= ? ORDER BY next_attempt_at LIMIT 10")
    .bind(now, now).all<{ id: string }>();
  for (const job of jobs.results) await deliver(env, job.id);
}

export async function emailWebhook(c: AppContext): Promise<Response> {
  if (!c.env.RESEND_WEBHOOK_SECRET) throw new HTTPException(503, { message: 'Email events are not configured.' });
  const payload = new TextDecoder().decode(await bodyBytes(c, 65536));
  let event: unknown;
  try {
    new Webhook(c.env.RESEND_WEBHOOK_SECRET).verify(payload, {
      'svix-id': c.req.header('svix-id') || '', 'svix-timestamp': c.req.header('svix-timestamp') || '',
      'svix-signature': c.req.header('svix-signature') || '',
    });
    event = JSON.parse(payload);
  } catch { throw new HTTPException(400, { message: 'Invalid email event.' }); }
  if (event && typeof event === 'object' && 'type' in event && ['email.bounced', 'email.complained'].includes(String(event.type))
    && 'data' in event && event.data && typeof event.data === 'object' && 'to' in event.data && Array.isArray(event.data.to)) {
    for (const address of event.data.to.slice(0, 10)) {
      if (typeof address !== 'string' || address.length > 254) continue;
      const email = address.trim().toLowerCase();
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT OR IGNORE INTO email_suppression (email_key, created_at) VALUES (?, ?)').bind(email, Math.floor(Date.now() / 1000)),
        c.env.DB.prepare("UPDATE email_outbox SET status = 'failed', payload = NULL WHERE email_key = ? AND status = 'pending'").bind(email),
      ]);
    }
  }
  return c.json({ ok: true });
}
