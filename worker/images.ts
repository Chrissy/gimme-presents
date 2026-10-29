import { HTTPException } from 'hono/http-exception';
import type { AppContext } from './auth';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|gif|webp)$/;

function invalidImage(message: string): never {
  throw new HTTPException(422, { message });
}

function publicImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return invalidImage('Use a public HTTP or HTTPS image link.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Workers' public fetch supplies the network boundary (no VPC binding or
  // private origin). Reject IP literals, local names and nonstandard ports too.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
    || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
    || /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host)) {
    return invalidImage('Use a public HTTP or HTTPS image link.');
  }
  return url;
}

function imageType(bytes: Uint8Array): { type: string; extension: string } {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 24 && starts(137, 80, 78, 71, 13, 10, 26, 10) && text(12, 16) === 'IHDR') {
    return { type: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 4 && starts(255, 216, 255)) return { type: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) return { type: 'image/gif', extension: 'gif' };
  if (bytes.length >= 16 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    return { type: 'image/webp', extension: 'webp' };
  }
  return invalidImage('That link must contain a PNG, JPEG, GIF, or WebP image.');
}

async function downloadImage(source: string): Promise<Uint8Array> {
  let url = publicImageUrl(source);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      // Never forward the user's cookies, authorization or other request headers.
      const response = await fetch(url.href, {
        redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location');
        if (!location || redirects === 3) return invalidImage('That image link redirects too many times or has no destination.');
        url = publicImageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return invalidImage('Couldn’t download that image. Try another image link.');
      }
      if (Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) {
        await response.body.cancel();
        return invalidImage('Choose an image smaller than 5 MB.');
      }
      // Bound streamed/decompressed bytes as well as the declared length.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) return invalidImage('Choose an image smaller than 5 MB.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    }
    return invalidImage('Couldn’t download that image. Try another image link.');
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return invalidImage('Couldn’t download that image. Try another image link.');
  } finally {
    clearTimeout(timeout);
  }
}

/** Call only after ownership and revision checks. Empty sources need no object. */
export async function storeImage(bucket: R2Bucket, source: string): Promise<string | null> {
  if (!source) return null;
  const bytes = await downloadImage(source);
  const { type, extension } = imageType(bytes);
  const key = `${crypto.randomUUID()}.${extension}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  return key;
}

export async function serveImage(c: AppContext): Promise<Response> {
  const key = c.req.param('key') ?? '';
  const headers = new Headers({ 'X-Content-Type-Options': 'nosniff' });
  if (!KEY_PATTERN.test(key)) return new Response('Image not found.', { status: 404, headers });
  const object = await c.env.GIFT_IMAGES.get(key);
  if (!object) return new Response('Image not found.', { status: 404, headers });
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  const tags = c.req.header('If-None-Match')?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
  if (tags?.includes(object.httpEtag) || tags?.includes('*')) {
    await object.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(object.size));
  if (c.req.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}
