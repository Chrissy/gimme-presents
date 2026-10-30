import { env, exports as worker } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListResponse } from '../shared/api';
import { MAX_IMAGE_BYTES } from '../worker/images';

const ORIGIN = 'https://gimme.test';
const SOURCE = 'https://images.example.com/gift.png';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
const gift = { name: 'Gift', url: '', image: SOURCE, price: '' };

function request(path: string, method = 'GET', body?: object, cookie = '') {
  return worker.default.fetch(`${ORIGIN}${path}`, {
    method, headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function owner() {
  const response = await request('/api/lists', 'POST', { name: 'Images' });
  const data = await response.json<ListResponse>();
  return { data, cookie: response.headers.get('Set-Cookie')!.split(';')[0], path: `/api/lists/${data.list.id}/gifts` };
}

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PNG)); });
afterEach(() => { vi.restoreAllMocks(); });

describe('hosted gift images', () => {
  it('copies bytes to R2, preserves the source, and serves cacheable public GET/HEAD/304 responses', async () => {
    const user = await owner();
    const saved = await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie);
    expect(saved.status).toBe(200);
    const data = await saved.json<ListResponse>();
    const photo = data.gifts[0];
    expect(photo.image).toBe(SOURCE);
    expect(photo.imageUrl).toMatch(/^\/media\/[a-f0-9-]+\.png$/);
    expect(await env.DB.prepare('SELECT image FROM gifts').first('image')).toBe(SOURCE);
    const remoteCall = vi.mocked(fetch).mock.calls[0];
    expect(remoteCall[0]).toBe(SOURCE);
    expect(remoteCall[1]?.redirect).toBe('manual');
    expect(new Headers(remoteCall[1]?.headers).has('Cookie')).toBe(false);
    expect(new Headers(remoteCall[1]?.headers).has('Authorization')).toBe(false);
    vi.mocked(fetch).mockRejectedValue(new Error('Source no longer exists'));
    const image = await request(photo.imageUrl);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(image.headers.has('Set-Cookie')).toBe(false);
    const head = await request(photo.imageUrl, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(PNG.length));
    expect(await head.text()).toBe('');
    const unchanged = await worker.default.fetch(`${ORIGIN}${photo.imageUrl}`, { headers: { 'If-None-Match': image.headers.get('ETag')! } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing copy on ordinary edits and clears the reference when the image is removed', async () => {
    const user = await owner();
    let data = await (await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie)).json<ListResponse>();
    const path = `${user.path}/${data.gifts[0].id}`;
    const imageUrl = data.gifts[0].imageUrl;
    vi.mocked(fetch).mockRejectedValue(new Error('Offline'));
    data = await (await request(path, 'PUT', { ...gift, name: 'Renamed', revision: 1 }, user.cookie)).json<ListResponse>();
    expect(data.gifts[0].imageUrl).toBe(imageUrl);
    expect(data.gifts[0].name).toBe('Renamed');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    data = await (await request(path, 'PUT', { ...gift, image: '', revision: 2 }, user.cookie)).json<ListResponse>();
    expect(data.gifts[0].imageUrl).toBe('');
    expect(await env.DB.prepare('SELECT image_key FROM gifts').first('image_key')).toBeNull();
  });

  it('retains legacy URLs without fetching them during ordinary edits', async () => {
    const user = await owner();
    const data = await (await request(user.path, 'POST', { ...gift, image: '', revision: 0 }, user.cookie)).json<ListResponse>();
    // The importer preserves URLs verbatim; new URL() would add a slash here.
    const legacySource = 'https://images.example.com';
    await env.DB.prepare('UPDATE gifts SET image = ? WHERE id = ?').bind(legacySource, data.gifts[0].id).run();
    const edited = await request(`${user.path}/${data.gifts[0].id}`, 'PUT', { ...gift, image: legacySource, name: 'Legacy', revision: 1 }, user.cookie);
    expect(edited.status).toBe(200);
    const photo = (await edited.json<ListResponse>()).gifts[0];
    expect(photo.image).toBe(legacySource);
    expect(photo.imageUrl).toBe(legacySource);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('checks ownership and revision before downloading anything', async () => {
    const user = await owner();
    const stranger = await owner();
    for (const cookie of ['', stranger.cookie]) {
      expect((await request(user.path, 'POST', { ...gift, revision: 0 }, cookie)).status).toBe(403);
    }
    expect((await request(user.path, 'POST', { ...gift, revision: 9 }, user.cookie)).status).toBe(409);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
  });

  it('leaves a gift and its revision unchanged when a replacement cannot be downloaded', async () => {
    const user = await owner();
    const original = await (await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie)).json<ListResponse>();
    vi.mocked(fetch).mockImplementation(async () => new Response('blocked', { status: 403 }));
    const replaced = await request(`${user.path}/${original.gifts[0].id}`, 'PUT', { ...gift, image: `${SOURCE}?new`, revision: 1 }, user.cookie);
    expect(replaced.status).toBe(422);
    const current = await (await request(`/api/lists/by-id/${original.list.id}`, 'GET', undefined, user.cookie)).json<ListResponse>();
    expect(current).toEqual(original);
    expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(1);
  });

  it('rejects local addresses and redirect destinations before fetching them', async () => {
    const user = await owner();
    for (const image of ['http://localhost/a', 'http://127.1/a', 'http://2130706433/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'https://photos.local/a', 'https://example.com:8443/a']) {
      expect((await request(user.path, 'POST', { ...gift, image, revision: 0 }, user.cookie)).status).toBe(422);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }));
    expect((await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie)).status).toBe(422);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('follows bounded public redirects and detects the actual format rather than trusting a MIME header', async () => {
    const user = await owner();
    vi.mocked(fetch)
      .mockImplementationOnce(async () => new Response(null, { status: 302, headers: { Location: '/actual' } }))
      .mockImplementationOnce(async () => new Response(PNG, { headers: { 'Content-Type': 'text/plain' } }));
    const result = await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie);
    expect(result.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://images.example.com/actual');
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 302, headers: { Location: '/loop' } }));
    expect((await request(user.path, 'POST', { ...gift, revision: 1 }, user.cookie)).status).toBe(422);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it('rejects HTML/SVG, misleading content lengths, and failed network requests without saving a gift', async () => {
    const user = await owner();
    const responses = [
      () => new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/png' } }),
      () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
      () => new Response(PNG, { headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1) } }),
      () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); controller.close(); } }), { headers: { 'Content-Length': '1' } }),
    ];
    for (const response of responses) {
      vi.mocked(fetch).mockImplementationOnce(async () => response());
      expect((await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie)).status).toBe(422);
    }
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network failed'));
    expect((await request(user.path, 'POST', { ...gift, revision: 0 }, user.cookie)).status).toBe(422);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM gifts').first('COUNT(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT revision FROM lists WHERE id = ?').bind(user.data.list.id).first('revision')).toBe(0);
    expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
  });

  it('does not serve missing objects or accept public writes', async () => {
    for (const path of ['/media/not-an-image', '/media/00000000-0000-0000-0000-000000000000.png']) {
      expect((await request(path)).status).toBe(404);
      expect((await request(path, 'PUT', {})).status).toBe(404);
    }
  });
});

describe('image file uploads', () => {
  function upload(path: string, method: string, cookie: string, fields: object, bytes: Uint8Array = PNG, mime = 'image/png') {
    const form = new FormData();
    form.set('gift', JSON.stringify(fields));
    form.set('imageFile', new File([new Uint8Array(bytes)], 'photo.png', { type: mime }));
    return worker.default.fetch(`${ORIGIN}${path}`, {
      method, headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', Cookie: cookie }, body: form,
    });
  }

  it('uploads bytes on create, preserves the image on rename, replaces it, and explicitly removes it', async () => {
    const user = await owner();
    const saved = await upload(user.path, 'POST', user.cookie, { ...gift, image: '', revision: 0 });
    expect(saved.status).toBe(200);
    let data = await saved.json<ListResponse>();
    expect(data.gifts[0].image).toBe('');
    const firstUrl = data.gifts[0].imageUrl;
    expect(firstUrl).toMatch(/^\/media\//);
    expect(new Uint8Array(await (await request(firstUrl)).arrayBuffer())).toEqual(PNG);
    const path = `${user.path}/${data.gifts[0].id}`;
    data = await (await request(path, 'PUT', { ...gift, image: '', name: 'Renamed upload', revision: 1 }, user.cookie)).json<ListResponse>();
    expect(data.gifts[0].imageUrl).toBe(firstUrl);
    data = await (await upload(path, 'PUT', user.cookie, { ...gift, image: '', revision: 2 })).json<ListResponse>();
    expect(data.gifts[0].imageUrl).not.toBe(firstUrl);
    expect(data.gifts[0].imageUrl).toMatch(/^\/media\//);
    data = await (await request(path, 'PUT', { ...gift, image: '', removeImage: true, revision: 3 }, user.cookie)).json<ListResponse>();
    expect(data.gifts[0].imageUrl).toBe('');
    expect(await env.DB.prepare('SELECT image_key FROM gifts').first('image_key')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects unauthorized, stale, invalid and oversized uploads without writing to R2', async () => {
    const user = await owner();
    const stranger = await owner();
    const fields = { ...gift, image: '', revision: 0 };
    for (const cookie of ['', stranger.cookie]) expect((await upload(user.path, 'POST', cookie, fields)).status).toBe(403);
    expect((await upload(user.path, 'POST', user.cookie, { ...fields, revision: 99 })).status).toBe(409);
    expect((await upload(user.path, 'POST', user.cookie, fields, new TextEncoder().encode('<svg/>'))).status).toBe(422);
    expect((await upload(user.path, 'POST', user.cookie, fields, new Uint8Array(MAX_IMAGE_BYTES + 1))).status).toBe(413);
    expect((await upload(user.path, 'POST', user.cookie, { ...fields, image: SOURCE })).status).toBe(400);
    expect((await upload(user.path, 'POST', user.cookie, { ...fields, removeImage: true })).status).toBe(400);
    expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM gifts').first('COUNT(*)')).toBe(0);
  });

  it('bounds streamed multipart bytes and rejects malformed metadata', async () => {
    const user = await owner();
    const malformed = new FormData();
    malformed.set('gift', '{');
    malformed.set('imageFile', new File([PNG], 'photo.png'));
    const response = await worker.default.fetch(`${ORIGIN}${user.path}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', Cookie: user.cookie }, body: malformed,
    });
    expect(response.status).toBe(400);
    const tooBig = await worker.default.fetch(`${ORIGIN}${user.path}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', Cookie: user.cookie, 'Content-Type': 'multipart/form-data; boundary=test' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 64 * 1024)); controller.close(); } }),
    });
    expect(tooBig.status).toBe(413);
    expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
  });
});
