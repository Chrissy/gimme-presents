import { HTTPException } from 'hono/http-exception';

export const OWNER_DAILY_LISTS = 10;
export const GLOBAL_DAILY_LISTS = 30;
export const OWNER_DAILY_UPLOADS = 50;
export const GLOBAL_DAILY_UPLOADS = 300;
export const OWNER_DAILY_BYTES = 125_000_000;
export const GLOBAL_DAILY_BYTES = 750_000_000;
export const OWNER_STORED_BYTES = 500_000_000;
export const GLOBAL_STORED_BYTES = 5_000_000_000;
export const GLOBAL_DAILY_READS = 10_000;

export function assertChanged(db: D1Database): D1PreparedStatement[] {
  return [db.prepare('INSERT INTO quota_assertion (ok) VALUES (changes())'),
    db.prepare('DELETE FROM quota_assertion')];
}

export async function quotaBatch(db: D1Database, statements: D1PreparedStatement[], message: string) {
  try { return await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && /CHECK constraint failed: ok = 1|list_capacity|gift_capacity/.test(error.message)) {
      throw new HTTPException(429, { message });
    }
    throw error;
  }
}

/** These statements can be included in the same batch as a verified list creation. */
export function listReservations(db: D1Database, ownerId: string, day: string): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE owner_usage SET list_day = ?, lists = CASE WHEN list_day = ? THEN lists + 1 ELSE 1 END
      WHERE owner_id = ? AND (list_day <> ? OR lists < ?)`)
      .bind(day, day, ownerId, day, OWNER_DAILY_LISTS), ...assertChanged(db),
    db.prepare(`UPDATE list_creation_budget SET day = ?, attempts = CASE WHEN day = ? THEN attempts + 1 ELSE 1 END
      WHERE id = 1 AND (day <> ? OR attempts < ?)`)
      .bind(day, day, day, GLOBAL_DAILY_LISTS), ...assertChanged(db),
  ];
}

export async function reserveOwnerImage(db: D1Database, ownerId: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid image reservation');
  const day = new Date().toISOString().slice(0, 10);
  const update = (table: string, key: string, uploads: number, daily: number, stored: number) =>
    db.prepare(`UPDATE ${table} SET reserved_bytes = reserved_bytes + ?, upload_day = ?,
      uploads = CASE WHEN upload_day = ? THEN uploads + 1 ELSE 1 END,
      upload_bytes = (CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END) + ?
      WHERE ${key} AND reserved_bytes + ? <= ? AND (upload_day <> ? OR uploads < ?)
      AND (CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END) + ? <= ?`);
  await quotaBatch(db, [
    update('owner_usage', 'owner_id = ?', OWNER_DAILY_UPLOADS, OWNER_DAILY_BYTES, OWNER_STORED_BYTES)
      .bind(bytes, day, day, day, bytes, ownerId, bytes, OWNER_STORED_BYTES, day, OWNER_DAILY_UPLOADS, day, bytes, OWNER_DAILY_BYTES),
    ...assertChanged(db),
    update('image_budget', 'id = 1 AND enabled = 1', GLOBAL_DAILY_UPLOADS, GLOBAL_DAILY_BYTES, GLOBAL_STORED_BYTES)
      .bind(bytes, day, day, day, bytes, bytes, GLOBAL_STORED_BYTES, day, GLOBAL_DAILY_UPLOADS, day, bytes, GLOBAL_DAILY_BYTES),
    ...assertChanged(db),
  ], 'Image uploads have reached a usage limit. Daily allowances reset at midnight UTC; existing lists remain editable.');
}
