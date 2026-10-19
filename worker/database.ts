import { HTTPException } from 'hono/http-exception';
import type { Gift, ListResponse, ListSummary } from '../shared/api';
import { currentOwner, type AppContext } from './auth';

export interface ListRow {
  id: number;
  name: string;
  slug: string;
  owner_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const LIST_COLUMNS = 'id, name, slug, owner_id, revision, created_at, updated_at';
const GIFT_COLUMNS = 'id, name, url, image, price_cents AS priceCents, position';

export function listSummary(row: ListRow): ListSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotStatements(db: D1Database, listId: number): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ?`).bind(listId),
    db.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE list_id = ? ORDER BY position DESC, id DESC`)
      .bind(listId),
  ];
}

function snapshotResponse(
  listResult: D1Result<ListRow>, giftResult: D1Result<Gift>, ownerId: string | null,
): ListResponse {
  const list = listResult.results[0];
  if (!list) throw new HTTPException(404, { message: 'That list could not be found.' });
  return { list: listSummary(list), gifts: giftResult.results, canEdit: list.owner_id === ownerId };
}

export async function listResponse(db: D1Database, listId: number, ownerId: string | null): Promise<ListResponse> {
  // A batch gives the list revision and its gifts from the same database snapshot.
  const results = await db.batch(snapshotStatements(db, listId));
  return snapshotResponse(results[0] as D1Result<ListRow>, results[1] as D1Result<Gift>, ownerId);
}

export async function findList(db: D1Database, slugOrId: string): Promise<number> {
  const numericId = /^[1-9]\d*$/.test(slugOrId) && Number.isSafeInteger(Number(slugOrId))
    ? Number(slugOrId) : -1;
  // Exact slugs win, including an old list whose slug happens to be numeric.
  const row = await db.prepare(
    'SELECT id FROM lists WHERE slug = ? OR id = ? ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END LIMIT 1',
  ).bind(slugOrId, numericId, slugOrId).first<{ id: number }>();
  if (!row) throw new HTTPException(404, { message: 'That list could not be found.' });
  return row.id;
}

export function conflict(): never {
  throw new HTTPException(409, { message: 'This list changed in another window. Reload it before saving again.' });
}

export async function ownedList(c: AppContext, listId: number, expectedRevision: number) {
  const ownerId = await currentOwner(c);
  if (!ownerId) throw new HTTPException(403, { message: 'This browser does not have editing access to that list.' });
  const row = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ?`)
    .bind(listId).first<ListRow>();
  if (!row) throw new HTTPException(404, { message: 'That list could not be found.' });
  if (row.owner_id !== ownerId) {
    throw new HTTPException(403, { message: 'This browser does not have editing access to that list.' });
  }
  if (row.revision !== expectedRevision) conflict();
  return { list: row, ownerId };
}

export async function requireGift(db: D1Database, listId: number, giftId: number): Promise<void> {
  const row = await db.prepare('SELECT id FROM gifts WHERE id = ? AND list_id = ?')
    .bind(giftId, listId).first();
  if (!row) throw new HTTPException(404, { message: 'That gift could not be found in this list.' });
}

/** Each write must have this guard. The revision advances last within the atomic batch. */
export const LIST_WRITE_GUARD = 'EXISTS (SELECT 1 FROM lists WHERE id = ? AND owner_id = ? AND revision = ?)';

export async function mutateList(
  db: D1Database,
  list: ListRow,
  ownerId: string,
  statements: D1PreparedStatement[],
  now: string,
): Promise<ListResponse> {
  const results = await db.batch([
    ...statements,
    db.prepare('UPDATE lists SET revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?')
      .bind(now, list.id, ownerId, list.revision),
    ...snapshotStatements(db, list.id),
  ]);
  if (results[statements.length].meta.changes !== 1) conflict();
  return snapshotResponse(
    results[statements.length + 1] as D1Result<ListRow>,
    results[statements.length + 2] as D1Result<Gift>,
    ownerId,
  );
}

export async function ownedLists(db: D1Database, ownerId: string): Promise<ListSummary[]> {
  const result = await db.prepare(`SELECT ${LIST_COLUMNS} FROM lists WHERE owner_id = ? ORDER BY updated_at DESC, id DESC`)
    .bind(ownerId).all<ListRow>();
  return result.results.map(listSummary);
}
