import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { currentOwner, newIdentity, setSessionCookie } from './auth';
import {
  conflict, findList, LIST_WRITE_GUARD, listResponse, localLists, mutateList, ownedList, ownedLists, requireGift,
} from './database';
import { badRequest, giftBody, giftIds, giftInput, id, jsonBody, name, revision } from './validation';
import { serveImage, storeImage, storeImageBytes } from './images';
import { reserveListCreation } from './list-budget';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = new URL(c.req.url);
  if (c.env.ENVIRONMENT !== 'local' && origin.protocol !== 'https:') {
    throw new HTTPException(400, { message: 'HTTPS is required.' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('Origin') !== origin.origin || c.req.header('X-Requested-With') !== 'gimme-presents') {
      throw new HTTPException(403, { message: 'This request must come from this website.' });
    }
  }
  await next();
});

app.get('/api/health', async c => {
  await c.env.DB.prepare('SELECT 1 FROM lists LIMIT 1').all();
  return c.json({ ok: true });
});

app.get('/api/me', async c => {
  const ownerId = await currentOwner(c);
  return c.json({ lists: ownerId ? await ownedLists(c.env.DB, ownerId) : [] });
});

app.get('/api/local/lists', async c => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: 'That API route could not be found.' }, 404);
  }
  return c.json({ lists: await localLists(c.env.DB) });
});

app.get('/api/lists/by-id/:id', async c => {
  const ownerId = await currentOwner(c);
  return c.json(await listResponse(c.env.DB, id(c.req.param('id')), ownerId));
});

app.get('/api/lists/:slugOrId', async c => {
  const ownerId = await currentOwner(c);
  const listId = await findList(c.env.DB, c.req.param('slugOrId'));
  return c.json(await listResponse(c.env.DB, listId, ownerId));
});

app.post('/api/lists', async c => {
  const body = await jsonBody(c);
  const listName = name(body.name, 'list');
  await reserveListCreation(c.env.DB);
  const now = new Date().toISOString();
  const existingOwner = await currentOwner(c);
  const identity = existingOwner ? null : await newIdentity(c.env.DB, now);
  const ownerId = existingOwner ?? identity!.ownerId;
  const slugBase = listName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'list';
  // A suffix avoids reserved routes, numeric-only slugs, and duplicate list names.
  const slug = `${slugBase}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const statements = [
    ...(identity?.statements ?? []),
    c.env.DB.prepare('INSERT INTO lists (name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(listName, slug, ownerId, now, now),
  ];
  const results = await c.env.DB.batch(statements);
  const listId = results[results.length - 1].meta.last_row_id;
  if (identity) setSessionCookie(c, identity.token);
  return c.json(await listResponse(c.env.DB, listId, ownerId), 201);
});

app.put('/api/lists/:id', async c => {
  const body = await jsonBody(c);
  const listName = name(body.name, 'list');
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  const now = new Date().toISOString();
  return c.json(await mutateList(c.env.DB, list, ownerId, [
    c.env.DB.prepare('UPDATE lists SET name = ? WHERE id = ? AND owner_id = ? AND revision = ?')
      .bind(listName, list.id, ownerId, list.revision),
  ], now));
});

app.delete('/api/lists/:id', async c => {
  const body = await jsonBody(c);
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  const result = await c.env.DB.prepare('DELETE FROM lists WHERE id = ? AND owner_id = ? AND revision = ?')
    .bind(list.id, ownerId, list.revision).run();
  if (result.meta.changes === 0) conflict();
  return c.json({ ok: true });
});

app.post('/api/lists/:id/gifts', async c => {
  const { body, file } = await giftBody(c);
  const gift = giftInput(body);
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  const imageKey = file ? await storeImageBytes(c.env.DB, c.env.GIFT_IMAGES, new Uint8Array(await file.arrayBuffer()))
    : await storeImage(c.env.DB, c.env.GIFT_IMAGES, gift.image);
  const now = new Date().toISOString();
  return c.json(await mutateList(c.env.DB, list, ownerId, [
    c.env.DB.prepare(`
      INSERT INTO gifts (list_id, name, url, image, image_key, price_cents, position, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) FROM gifts WHERE list_id = ?), 0) + 1, ?, ?
      WHERE ${LIST_WRITE_GUARD}
    `).bind(list.id, gift.name, gift.url, gift.image, imageKey, gift.priceCents, list.id, now, now, list.id, ownerId, list.revision),
  ], now));
});

app.put('/api/lists/:id/gifts/:giftId', async c => {
  const { body, file } = await giftBody(c);
  const gift = giftInput(body);
  const giftId = id(c.req.param('giftId'));
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  await requireGift(c.env.DB, list.id, giftId);
  const previous = await c.env.DB.prepare('SELECT image, image_key FROM gifts WHERE id = ? AND list_id = ?')
    .bind(giftId, list.id).first<{ image: string; image_key: string | null }>();
  const unchangedImage = !file && !gift.removeImage && previous && (previous.image === body.image || previous.image === gift.image);
  const imageKey = file ? await storeImageBytes(c.env.DB, c.env.GIFT_IMAGES, new Uint8Array(await file.arrayBuffer()))
    : unchangedImage ? previous.image_key : await storeImage(c.env.DB, c.env.GIFT_IMAGES, gift.image);
  if (unchangedImage) gift.image = previous.image;
  const now = new Date().toISOString();
  return c.json(await mutateList(c.env.DB, list, ownerId, [
    c.env.DB.prepare(`
      UPDATE gifts SET name = ?, url = ?, image = ?, image_key = ?, price_cents = ?, updated_at = ?
      WHERE id = ? AND list_id = ? AND ${LIST_WRITE_GUARD}
    `).bind(gift.name, gift.url, gift.image, imageKey, gift.priceCents, now, giftId, list.id, list.id, ownerId, list.revision),
  ], now));
});

app.delete('/api/lists/:id/gifts/:giftId', async c => {
  const body = await jsonBody(c);
  const giftId = id(c.req.param('giftId'));
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  await requireGift(c.env.DB, list.id, giftId);
  const now = new Date().toISOString();
  return c.json(await mutateList(c.env.DB, list, ownerId, [
    c.env.DB.prepare(`DELETE FROM gifts WHERE id = ? AND list_id = ? AND ${LIST_WRITE_GUARD}`)
      .bind(giftId, list.id, list.id, ownerId, list.revision),
  ], now));
});

app.post('/api/lists/:id/reorder', async c => {
  const body = await jsonBody(c);
  const order = giftIds(body.giftIds);
  const { list, ownerId } = await ownedList(c, id(c.req.param('id')), revision(body.revision));
  const existing = await c.env.DB.prepare('SELECT id FROM gifts WHERE list_id = ?').bind(list.id).all<{ id: number }>();
  const ids = new Set(order);
  if (existing.results.length !== order.length || existing.results.some(gift => !ids.has(gift.id))) {
    return badRequest('The order must contain every gift in this list exactly once.');
  }
  const now = new Date().toISOString();
  // json_each keeps the query bounded to a handful of parameters for long lists.
  return c.json(await mutateList(c.env.DB, list, ownerId, [
    c.env.DB.prepare(`
      UPDATE gifts SET position = (
        SELECT ? - CAST(key AS INTEGER) FROM json_each(?) WHERE CAST(value AS INTEGER) = gifts.id
      ), updated_at = ? WHERE list_id = ? AND ${LIST_WRITE_GUARD}
    `).bind(order.length, JSON.stringify(order), now, list.id, list.id, ownerId, list.revision),
  ], now));
});

app.all('/api', c => c.json({ error: 'That API route could not be found.' }, 404));
app.all('/api/*', c => c.json({ error: 'That API route could not be found.' }, 404));
app.on(['GET', 'HEAD'], '/media/:key', serveImage);
app.all('/media/*', c => c.text('Image not found.', 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  // Do not log cookies, request bodies, names, or URLs supplied by list owners.
  console.error(JSON.stringify({ event: 'api_error', name: error.name, message: 'An unexpected request error occurred.' }));
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

export default app;
