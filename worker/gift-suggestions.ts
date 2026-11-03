import { HTTPException } from 'hono/http-exception';
import { verifiedSession, type AppContext } from './auth';
import { id, jsonBody } from './validation';
import { publicUrl } from './public-url';
import { hash } from './email-crypto';
import { reserveSuggestion, finishSuggestion } from './suggestion-budget';
import { fetchProductPage } from './product-page';
import { metadataDraft, suggestWithModel } from './gift-suggestion-model';
import type { GiftSuggestion } from '../shared/api';

export async function giftSuggestion(c: AppContext) {
  const owner = await verifiedSession(c);
  if (!owner) throw new HTTPException(401, { message: 'Verify your email to fill gifts from a link, or add the details manually.' });
  const listId = id(c.req.param('id'));
  const list = await c.env.DB.prepare('SELECT owner_id FROM lists WHERE id = ?').bind(listId).first<{ owner_id: string }>();
  if (!list || list.owner_id !== owner.owner_id) throw new HTTPException(403, { message: 'This browser does not have editing access to that list.' });
  if (Number(await c.env.DB.prepare('SELECT COUNT(*) FROM gifts WHERE list_id = ?').bind(listId).first('COUNT(*)')) >= 200) {
    throw new HTTPException(429, { message: 'This list already has 200 gifts. You can still edit or remove existing gifts.' });
  }
  const body = await jsonBody(c);
  const url = typeof body.url === 'string' && publicUrl(body.url.trim());
  if (!url) throw new HTTPException(400, { message: 'Use a public HTTP or HTTPS gift link.' });
  // Keep variant query parameters; fragments never participate in the page fetch.
  url.hash = '';
  const urlHash = await hash(url.href);
  const reservation = await reserveSuggestion(c.env.DB, owner.owner_id, urlHash);
  if (reservation.cached) return c.json(reservation.cached);
  let result: GiftSuggestion = { draft: { url: url.href, name: '', price: '', image: '' },
    notice: 'Couldn’t read that page. You can fill in the gift below.' };
  try {
    const evidence = await fetchProductPage(url);
    result = { draft: metadataDraft(url.href, evidence), notice: 'Check the details below and fill in anything missing.' };
    if (evidence.title && (evidence.images.length || evidence.prices.length) && c.env.AI) {
      result = { draft: await suggestWithModel(c.env.AI, url.href, evidence) };
    }
  } catch { /* Keep any metadata already found; the form remains editable. */ }
  await finishSuggestion(c.env.DB, owner.owner_id, urlHash, reservation.requestId!, result);
  return c.json(result);
}
