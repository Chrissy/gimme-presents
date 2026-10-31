import { HTTPException } from 'hono/http-exception';

export const MAX_STORED_IMAGE_BYTES = 5_000_000_000;
export const MAX_DAILY_UPLOADS = 100;
export const MAX_DAILY_UPLOAD_BYTES = 250_000_000;
export const MAX_DAILY_IMAGE_READS = 1_000;

/** One atomic conditional update serializes reservations across requests/isolates.
 * Missing tables/rows and database failures must prevent the R2 operation.
 * Reservations are deliberately never refunded, even after an uncertain failure.
 */
export async function reserveImageUpload(db: D1Database, bytes: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.prepare(`
    UPDATE image_budget SET reserved_bytes = reserved_bytes + ?, upload_day = ?,
      uploads = CASE WHEN upload_day = ? THEN uploads + 1 ELSE 1 END,
      upload_bytes = (CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END) + ?
    WHERE id = 1 AND enabled = 1 AND reserved_bytes + ? <= ? AND (upload_day <> ? OR uploads < ?)
      AND (CASE WHEN upload_day = ? THEN upload_bytes ELSE 0 END) + ? <= ?
  `).bind(bytes, day, day, day, bytes, bytes, MAX_STORED_IMAGE_BYTES, day, MAX_DAILY_UPLOADS, day, bytes, MAX_DAILY_UPLOAD_BYTES).run();
  if (result.meta.changes !== 1) {
    throw new HTTPException(429, { message: 'Image uploads are paused to keep hosting within its usage limits.' });
  }
}

export async function reserveImageRead(db: D1Database): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.prepare(`
    UPDATE image_budget SET read_day = ?, reads = CASE WHEN read_day = ? THEN reads + 1 ELSE 1 END
    WHERE id = 1 AND enabled = 1 AND (read_day <> ? OR reads < ?)
  `).bind(day, day, day, MAX_DAILY_IMAGE_READS).run();
  return result.meta.changes === 1;
}
