import { HTTPException } from 'hono/http-exception';
import type { AppContext } from './auth';

const MAX_BODY_BYTES = 16 * 1024;

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

/** Enforce the limit on streamed bytes too, not just the client-supplied length. */
export async function jsonBody(c: AppContext): Promise<Record<string, unknown>> {
  const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HTTPException(415, { message: 'Send an application/json request.' });
  }
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: 'The request is too large.' });
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return badRequest('A JSON object is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, { message: 'The request is too large.' });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return badRequest('A valid JSON object is required.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('A JSON object is required.');
  }
  return body as Record<string, unknown>;
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
  return {
    name: name(body.name, 'gift'),
    url: url(body.url, 'Gift link'),
    image: url(body.image, 'Image link'),
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
