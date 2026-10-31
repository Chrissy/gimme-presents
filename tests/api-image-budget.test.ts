import { env, exports as worker } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import type { ListResponse } from '../shared/api';
import { MAX_IMAGE_BYTES } from '../worker/images';
import { MAX_DAILY_UPLOADS, MAX_DAILY_UPLOAD_BYTES, MAX_DAILY_IMAGE_READS, MAX_STORED_IMAGE_BYTES, reserveImageUpload, reserveImageRead } from '../worker/image-budget';

const ORIGIN = 'https://gimme.test';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
const day = () => new Date().toISOString().slice(0, 10);
async function owner() {
  const response = await worker.default.fetch(`${ORIGIN}/api/lists`, {
    method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Budget test' }),
  });
  const data = await response.json<ListResponse>();
  return { path: `/api/lists/${data.list.id}/gifts`, cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
}
function save(user: { path: string; cookie: string }, fields: object) {
  return worker.default.fetch(`${ORIGIN}${user.path}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json', Cookie: user.cookie },
    body: JSON.stringify({ name: 'Photo', url: '', price: '', image: 'https://images.example.com/photo.png', revision: 0, ...fields }),
  });
}
afterEach(() => vi.restoreAllMocks());

it('atomically reserves the last storage slot under concurrent uploads', async () => {
  await env.DB.prepare('UPDATE image_budget SET reserved_bytes = ?').bind(MAX_STORED_IMAGE_BYTES - MAX_IMAGE_BYTES).run();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveImageUpload(env.DB, MAX_IMAGE_BYTES)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(MAX_STORED_IMAGE_BYTES);
});

it('atomically limits daily uploads and resets the daily counter without resetting storage', async () => {
  await env.DB.prepare('UPDATE image_budget SET upload_day = ?, uploads = ?').bind(day(), MAX_DAILY_UPLOADS - 1).run();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveImageUpload(env.DB, 123)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await env.DB.prepare("UPDATE image_budget SET upload_day = '2000-01-01'").run();
  await reserveImageUpload(env.DB, 100);
  const budget = await env.DB.prepare('SELECT * FROM image_budget').first();
  expect(budget).toMatchObject({ reserved_bytes: 223, uploads: 1, upload_bytes: 100, upload_day: day() });
});

it('atomically limits daily bytes independently of upload count and keeps lifetime accounting on rollover', async () => {
  await env.DB.prepare('UPDATE image_budget SET upload_day = ?, upload_bytes = ?').bind(day(), MAX_DAILY_UPLOAD_BYTES - 100).run();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveImageUpload(env.DB, 100)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT * FROM image_budget').first()).toMatchObject({ uploads: 1, upload_bytes: MAX_DAILY_UPLOAD_BYTES, reserved_bytes: 100 });
  await env.DB.prepare("UPDATE image_budget SET upload_day = '2000-01-01'").run();
  await reserveImageUpload(env.DB, 50);
  expect(await env.DB.prepare('SELECT * FROM image_budget').first()).toMatchObject({ uploads: 1, upload_bytes: 50, reserved_bytes: 150 });
});

it('rejects a single reservation larger than the daily byte allowance even on a new day', async () => {
  await expect(reserveImageUpload(env.DB, MAX_DAILY_UPLOAD_BYTES + 1)).rejects.toMatchObject({ status: 429 });
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(0);
});

it('blocks downloads before fetch at the limit while allowing gifts without new images', async () => {
  const user = await owner();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PNG));
  await env.DB.prepare('UPDATE image_budget SET reserved_bytes = ?').bind(MAX_STORED_IMAGE_BYTES).run();
  expect((await save(user, {})).status).toBe(429);
  expect(fetch).not.toHaveBeenCalled();
  expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
  expect((await save(user, { image: '' })).status).toBe(200);
});

it('retains reservations for failed downloads, failed puts, and stale writes after upload', async () => {
  const user = await owner();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline'));
  expect((await save(user, {})).status).toBe(422);
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(MAX_IMAGE_BYTES);
  fetch.mockImplementation(async () => {
    await env.DB.prepare('UPDATE lists SET revision = revision + 1').run();
    return new Response(PNG);
  });
  expect((await save(user, {})).status).toBe(409);
  expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(1);
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(2 * MAX_IMAGE_BYTES);
  // Directly exercise an uncertain R2 failure without depending on proxy mocking.
  const { storeImageBytes } = await import('../worker/images');
  const bucket = { put: async () => { throw new Error('R2 unavailable'); } } as Pick<R2Bucket, 'put'>;
  await expect(storeImageBytes(env.DB, bucket as R2Bucket, PNG)).rejects.toThrow('R2 unavailable');
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(2 * MAX_IMAGE_BYTES + PNG.length);
});

it('limits every read method, missing key and cache-busting URL, then resets at the UTC day', async () => {
  const key = `${crypto.randomUUID()}.png`;
  await env.GIFT_IMAGES.put(key, PNG, { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare('UPDATE image_budget SET read_day = ?, reads = ?').bind(day(), MAX_DAILY_IMAGE_READS - 1).run();
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveImageRead(env.DB)));
  expect(results.filter(Boolean)).toHaveLength(1);
  for (const [url, method] of [[`/media/${key}`, 'GET'], [`/media/${key}?bust=1`, 'GET'], [`/media/${key}`, 'HEAD'], [`/media/${crypto.randomUUID()}.png`, 'GET']]) {
    const response = await worker.default.fetch(ORIGIN + url, { method });
    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect((await worker.default.fetch(`${ORIGIN}/media/not-a-key`)).status).toBe(404);
  await env.DB.prepare("UPDATE image_budget SET read_day = '2000-01-01'").run();
  expect((await worker.default.fetch(`${ORIGIN}/media/${key}`)).status).toBe(200);
  expect(await env.DB.prepare('SELECT reads FROM image_budget').first('reads')).toBe(1);
});

it('fails closed when the budget row is missing', async () => {
  await env.DB.prepare('DELETE FROM image_budget').run();
  const user = await owner();
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect((await save(user, {})).status).toBe(429);
  expect(fetch).not.toHaveBeenCalled();
  const key = `${crypto.randomUUID()}.png`;
  await env.GIFT_IMAGES.put(key, PNG);
  expect((await worker.default.fetch(`${ORIGIN}/media/${key}`)).status).toBe(429);
});

it('supports an emergency shutoff without resetting used capacity', async () => {
  await reserveImageUpload(env.DB, 123);
  await env.DB.prepare('UPDATE image_budget SET enabled = 0').run();
  await expect(reserveImageUpload(env.DB, 100)).rejects.toMatchObject({ status: 429 });
  expect(await reserveImageRead(env.DB)).toBe(false);
  expect(await env.DB.prepare('SELECT reserved_bytes FROM image_budget').first('reserved_bytes')).toBe(123);
});
