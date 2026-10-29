import { env, exports as worker } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListResponse, LocalListsResponse, MeResponse } from '../shared/api';
import app from '../worker';

const ORIGIN = 'https://gimme.test';
const BASE_GIFT = { name: 'A good book', url: 'https://example.com/book', image: 'https://example.com/book.jpg', price: '12.34' };

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input) !== BASE_GIFT.image) throw new Error('Unexpected external request');
    return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
  });
});
afterEach(() => vi.restoreAllMocks());

function request(path: string, method = 'GET', body?: unknown, cookie?: string, overrides: Record<string, string> = {}) {
  const headers = new Headers({ Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', ...overrides });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return worker.default.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createList(name = 'Christmas wishes', cookie?: string) {
  const response = await request('/api/lists', 'POST', { name }, cookie);
  expect(response.status).toBe(201);
  return {
    data: await response.json<ListResponse>(),
    cookie: cookie ?? response.headers.get('Set-Cookie')!.split(';')[0],
    setCookie: response.headers.get('Set-Cookie'),
  };
}

async function addGift(data: ListResponse, cookie: string, gift = BASE_GIFT) {
  const response = await request(`/api/lists/${data.list.id}/gifts`, 'POST', { ...gift, revision: data.list.revision }, cookie);
  expect(response.status).toBe(200);
  return response.json<ListResponse>();
}

async function readList(id: number, cookie?: string) {
  const response = await request(`/api/lists/by-id/${id}`, 'GET', undefined, cookie);
  expect(response.status).toBe(200);
  return response.json<ListResponse>();
}

describe('local list index', () => {
  it('includes every owner, zero-gift lists, and only index fields in stable newest-first order', async () => {
    const first = await createList('Older list');
    const second = await createList('Same day, lower ID');
    const third = await createList('Same day, higher ID', first.cookie);
    await addGift(first.data, first.cookie);
    await addGift(third.data, first.cookie);
    const older = '2020-12-01T10:00:00.000Z';
    const newer = '2025-12-01T10:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare('UPDATE lists SET created_at = ? WHERE id = ?').bind(older, first.data.list.id),
      env.DB.prepare('UPDATE lists SET created_at = ? WHERE id IN (?, ?)')
        .bind(newer, second.data.list.id, third.data.list.id),
    ]);

    const response = await app.fetch(new Request(`${ORIGIN}/api/local/lists`), { ...env, ENVIRONMENT: 'local' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    const data = await response.json() as LocalListsResponse;
    expect(data).toEqual({
      lists: [
        { id: third.data.list.id, name: third.data.list.name, slug: third.data.list.slug, createdAt: newer, giftCount: 1 },
        { id: second.data.list.id, name: second.data.list.name, slug: second.data.list.slug, createdAt: newer, giftCount: 0 },
        { id: first.data.list.id, name: first.data.list.name, slug: first.data.list.slug, createdAt: older, giftCount: 1 },
      ],
    });
  });

  it('returns an empty index without creating a session', async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/api/local/lists`), { ...env, ENVIRONMENT: 'local' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lists: [] });
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(0);
  });

  it('does not expose the index in production, even to a list owner', async () => {
    const owner = await createList();
    const response = await app.fetch(new Request(`${ORIGIN}/api/local/lists`, {
      headers: { Cookie: owner.cookie },
    }), { ...env, ENVIRONMENT: 'production' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'That API route could not be found.' });
    expect(response.headers.has('Set-Cookie')).toBe(false);
  });
});

describe('anonymous ownership', () => {
  it('creates an owner only when a list is created, stores a hash, and reuses a persistent session', async () => {
    const initial = await request('/api/me');
    expect(await initial.json()).toEqual({ lists: [] });
    expect(initial.headers.has('Set-Cookie')).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(0);

    const first = await createList();
    expect(first.data.canEdit).toBe(true);
    expect(first.setCookie).toContain('HttpOnly');
    expect(first.setCookie).toContain('Secure');
    expect(first.setCookie).toContain('SameSite=Lax');
    expect(first.setCookie).toContain('Max-Age=15552000');
    expect(first.setCookie).not.toContain('Domain=');
    const token = first.cookie.split('=')[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const session = await env.DB.prepare('SELECT token_hash, expires_at FROM sessions').first<{ token_hash: string; expires_at: number }>();
    expect(session!.token_hash).not.toBe(token);
    expect(session!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session!.expires_at).toBeGreaterThan(Date.now() / 1000 + 179 * 86400);

    const second = await createList('Birthday wishes', first.cookie);
    expect(second.setCookie).toBeNull();
    const me = await (await request('/api/me', 'GET', undefined, first.cookie)).json<MeResponse>();
    expect(me.lists.map(list => list.id)).toEqual([second.data.list.id, first.data.list.id]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(1);
  });

  it('allows public reading without exposing the owner or session', async () => {
    const { data, cookie } = await createList();
    const populated = await addGift(data, cookie);
    const response = await request(`/api/lists/${data.list.slug}`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    const publicData = await response.json<ListResponse>();
    expect(publicData).toEqual({ ...populated, canEdit: false });
    expect(JSON.stringify(publicData)).not.toMatch(/owner|token|session/);
    expect((await readList(data.list.id, cookie)).canEdit).toBe(true);
  });

  it('rejects another browser across every list and gift mutation', async () => {
    const owner = await createList('Private editing');
    const populated = await addGift(owner.data, owner.cookie);
    const stranger = await createList('Other browser');
    const listPath = `/api/lists/${populated.list.id}`;
    const giftPath = `${listPath}/gifts/${populated.gifts[0].id}`;
    const attempts: Array<[string, string, object]> = [
      [listPath, 'PUT', { name: 'Hijacked', revision: 1 }],
      [listPath, 'DELETE', { revision: 1 }],
      [`${listPath}/gifts`, 'POST', { ...BASE_GIFT, revision: 1 }],
      [giftPath, 'PUT', { ...BASE_GIFT, revision: 1 }],
      [giftPath, 'DELETE', { revision: 1 }],
      [`${listPath}/reorder`, 'POST', { giftIds: [populated.gifts[0].id], revision: 1 }],
    ];
    for (const [path, method, body] of attempts) {
      expect((await request(path, method, body, stranger.cookie)).status).toBe(403);
      expect((await request(path, method, body)).status).toBe(403);
    }
    expect(await readList(populated.list.id, owner.cookie)).toEqual(populated);
    expect((await (await request('/api/me', 'GET', undefined, stranger.cookie)).json<MeResponse>()).lists)
      .toHaveLength(1);
  });

  it('rejects expired, forged, and malformed cookies without silently reclaiming an owner', async () => {
    const owner = await createList();
    const expiredAt = Math.floor(Date.now() / 1000) - 1;
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(expiredAt).run();
    const expiredRead = await request('/api/me', 'GET', undefined, owner.cookie);
    expect(expiredRead.headers.has('Set-Cookie')).toBe(false);
    expect(await expiredRead.json()).toEqual({ lists: [] });
    expect(await env.DB.prepare('SELECT expires_at FROM sessions').first('expires_at')).toBe(expiredAt);
    for (const cookie of [owner.cookie, `gimme_session=${'0'.repeat(64)}`, 'gimme_session=invalid']) {
      expect((await readList(owner.data.list.id, cookie)).canEdit).toBe(false);
      expect((await request(`/api/lists/${owner.data.list.id}`, 'DELETE', { revision: 0 }, cookie)).status).toBe(403);
    }
    const replacement = await createList('New browser session', owner.cookie);
    expect(replacement.setCookie).not.toBeNull();
    const newCookie = replacement.setCookie!.split(';')[0];
    expect((await readList(owner.data.list.id, newCookie)).canEdit).toBe(false);
  });

  it('renews a nearly expired session and cookie when an owner reads a list', async () => {
    const owner = await createList();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(now + 60).run();
    const response = await request(`/api/lists/${owner.data.list.slug}`, 'GET', undefined, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain(`${owner.cookie};`);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=15552000');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    expect(await response.json()).toEqual(owner.data);
    expect(await env.DB.prepare('SELECT expires_at FROM sessions').first<number>('expires_at'))
      .toBeGreaterThanOrEqual(now + 180 * 86400);
  });

  it('gives an active returning owner a full session lifetime when they create another list', async () => {
    const owner = await createList();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(now + 86400).run();
    const next = await createList('Another occasion', owner.cookie);
    expect(next.setCookie).toContain(`${owner.cookie};`);
    expect(next.setCookie).toContain('Max-Age=15552000');
    expect(await env.DB.prepare('SELECT expires_at FROM sessions').first<number>('expires_at'))
      .toBeGreaterThanOrEqual(now + 180 * 86400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(1);
    expect((await readList(owner.data.list.id, owner.cookie)).canEdit).toBe(true);
  });

  it('avoids session writes on fresh reads and renews only once across concurrent requests', async () => {
    const owner = await createList();
    await env.DB.prepare('CREATE TABLE session_update_audit (token_hash TEXT)').run();
    await env.DB.prepare(`
      CREATE TRIGGER audit_session_update AFTER UPDATE ON sessions
      BEGIN INSERT INTO session_update_audit (token_hash) VALUES (NEW.token_hash); END
    `).run();
    for (const path of ['/api/me', `/api/lists/${owner.data.list.slug}`]) {
      const response = await request(path, 'GET', undefined, owner.cookie);
      expect(response.status).toBe(200);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) FROM session_update_audit').first('COUNT(*)')).toBe(0);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(Math.floor(Date.now() / 1000) + 60).run();
    await env.DB.prepare('DELETE FROM session_update_audit').run();
    const responses = await Promise.all([
      request('/api/me', 'GET', undefined, owner.cookie),
      request('/api/me', 'GET', undefined, owner.cookie),
    ]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses.filter(response => response.headers.has('Set-Cookie'))).toHaveLength(1);
    const fresh = await request('/api/me', 'GET', undefined, owner.cookie);
    expect(fresh.headers.has('Set-Cookie')).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM session_update_audit').first('COUNT(*)')).toBe(1);
  });

  it('enforces HTTPS in production but supports HTTP local development', async () => {
    const body = JSON.stringify({ name: 'Local list' });
    const options = {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json' },
      body,
    };
    const insecureProduction = await app.fetch(new Request('http://localhost:5173/api/lists', options), { ...env, ENVIRONMENT: 'production' });
    expect(insecureProduction.status).toBe(400);
    const local = await app.fetch(new Request('http://localhost:5173/api/lists', options), { ...env, ENVIRONMENT: 'local' });
    expect(local.status).toBe(201);
    expect(local.headers.get('Set-Cookie')).not.toContain('Secure');
    const secureProduction = await app.fetch(new Request(`${ORIGIN}/api/lists`, {
      ...options, headers: { ...options.headers, Origin: ORIGIN },
    }), { ...env, ENVIRONMENT: 'production' });
    expect(secureProduction.headers.get('Set-Cookie')).toContain('Secure');
  });
});

describe('list and gift persistence', () => {
  it('supports add, edit, reorder, delete, and stable shared URLs', async () => {
    const owner = await createList();
    let data = await addGift(owner.data, owner.cookie);
    const firstGiftId = data.gifts[0].id;
    data = await addGift(data, owner.cookie, { ...BASE_GIFT, name: 'A red scarf', price: '' });
    const secondGiftId = data.gifts[0].id;
    expect(data.gifts.map(gift => gift.name)).toEqual(['A red scarf', 'A good book']);
    expect(data.gifts.map(gift => gift.priceCents)).toEqual([null, 1234]);
    const renamed = await request(`/api/lists/${data.list.id}`, 'PUT', { name: 'My renamed list', revision: data.list.revision }, owner.cookie);
    data = await renamed.json<ListResponse>();
    expect(data.list.slug).toBe(owner.data.list.slug);
    expect(data.list.name).toBe('My renamed list');
    const edited = await request(`/api/lists/${data.list.id}/gifts/${firstGiftId}`, 'PUT', {
      ...BASE_GIFT, name: 'A hardcover book', price: '0.10', revision: data.list.revision,
    }, owner.cookie);
    data = await edited.json<ListResponse>();
    expect(data.gifts.find(gift => gift.id === firstGiftId)!.priceCents).toBe(10);
    const reordered = await request(`/api/lists/${data.list.id}/reorder`, 'POST', {
      giftIds: [firstGiftId, secondGiftId], revision: data.list.revision,
    }, owner.cookie);
    data = await reordered.json<ListResponse>();
    expect(data.gifts.map(gift => gift.id)).toEqual([firstGiftId, secondGiftId]);
    expect(data.gifts.map(gift => gift.position)).toEqual([2, 1]);
    const removed = await request(`/api/lists/${data.list.id}/gifts/${secondGiftId}`, 'DELETE', { revision: data.list.revision }, owner.cookie);
    data = await removed.json<ListResponse>();
    expect(data.gifts).toHaveLength(1);
    expect(data.list.revision).toBe(6);
    expect((await request(`/api/lists/${data.list.id}`, 'DELETE', { revision: 6 }, owner.cookie)).status).toBe(200);
    expect((await request(`/api/lists/${data.list.slug}`)).status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM gifts').first('count')).toBe(0);
  });

  it('resolves imported numeric IDs, prefers an exact numeric slug, and has an unambiguous ID endpoint', async () => {
    const first = await createList('Original');
    const second = await createList('Numeric slug');
    await env.DB.prepare('UPDATE lists SET slug = ? WHERE id = ?').bind(String(first.data.list.id), second.data.list.id).run();
    const numericSlug = await (await request(`/api/lists/${first.data.list.id}`)).json<ListResponse>();
    expect(numericSlug.list.id).toBe(second.data.list.id);
    expect((await readList(first.data.list.id)).list.id).toBe(first.data.list.id);
    const fallback = await (await request(`/api/lists/${second.data.list.id}`)).json<ListResponse>();
    expect(fallback.list.id).toBe(second.data.list.id);
    expect((await request('/api/lists/not-a-list')).status).toBe(404);
  });

  it('keeps gifts scoped to their list even when the same browser owns both lists', async () => {
    const first = await createList('First');
    const firstData = await addGift(first.data, first.cookie);
    const second = await createList('Second', first.cookie);
    const secondData = await addGift(second.data, first.cookie);
    const wrongGift = secondData.gifts[0].id;
    for (const method of ['PUT', 'DELETE']) {
      expect((await request(`/api/lists/${firstData.list.id}/gifts/${wrongGift}`, method, {
        ...BASE_GIFT, revision: firstData.list.revision,
      }, first.cookie)).status).toBe(404);
    }
    expect((await request(`/api/lists/${firstData.list.id}/reorder`, 'POST', {
      giftIds: [wrongGift], revision: firstData.list.revision,
    }, first.cookie)).status).toBe(400);
    expect(await readList(firstData.list.id, first.cookie)).toEqual(firstData);
    expect(await readList(secondData.list.id, first.cookie)).toEqual(secondData);
  });

  it('rejects duplicate or incomplete reorder arrays without changing positions', async () => {
    const owner = await createList();
    const one = await addGift(owner.data, owner.cookie);
    const data = await addGift(one, owner.cookie, { ...BASE_GIFT, name: 'Second gift' });
    for (const giftIds of [[], [data.gifts[0].id], [data.gifts[0].id, data.gifts[0].id], [1.2, 3], ['1', '2']]) {
      expect((await request(`/api/lists/${data.list.id}/reorder`, 'POST', { giftIds, revision: data.list.revision }, owner.cookie)).status).toBe(400);
    }
    expect(await readList(data.list.id, owner.cookie)).toEqual(data);
  });

  it('returns a conflict for stale writes without partially applying any mutation', async () => {
    const owner = await createList();
    const first = await addGift(owner.data, owner.cookie);
    const current = await addGift(first, owner.cookie, { ...BASE_GIFT, name: 'Second gift' });
    const base = `/api/lists/${current.list.id}`;
    const attempts: Array<[string, string, object]> = [
      [base, 'PUT', { name: 'Stale title', revision: 1 }],
      [base, 'DELETE', { revision: 1 }],
      [`${base}/gifts`, 'POST', { ...BASE_GIFT, name: 'Stale gift', revision: 1 }],
      [`${base}/gifts/${current.gifts[0].id}`, 'PUT', { ...BASE_GIFT, revision: 1 }],
      [`${base}/gifts/${current.gifts[0].id}`, 'DELETE', { revision: 1 }],
      [`${base}/reorder`, 'POST', { giftIds: current.gifts.map(gift => gift.id).reverse(), revision: 1 }],
    ];
    for (const [path, method, body] of attempts) {
      expect((await request(path, method, body, owner.cookie)).status).toBe(409);
      expect(await readList(current.list.id, owner.cookie)).toEqual(current);
    }
  });

  it('allows exactly one of two concurrent edits at the same revision to commit', async () => {
    const owner = await createList();
    const data = await addGift(owner.data, owner.cookie);
    const path = `/api/lists/${data.list.id}/gifts`;
    const results = await Promise.all([
      request(path, 'POST', { ...BASE_GIFT, name: 'Writer A', revision: data.list.revision }, owner.cookie),
      request(path, 'POST', { ...BASE_GIFT, name: 'Writer B', revision: data.list.revision }, owner.cookie),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const committed = await readList(data.list.id, owner.cookie);
    expect(committed.list.revision).toBe(2);
    expect(committed.gifts).toHaveLength(2);
    expect(['Writer A', 'Writer B']).toContain(committed.gifts[0].name);
  });

  it('does not interpret legacy mutation URLs or GET requests as writes', async () => {
    const owner = await createList();
    const data = await addGift(owner.data, owner.cookie);
    for (const path of [`/api/lists/${data.list.id}/delete`, `/api/lists/${data.list.id}/reorder`, `/api/lists/${data.list.id}/gifts/${data.gifts[0].id}`]) {
      expect((await request(path, 'GET', undefined, owner.cookie)).status).toBe(404);
    }
    expect(await readList(data.list.id, owner.cookie)).toEqual(data);
  });
});

describe('request boundaries', () => {
  it('rejects missing and cross-site origin/custom headers', async () => {
    const cases: Record<string, string>[] = [
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', Origin: ORIGIN },
      { 'Content-Type': 'application/json', Origin: 'https://attacker.test', 'X-Requested-With': 'gimme-presents' },
      { 'Content-Type': 'application/json', Origin: 'null', 'X-Requested-With': 'gimme-presents' },
    ];
    for (const headers of cases) {
      expect((await worker.default.fetch(`${ORIGIN}/api/lists`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'A list' }),
      })).status).toBe(403);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(0);
  });

  it('requires JSON objects and bounds the actual body size', async () => {
    for (const [body, contentType, expected] of [
      ['name=A+list', 'application/x-www-form-urlencoded', 415],
      ['{', 'application/json', 400],
      ['[]', 'application/json', 400],
      ['null', 'application/json', 400],
      [JSON.stringify({ name: 'x'.repeat(17 * 1024) }), 'application/json', 413],
    ] as const) {
      const response = await worker.default.fetch(`${ORIGIN}/api/lists`, {
        method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': contentType }, body,
      });
      expect(response.status).toBe(expected);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(0);
  });

  it('validates list names and revisions', async () => {
    for (const name of ['', '  ', 'a'.repeat(121), 10, null]) {
      expect((await request('/api/lists', 'POST', { name })).status).toBe(400);
    }
    const owner = await createList();
    for (const revision of [undefined, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await request(`/api/lists/${owner.data.list.id}`, 'PUT', { name: 'New', revision }, owner.cookie)).status).toBe(400);
    }
  });

  it('rejects unsafe URL schemes, credentialed URLs, and invalid prices without writing gifts', async () => {
    const owner = await createList();
    const invalid = [
      { url: 'javascript:alert(1)' }, { image: 'data:image/svg+xml,test' }, { url: '//example.com' },
      { image: 'file:///etc/passwd' }, { url: 'https://user:password@example.com' },
      { url: `https://example.com/${'a'.repeat(2048)}` },
      { name: '' }, { name: 'a'.repeat(201) },
      { price: '-1' }, { price: '1.234' }, { price: 'Infinity' }, { price: '1e2' },
      { price: 1 }, { price: '100000000.00' },
    ];
    for (const changes of invalid) {
      expect((await request(`/api/lists/${owner.data.list.id}/gifts`, 'POST', {
        ...BASE_GIFT, ...changes, revision: 0,
      }, owner.cookie)).status).toBe(400);
    }
    expect(await readList(owner.data.list.id, owner.cookie)).toEqual(owner.data);
    const maximum = await addGift(owner.data, owner.cookie, { ...BASE_GIFT, price: '99999999.99' });
    expect(maximum.gifts[0].priceCents).toBe(9999999999);
  });

  it('reports database health and returns JSON for unknown API routes', async () => {
    expect(await (await request('/api/health')).json()).toEqual({ ok: true });
    for (const path of ['/api', '/api/unknown']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toContain('application/json');
    }
  });
});
