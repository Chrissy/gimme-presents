import { publicUrl } from './public-url';
import { GIFT_LOOKUP_TIMEOUT_MS } from '../shared/gift-suggestion-limits';
import { withinSignal } from './suggestion-deadline';

export interface ProductEvidence {
  title: string;
  description: string;
  images: { url: string; label: string }[];
  prices: { amount: string; currency: string; label: string }[];
}
export const MAX_PAGE_BYTES = 512 * 1024;
const text = (value: unknown, max = 200) => typeof value === 'string' ? decode(value).replace(/\s+/g, ' ').trim().slice(0, max) : '';
function decode(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function parseProductPage(html: string, pageUrl: string): Promise<ProductEvidence> {
  const result: ProductEvidence = { title: '', description: '', images: [], prices: [] };
  const meta = new Map<string, string>();
  const scripts: string[] = [];
  const pageImages: { source: string; label: string }[] = [];
  let title = '', heading = '', snippet = '';
  function image(value: unknown, label: string) {
    if (result.images.length >= 6) return;
    const source = text(record(value)?.url ?? record(value)?.contentUrl ?? value, 2048);
    if (!source) return;
    let url: URL | null;
    try { url = publicUrl(new URL(source, pageUrl).href); } catch { return; }
    if (url && !result.images.some(item => item.url === url.href)) result.images.push({ url: url.href, label: text(label, 100) });
  }
  function price(amount: unknown, currency: unknown, label: string) {
    const value = typeof amount === 'number' ? String(amount) : text(amount, 20);
    const unit = text(currency, 8).toUpperCase();
    if (/^\d{1,8}(\.\d{1,2})?$/.test(value) && /^[A-Z]{3}$/.test(unit) && result.prices.length < 6
      && !result.prices.some(item => item.amount === value && item.currency === unit)) {
      result.prices.push({ amount: value, currency: unit, label: text(label, 100) });
    }
  }
  let script = '', tooLong = false;
  const transformed = new HTMLRewriter()
    .on('meta', { element(element) {
      const key = (element.getAttribute('property') || element.getAttribute('name') || element.getAttribute('itemprop') || '').toLowerCase();
      if (meta.size < 100 && !meta.has(key)) meta.set(key, text(element.getAttribute('content'), 2048));
    } })
    .on('title', { text(chunk) { title = (title + chunk.text).slice(0, 300); } })
    .on('h1', { text(chunk) { heading = (heading + chunk.text).slice(0, 300); } })
    .on('p', { text(chunk) { snippet = (snippet + chunk.text).slice(0, 1000); } })
    .on('img[itemprop="image"], img#landingImage, img#imgBlkFront', { element(element) {
      if (pageImages.length < 6) pageImages.push({ source: element.getAttribute('data-old-hires') || element.getAttribute('src') || '',
        label: text(element.getAttribute('alt'), 100) });
    } })
    .on('script[type="application/ld+json"]', {
      element(element) { script = ''; tooLong = false; element.onEndTag(() => { if (!tooLong && scripts.length < 8) scripts.push(script); }); },
      text(chunk) { if (script.length + chunk.text.length > 64 * 1024) tooLong = true; else script += chunk.text; },
    }).transform(new Response(html));
  await transformed.text(); // The input has already been bounded to MAX_PAGE_BYTES.
  result.title = text(meta.get('og:title') || meta.get('twitter:title') || heading || title);
  result.description = text(meta.get('og:description') || meta.get('twitter:description') || meta.get('description'), 600);
  let visited = 0;
  function walk(value: unknown, depth = 0) {
    if (++visited > 300 || depth > 12) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const node = record(value); if (!node) return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.includes('Product')) {
      const name = text(node.name);
      result.title ||= name;
      result.description ||= text(node.description, 600);
      for (const item of Array.isArray(node.image) ? node.image : [node.image]) image(item, name);
      const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
      for (const value of offers.slice(0, 6)) {
        const offer = record(value); if (!offer) continue;
        // Aggregate ranges and "from" prices are not a selected variant's price.
        price(offer.price, offer.priceCurrency, name);
      }
    }
    for (const child of Object.values(node)) if (typeof child === 'object') walk(child, depth + 1);
  }
  for (const script of scripts) { try { walk(JSON.parse(script)); } catch { /* Ignore malformed product data. */ } }
  image(meta.get('og:image:secure_url'), result.title);
  image(meta.get('og:image'), result.title);
  image(meta.get('twitter:image') || meta.get('twitter:image:src'), result.title);
  for (const item of pageImages) image(item.source, item.label || result.title);
  price(meta.get('product:price:amount') || meta.get('og:price:amount'), meta.get('product:price:currency') || meta.get('og:price:currency'), result.title);
  price(meta.get('price'), meta.get('pricecurrency'), result.title);
  result.description ||= text(snippet, 600);
  return result;
}

export async function fetchProductPage(source: URL, signal = AbortSignal.timeout(GIFT_LOOKUP_TIMEOUT_MS)): Promise<ProductEvidence> {
  let url = source;
  return withinSignal(signal, async () => {
    for (let redirect = 0; redirect <= 3; redirect++) {
      signal.throwIfAborted();
      const response = await fetch(url.href, { redirect: 'manual', signal,
        headers: { Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'GimmePresents/1.0 (+https://gimmesomefreakingpresents.com)' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location');
        const next = location && publicUrl(new URL(location, url).href);
        if (!next || redirect === 3) throw new Error('Unavailable product page');
        url = next; continue;
      }
      if (!response.ok || !response.body || !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
        await response.body?.cancel(); throw new Error('Unavailable product page');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, html = '';
      try {
        while (bytes < MAX_PAGE_BYTES) {
          const { value, done } = await reader.read(); if (done) break;
          const part = value.subarray(0, MAX_PAGE_BYTES - bytes);
          bytes += part.byteLength; html += decoder.decode(part, { stream: true });
        }
        html += decoder.decode();
      } finally { await reader.cancel(); }
      return await parseProductPage(html, url.href);
    }
    throw new Error('Unavailable product page');
  });
}
