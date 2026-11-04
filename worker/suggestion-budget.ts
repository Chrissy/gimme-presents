import { HTTPException } from 'hono/http-exception';
import { assertChanged, quotaBatch } from './owner-budget';
import type { GiftSuggestion } from '../shared/api';

export const OWNER_DAILY_SUGGESTIONS = 50;
export const GLOBAL_DAILY_SUGGESTIONS = 300;
const ALLOWANCE_MESSAGE = 'Gift suggestions have reached a usage limit. Daily allowances reset at midnight UTC; you can still add gifts manually.';

export async function reserveSuggestion(db: D1Database, ownerId: string, urlHash: string) {
  const now = Math.floor(Date.now() / 1000);
  const day = new Date().toISOString().slice(0, 10);
  const previous = await db.prepare('SELECT result FROM gift_suggestions WHERE owner_id = ? AND url_hash = ? AND expires_at > ?')
    .bind(ownerId, urlHash, now).first<{ result: string | null }>();
  if (previous) {
    if (previous.result) return { cached: JSON.parse(previous.result) as GiftSuggestion, requestId: null };
    throw new HTTPException(409, { message: 'That link is already being checked. You can fill in the gift manually.' });
  }
  const requestId = crypto.randomUUID();
  await quotaBatch(db, [
    db.prepare(`UPDATE owner_usage SET suggestion_day = ?, suggestions = CASE WHEN suggestion_day = ? THEN suggestions + 1 ELSE 1 END,
      suggestion_lease = ?, suggestion_until = ? WHERE owner_id = ? AND suggestion_until <= ?
      AND (suggestion_day <> ? OR suggestions < ?)`)
      .bind(day, day, requestId, now + 90, ownerId, now, day, OWNER_DAILY_SUGGESTIONS), ...assertChanged(db),
    db.prepare(`UPDATE suggestion_budget SET day = ?, attempts = CASE WHEN day = ? THEN attempts + 1 ELSE 1 END
      WHERE id = 1 AND enabled = 1 AND (day <> ? OR attempts < ?)`)
      .bind(day, day, day, GLOBAL_DAILY_SUGGESTIONS), ...assertChanged(db),
    db.prepare(`INSERT INTO gift_suggestions (owner_id, url_hash, request_id, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, url_hash) DO UPDATE SET request_id = excluded.request_id, result = NULL, expires_at = excluded.expires_at
      WHERE gift_suggestions.expires_at <= ?`).bind(ownerId, urlHash, requestId, now + 600, now), ...assertChanged(db),
  ], ALLOWANCE_MESSAGE);
  return { cached: null, requestId };
}

export async function finishSuggestion(db: D1Database, ownerId: string, urlHash: string, requestId: string, result: GiftSuggestion) {
  await db.batch([
    db.prepare('UPDATE gift_suggestions SET result = ? WHERE owner_id = ? AND url_hash = ? AND request_id = ?')
      .bind(JSON.stringify(result), ownerId, urlHash, requestId),
    db.prepare('UPDATE owner_usage SET suggestion_until = 0, suggestion_lease = NULL WHERE owner_id = ? AND suggestion_lease = ?')
      .bind(ownerId, requestId),
  ]);
}

export async function cleanSuggestions(db: D1Database) {
  await db.prepare('DELETE FROM gift_suggestions WHERE expires_at <= ?').bind(Math.floor(Date.now() / 1000)).run();
}
