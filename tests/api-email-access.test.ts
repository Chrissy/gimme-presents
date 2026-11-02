import { env, exports as worker } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { Webhook } from 'svix';
import app from '../worker';
import { decrypt, hash, randomToken } from '../worker/email-crypto';
import { deliver, drainEmail, type MailPayload } from '../worker/email-delivery';
import { newIdentity } from '../worker/auth';

const ORIGIN = 'http://127.0.0.1:5173';
function call(path: string, body?: unknown, cookie?: string) {
  return worker.default.fetch(ORIGIN + path, { method: body ? 'POST' : 'GET',
    headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
}
async function start(email = 'owner@example.com', name?: string, extra: object = {}, cookie?: string) {
  const clientKey = randomToken();
  const response = await call('/api/auth/request', { email, ...(name ? { name } : {}), clientKey, ...extra }, cookie);
  expect(response.status).toBe(200);
  const row = await env.DB.prepare('SELECT auth_requests.id, payload FROM auth_requests JOIN email_outbox USING(id) WHERE client_key_hash = ?')
    .bind(await hash(clientKey)).first<{ id: string; payload: string }>();
  const mail = await decrypt<MailPayload>(env, row!.payload);
  const token = mail.text.match(/#token=([a-f0-9]{64})/)![1];
  return { token, id: row!.id, clientKey, mail };
}
afterEach(() => vi.restoreAllMocks());

it('waits for explicit proof, creates once under concurrent clicks, and restores the same owner', async () => {
  const first = await start('Owner@example.com', 'This year');
  expect(await env.DB.prepare('SELECT COUNT(*) FROM lists').first('COUNT(*)')).toBe(0);
  expect((await call('/api/lists', { name: 'No proof' })).status).toBe(401);
  for (let i = 0; i < 2; i++) expect((await call('/api/auth/inspect', { token: first.token })).status).toBe(200);
  const confirmations = await Promise.all(Array.from({ length: 5 }, () => call('/api/auth/confirm', { token: first.token })));
  const success = confirmations.find(r => r.status === 200)!;
  expect(confirmations.filter(r => r.status === 200)).toHaveLength(1);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM lists').first('COUNT(*)')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM sessions').first('COUNT(*)')).toBe(1);
  const cookie = success.headers.get('Set-Cookie')!.split(';')[0];
  expect(cookie).toMatch(/^gimme_verified=/);
  const me = await (await call('/api/me', undefined, cookie)).json<{ verified: boolean; lists: unknown[] }>();
  expect(me.verified).toBe(true); expect(me.lists).toHaveLength(1);
  expect((await call('/api/auth/confirm', { token: first.token })).status).toBe(410);
  await env.DB.prepare('DELETE FROM email_rate').run();
  const next = await start('owner@example.com', 'Next year');
  const restored = await call('/api/auth/confirm', { token: next.token });
  expect(restored.status).toBe(200);
  const freshCookie = restored.headers.get('Set-Cookie')!.split(';')[0];
  expect((await (await call('/api/me', undefined, freshCookie)).json<{ lists: unknown[] }>()).lists).toHaveLength(2);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM owners').first('COUNT(*)')).toBe(1);
});

it('does not give the requesting browser a session or expose existing lists', async () => {
  const first = await start('owner@example.com', 'Private title');
  await call('/api/auth/confirm', { token: first.token });
  await env.DB.prepare('DELETE FROM email_rate').run();
  const response = await call('/api/auth/request', { email: 'owner@example.com', clientKey: randomToken() });
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect(await response.text()).not.toMatch(/Private title|owner_id|token/);
  expect((await (await call('/api/me')).json<{ verified: boolean }>()).verified).toBe(false);
});

it('rejects expired proof without creating a session or list', async () => {
  const req = await start('owner@example.com', 'Expired');
  await env.DB.prepare('UPDATE auth_requests SET expires_at = 1').run();
  expect((await call('/api/auth/confirm', { token: req.token })).status).toBe(410);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM sessions').first('COUNT(*)')).toBe(0);
});

it('reuses a pending request on network retry and invalidates old proof on resend', async () => {
  const req = await start('owner@example.com', 'One list');
  expect((await call('/api/auth/request', { email: 'owner@example.com', name: 'One list', clientKey: req.clientKey })).status).toBe(200);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM auth_requests').first('COUNT(*)')).toBe(1);
  expect((await call('/api/auth/request', { email: 'owner@example.com', name: 'One list', clientKey: req.clientKey, resend: true })).status).toBe(429);
  await env.DB.prepare('DELETE FROM email_rate').run();
  expect((await call('/api/auth/request', { email: 'owner@example.com', name: 'One list', clientKey: req.clientKey, resend: true })).status).toBe(200);
  expect((await call('/api/auth/confirm', { token: req.token })).status).toBe(410);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM auth_requests').first('COUNT(*)')).toBe(1);
});

it('rolls back redemption, session creation and counters when the list allowance is full', async () => {
  const req = await start('owner@example.com', 'Wait');
  await env.DB.prepare('UPDATE list_creation_budget SET day = ?, attempts = 30').bind(new Date().toISOString().slice(0, 10)).run();
  expect((await call('/api/auth/confirm', { token: req.token })).status).toBe(429);
  expect(await env.DB.prepare('SELECT consumed_at FROM auth_requests').first('consumed_at')).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) FROM sessions').first('COUNT(*)')).toBe(0);
  expect(await env.DB.prepare('SELECT lists FROM owner_usage').first('lists')).toBe(0);
});

it('claims existing anonymous lists with both proofs and retains usage, revoking old sessions', async () => {
  const legacy = await newIdentity(env.DB, new Date().toISOString());
  await env.DB.batch([...legacy.statements,
    env.DB.prepare("INSERT INTO lists (name, slug, owner_id, created_at, updated_at) VALUES ('Old list', 'old-list', ?, '2020', '2020')").bind(legacy.ownerId),
    env.DB.prepare('UPDATE owner_usage SET reserved_bytes = 200 WHERE owner_id = ?').bind(legacy.ownerId),
  ]);
  const cookie = `gimme_session=${legacy.token}`;
  expect((await call('/api/lists', { name: 'Needs verification' }, cookie)).status).toBe(401);
  const req = await start('owner@example.com', undefined, { claim: true }, cookie);
  expect((await call('/api/auth/confirm', { token: req.token })).status).toBe(200);
  expect(await env.DB.prepare('SELECT reserved_bytes FROM owner_usage').first('reserved_bytes')).toBe(200);
  expect((await (await call('/api/me', undefined, cookie)).json<{ lists: unknown[] }>()).lists).toHaveLength(0);
  expect((await call('/api/auth/request', { email: 'other@example.com', clientKey: randomToken(), claim: true })).status).toBe(400);
});

it('does not let an old anonymous session become verified just because its owner has an email', async () => {
  const legacy = await newIdentity(env.DB, new Date().toISOString()); await env.DB.batch(legacy.statements);
  await env.DB.prepare("UPDATE owners SET email_key = 'owner@example.com', email_address = 'owner@example.com', email_verified_at = '2026'").run();
  expect((await call('/api/lists', { name: 'No upgrade' }, `gimme_session=${legacy.token}`)).status).toBe(401);
});

it('bounds requests before creating more pending records and preserves local-only capture', async () => {
  await start();
  expect((await call('/api/auth/request', { email: 'owner@example.com', clientKey: randomToken() })).status).toBe(429);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM auth_requests').first('COUNT(*)')).toBe(1);
  const prod = await app.fetch(new Request(ORIGIN.replace('http:', 'https:') + '/api/local/mail'), { ...env, ENVIRONMENT: 'production' });
  expect(prod.status).toBe(404);
});

it('bounds delivery retries and expires pending encrypted payloads', async () => {
  const req = await start();
  await env.DB.prepare("UPDATE email_outbox SET status = 'pending', attempts = 0").run();
  // Use a real-mode key compatible with the local capture encryption to test transport only.
  const sendingEnv = { ...env, EMAIL_MODE: 'resend' as const, EMAIL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(17))), RESEND_API_KEY: 'test-only' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline'));
  for (let i = 0; i < 3; i++) {
    await env.DB.prepare('UPDATE email_outbox SET next_attempt_at = 0').run();
    await deliver(sendingEnv, req.id);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe(`access/${req.id}`);
  expect(await env.DB.prepare('SELECT status, payload FROM email_outbox').first()).toEqual({ status: 'failed', payload: null });
  expect(await env.DB.prepare("SELECT count FROM email_rate WHERE key = 'provider:day'").first('count')).toBe(4);
  await env.DB.prepare('UPDATE auth_requests SET expires_at = 1').run(); await drainEmail(env);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(0);
});

it('authenticates delivery webhooks and suppresses bounced recipients idempotently', async () => {
  const secret = `whsec_${btoa('test-webhook-secret-32-bytes-value')}`;
  const payload = JSON.stringify({ type: 'email.bounced', data: { to: ['Owner@example.com'] } });
  const id = 'msg_test'; const date = new Date();
  const signature = new Webhook(secret).sign(id, date, payload);
  const send = (sig: string) => app.fetch(new Request(`${ORIGIN}/api/email/events`, { method: 'POST', body: payload,
    headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(date.getTime() / 1000)), 'svix-signature': sig } }), { ...env, RESEND_WEBHOOK_SECRET: secret });
  expect((await send('invalid')).status).toBe(400);
  expect((await send(signature)).status).toBe(200); expect((await send(signature)).status).toBe(200);
  expect(await env.DB.prepare('SELECT email_key FROM email_suppression').first('email_key')).toBe('owner@example.com');
});
