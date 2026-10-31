import { HTTPException } from 'hono/http-exception';

export const MAX_DAILY_NEW_LISTS = 10;

/** Reserve before creating an anonymous owner, session, or list. */
export async function reserveListCreation(db: D1Database): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.prepare(`
    UPDATE list_creation_budget SET day = ?, attempts = CASE WHEN day = ? THEN attempts + 1 ELSE 1 END
    WHERE id = 1 AND (day <> ? OR attempts < ?)
  `).bind(day, day, day, MAX_DAILY_NEW_LISTS).run();
  if (result.meta.changes !== 1) {
    throw new HTTPException(429, { message: 'New lists are paused for today because the daily limit has been reached. Please try again tomorrow.' });
  }
}
