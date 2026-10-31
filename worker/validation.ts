import { HTTPException } from 'hono/http-exception';
import type { AppContext } from './auth';
import { IMAGE_SIZE_ERROR, MAX_IMAGE_BYTES } from '../shared/image-limits';

const MAX_BODY_BYTES = 16 * 1024;

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

/** Bound actual streamed bytes before parsing JSON or multipart data. */
async function bodyBytes(c: AppContext, limit: number, sizeError = 'The request is too large.'): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(c.req.header('Content-Length') ?? 0) > limit) {
    throw new HTTPException(413, { message: sizeError });
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return badRequest('A request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HTTPException(413, { message: sizeError });
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

function jsonObject(text: string): Record<string, unknown> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return badRequest('A valid JSON object is required.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('A JSON object is required.');
  return body as Record<string, unknown>;
}

export async function jsonBody(c: AppContext): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HTTPException(415, { message: 'Send an application/json request.' });
  }
  const bytes = await bodyBytes(c, MAX_BODY_BYTES);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return badRequest('A valid JSON object is required.'); }
  return jsonObject(text);
}

export async function giftBody(c: AppContext): Promise<{ body: Record<string, unknown>; file?: File }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') return { body: await jsonBody(c) };
  // Allow bounded multipart framing in addition to the file and JSON metadata.
  const bytes = await bodyBytes(c, MAX_IMAGE_BYTES + 2 * MAX_BODY_BYTES, IMAGE_SIZE_ERROR);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { return badRequest('A valid image upload is required.'); }
  const metadata = form.get('gift');
  const file = form.get('imageFile');
  if (form.getAll('gift').length !== 1 || form.getAll('imageFile').length !== 1
    || typeof metadata !== 'string' || !(file instanceof File)) return badRequest('Provide one gift and one image.');
  if (new TextEncoder().encode(metadata).byteLength > MAX_BODY_BYTES) return badRequest('The gift details are too large.');
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new HTTPException(413, { message: IMAGE_SIZE_ERROR });
  const body = jsonObject(metadata);
  if (body.image || body.removeImage) return badRequest('Choose one image source.');
  return { body, file };
}

export function name(value: unknown, kind: 'list' | 'gift'): string {
  const limit = kind === 'list' ? 120 : 200;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    return badRequest(`The ${kind} name must be between 1 and ${limit} characters.`);
  }
  return value.trim();
}

export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return badRequest('A valid list revision is required.');
  }
  return value;
}

export function id(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return badRequest('A valid ID is required.');
  }
  return Number(value);
}

function url(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > 2048) {
    return badRequest(`${label} must be a URL of at most 2048 characters.`);
  }
  const input = value.trim();
  if (!input) return '';
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return badRequest(`${label} must start with http:// or https://.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return badRequest(`${label} must be an HTTP or HTTPS URL without login credentials.`);
  }
  return parsed.href;
}

function priceCents(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return badRequest('Price must be a dollar amount.');
  const input = value.trim();
  if (!input) return null;
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(input)) {
    return badRequest('Price must be between 0 and 99999999.99, with at most two decimal places.');
  }
  const [dollars, cents = ''] = input.split('.');
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
}

export function giftInput(body: Record<string, unknown>) {
  if (body.removeImage !== undefined && typeof body.removeImage !== 'boolean') return badRequest('Invalid image removal.');
  return {
    removeImage: body.removeImage === true,
    name: name(body.name, 'gift'),
    url: url(body.url, 'Gift link'),
    image: body.removeImage === true ? '' : url(body.image, 'Image link'),
    priceCents: priceCents(body.price),
  };
}

export function giftIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every(item =>
    typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
  ) || new Set(value).size !== value.length) {
    return badRequest('Provide each gift ID exactly once.');
  }
  return value;
}
