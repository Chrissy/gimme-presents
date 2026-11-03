import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import app from '../worker';
import { verifiedCookie } from './verified-fixture';
import { parseProductPage, fetchProductPage, MAX_PAGE_BYTES } from '../worker/product-page';
import { metadataDraft, modelPrompt, MAX_PROMPT_BYTES, suggestWithModel } from '../worker/gift-suggestion-model';
import { cleanSuggestions, reserveSuggestion } from '../worker/suggestion-budget';
import type { GiftSuggestion, ListResponse } from '../shared/api';

const ORIGIN = 'https://gimme.test';
const URL = 'https://shop.example.com/mug?variant=blue';
const HTML = `<title>A mug</title><meta property="og:title" content="A blue mug &amp; lid">
<meta property="og:image" content="/share.jpg"><meta name="twitter:image" content="https://cdn.example.com/social.jpg">
<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Blue mug","image":["/main.jpg"],"offers":{"@type":"Offer","price":"24.50","priceCurrency":"USD"}}]}</script>`;
function call(path: string, cookie: string, body: object, ai?: Ai) {
  return app.fetch(new Request(ORIGIN + path, { method: 'POST', body: JSON.stringify(body),
    headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json', Cookie: cookie } }), { ...env, AI: ai });
}
async function owner() {
  const cookie = await verifiedCookie();
  const data = await (await call('/api/lists', cookie, { name: 'Wishes' })).json<ListResponse>();
  const ownerId = await env.DB.prepare('SELECT owner_id FROM lists WHERE id = ?').bind(data.list.id).first<string>('owner_id');
  return { cookie, path: `/api/lists/${data.list.id}/gift-suggestion`, ownerId: ownerId! };
}
function model(response = '{"name":"a mug for my personality substitute","image":0,"price":0}') {
  const run = vi.fn().mockResolvedValue({ response });
  return { ai: { run } as unknown as Ai, run };
}
const page = () => new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
afterEach(() => vi.restoreAllMocks());

it('combines product JSON-LD, Open Graph, and Twitter data with resolved public URLs', async () => {
  const data = await parseProductPage(HTML, URL);
  expect(data.title).toBe('A blue mug & lid');
  expect(data.images.map(x => x.url)).toEqual(['https://shop.example.com/main.jpg', 'https://shop.example.com/share.jpg', 'https://cdn.example.com/social.jpg']);
  expect(data.prices).toEqual([{ amount: '24.50', currency: 'USD', label: 'Blue mug' }]);
  const other = await parseProductPage(`<meta property="og:image" content="http://127.0.0.1/image"><script type="application/ld+json">broken</script><meta name="twitter:title" content="Cup"><meta property="product:price:amount" content="19.99"><meta property="product:price:currency" content="EUR">`, URL);
  expect(other.title).toBe('Cup'); expect(other.images).toEqual([]);
  expect(metadataDraft(URL, other).price).toBe('');
});

it('bounds decompressed page bytes, follows validated redirects, and forwards no credentials', async () => {
  let canceled = false;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/final' } }))
    .mockResolvedValueOnce(new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(HTML + ' '.repeat(MAX_PAGE_BYTES))); }, cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/html' } }));
  const result = await fetchProductPage(new globalThis.URL(URL));
  expect(result.title).toBe('A blue mug & lid'); expect(canceled).toBe(true);
  expect(fetch.mock.calls[1][0]).toBe('https://shop.example.com/final');
  expect(new Headers(fetch.mock.calls[0][1]?.headers).has('Cookie')).toBe(false);
  fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
  await expect(fetchProductPage(new globalThis.URL(URL))).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('returns only candidate facts and bounds the prompt even for long multilingual metadata', async () => {
  const data = await parseProductPage(HTML, URL);
  const { ai } = model('{"name":"a mug for my personality substitute","image":42,"price":42,"url":"https://wrong.example"}');
  expect(await suggestWithModel(ai, URL, data)).toEqual({ url: URL, name: 'a mug for my personality substitute', image: '', price: '' });
  data.title = '🎁'.repeat(200); data.description = '🎁'.repeat(600);
  for (let i = 0; i < 6; i++) data.images.push({ url: 'https://example.com/image', label: '🎁'.repeat(200) });
  const prompt = modelPrompt(data);
  expect(new TextEncoder().encode(prompt.messages.map(x => x.content).join('')).byteLength).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
  const euro = await parseProductPage(HTML.replace('USD', 'EUR'), URL);
  expect((await suggestWithModel(model().ai, URL, euro)).price).toBe('');
});

it('authenticates ownership before network work and rejects invalid public destinations', async () => {
  const user = await owner(), stranger = await verifiedCookie();
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect((await call(user.path, '', { url: URL })).status).toBe(401);
  expect((await call(user.path, stranger, { url: URL })).status).toBe(403);
  for (const url of ['http://localhost/a', 'http://127.1/a', 'http://2130706433/a', 'http://[::1]/a', 'https://user:pass@example.com', 'file:///a', 'https://shop.example.com:8443/a']) {
    expect((await call(user.path, user.cookie, { url })).status).toBe(400);
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT attempts FROM suggestion_budget').first('attempts')).toBe(0);
});

it('makes one model call, caches retries, and only saves the edited gift through the existing endpoint', async () => {
  const user = await owner(); const { ai, run } = model();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page());
  const response = await call(user.path, user.cookie, { url: URL }, ai);
  expect(response.status).toBe(200);
  const result = await response.json<GiftSuggestion>();
  expect(result.draft).toEqual({ url: URL, name: 'a mug for my personality substitute', price: '24.50', image: 'https://shop.example.com/main.jpg' });
  expect((await call(user.path, user.cookie, { url: URL + '#details' }, ai)).status).toBe(200);
  expect(run).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM gifts').first('COUNT(*)')).toBe(0);
  expect((await env.GIFT_IMAGES.list()).objects).toHaveLength(0);
  const saved = await call(user.path.replace('gift-suggestion', 'gifts'), user.cookie, { ...result.draft, name: 'My edited mug', image: '', revision: 0 });
  expect(saved.status).toBe(200);
  expect((await saved.json<ListResponse>()).gifts[0].name).toBe('My edited mug');
});

it('keeps metadata on model failure and counts unsuccessful attempts conservatively', async () => {
  const user = await owner(); const { ai, run } = model('not JSON');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page());
  const first = await (await call(user.path, user.cookie, { url: URL }, ai)).json<GiftSuggestion>();
  expect(first.draft.name).toBe('A blue mug & lid'); expect(first.notice).toBeTruthy();
  expect(run).toHaveBeenCalledTimes(1);
  fetch.mockRejectedValue(new Error('offline'));
  const second = await (await call(user.path, user.cookie, { url: URL + '&different=1' }, ai)).json<GiftSuggestion>();
  expect(second.draft.url).toBe(URL + '&different=1'); expect(second.draft.name).toBe('');
  expect(await env.DB.prepare('SELECT suggestions FROM owner_usage WHERE owner_id = ?').bind(user.ownerId).first('suggestions')).toBe(2);
  expect(await env.DB.prepare('SELECT suggestion_until FROM owner_usage WHERE owner_id = ?').bind(user.ownerId).first('suggestion_until')).toBe(0);
});

it('serializes concurrent attempts and rolls back owner reservations at the global limit', async () => {
  const user = await owner();
  const first = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserveSuggestion(env.DB, user.ownerId, `hash-${i}`)));
  expect(first.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT attempts FROM suggestion_budget').first('attempts')).toBe(1);
  expect(await env.DB.prepare('SELECT suggestions FROM owner_usage WHERE owner_id = ?').bind(user.ownerId).first('suggestions')).toBe(1);
  await env.DB.prepare('UPDATE owner_usage SET suggestion_until = 0').run();
  await env.DB.prepare('UPDATE suggestion_budget SET attempts = 300').run();
  await expect(reserveSuggestion(env.DB, user.ownerId, 'different')).rejects.toThrow('usage limit');
  expect(await env.DB.prepare('SELECT suggestions FROM owner_usage WHERE owner_id = ?').bind(user.ownerId).first('suggestions')).toBe(1);
  await env.DB.prepare('UPDATE suggestion_budget SET attempts = 1').run();
  await env.DB.prepare('UPDATE owner_usage SET suggestions = 50').run();
  await expect(reserveSuggestion(env.DB, user.ownerId, 'different')).rejects.toThrow('usage limit');
  expect(await env.DB.prepare('SELECT attempts FROM suggestion_budget').first('attempts')).toBe(1);
});

it('resets daily allowances and cleans short-lived cached results', async () => {
  const user = await owner();
  await env.DB.prepare("UPDATE owner_usage SET suggestion_day = '2000-01-01', suggestions = 50").run();
  await env.DB.prepare("UPDATE suggestion_budget SET day = '2000-01-01', attempts = 300").run();
  await reserveSuggestion(env.DB, user.ownerId, 'hash');
  expect(await env.DB.prepare('SELECT attempts FROM suggestion_budget').first('attempts')).toBe(1);
  await env.DB.prepare('UPDATE gift_suggestions SET expires_at = 0').run(); await cleanSuggestions(env.DB);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM gift_suggestions').first('COUNT(*)')).toBe(0);
});

it('uses a product image element when share metadata is absent and avoids generic challenge titles', async () => {
  const data = await parseProductPage('<h1>Travel duffel</h1><img id="landingImage" src="/small.jpg" data-old-hires="/large.jpg" alt="Green bag">', URL);
  expect(data.images[0]).toEqual({ url: 'https://shop.example.com/large.jpg', label: 'Green bag' });
  const challenge = await parseProductPage('<title>Amazon.com</title><p>Continue to view this page</p>', URL);
  expect(metadataDraft(URL, challenge).name).toBe('');
});

it('uses the same global budget for different verified owners under concurrency', async () => {
  const one = await owner(), two = await owner();
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare('UPDATE suggestion_budget SET day = ?, attempts = 299').bind(day).run();
  const attempts = await Promise.allSettled([reserveSuggestion(env.DB, one.ownerId, 'one'), reserveSuggestion(env.DB, two.ownerId, 'two')]);
  expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT attempts FROM suggestion_budget').first('attempts')).toBe(300);
  expect(await env.DB.prepare('SELECT SUM(suggestions) AS total FROM owner_usage').first('total')).toBe(1);
});

it('does not call the model for an uninformative page, and missing budget rows stop page fetching', async () => {
  const user = await owner(); const { ai, run } = model();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<title>Amazon.com</title>', { headers: { 'Content-Type': 'text/html' } }));
  const result = await (await call(user.path, user.cookie, { url: URL }, ai)).json<GiftSuggestion>();
  expect(result.draft.name).toBe(''); expect(run).not.toHaveBeenCalled();
  await env.DB.prepare('DELETE FROM suggestion_budget').run();
  expect((await call(user.path, user.cookie, { url: URL + '&new=1' }, ai)).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('aborts a slow model once without retrying inference', async () => {
  const evidence = await parseProductPage(HTML, URL);
  vi.useFakeTimers();
  try {
    const run = vi.fn((_model, _input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    }));
    const result = suggestWithModel({ run } as unknown as Ai, URL, evidence);
    const assertion = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion; expect(run).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('accepts a structured JSON-mode response and passes variant hints without sending full URLs', async () => {
  const evidence = await parseProductPage(HTML, URL);
  const { ai, run } = model();
  run.mockResolvedValue({ response: { name: 'my unnecessary mug', image: 0, price: 0 } });
  expect((await suggestWithModel(ai, URL + '&color=Blue', evidence)).name).toBe('my unnecessary mug');
  const userPrompt = JSON.parse(run.mock.calls[0][1].messages[1].content);
  expect(userPrompt.selection).toContain('color=Blue');
  expect(userPrompt.images[0].file).toBe('main.jpg');
  expect(JSON.stringify(userPrompt)).not.toContain('https://');
});
