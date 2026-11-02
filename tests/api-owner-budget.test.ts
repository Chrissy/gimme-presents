import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { listReservations, quotaBatch, reserveOwnerImage, OWNER_DAILY_UPLOADS } from '../worker/owner-budget';

async function owner(id: string) {
  await env.DB.prepare('INSERT INTO owners (id, created_at) VALUES (?, ?)').bind(id, new Date().toISOString()).run();
}

it('reserves one last owner upload atomically without spending other owners allowances', async () => {
  await owner('one'); await owner('two');
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare('UPDATE owner_usage SET upload_day = ?, uploads = ? WHERE owner_id = ?')
    .bind(day, OWNER_DAILY_UPLOADS - 1, 'one').run();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserveOwnerImage(env.DB, 'one', 100)));
  expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await reserveOwnerImage(env.DB, 'two', 100);
  expect(await env.DB.prepare('SELECT uploads FROM image_budget').first('uploads')).toBe(2);
});

it('rolls back an owner reservation when the global allowance is exhausted', async () => {
  await owner('one');
  await env.DB.prepare('UPDATE image_budget SET reserved_bytes = 5000000000').run();
  await expect(reserveOwnerImage(env.DB, 'one', 100)).rejects.toMatchObject({ status: 429 });
  expect(await env.DB.prepare('SELECT reserved_bytes FROM owner_usage').first('reserved_bytes')).toBe(0);
});

it('allows three owners ten list reservations each, including concurrent calls', async () => {
  const day = new Date().toISOString().slice(0, 10);
  for (const id of ['one', 'two', 'three']) await owner(id);
  for (const id of ['one', 'two', 'three']) {
    const results = await Promise.allSettled(Array.from({ length: 11 }, () =>
      quotaBatch(env.DB, listReservations(env.DB, id, day), 'Limit')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
  }
  expect(await env.DB.prepare('SELECT attempts FROM list_creation_budget').first('attempts')).toBe(30);
});

it('resets daily owner usage while retaining lifetime reservations', async () => {
  await owner('one');
  await env.DB.prepare("UPDATE owner_usage SET upload_day = '2000-01-01', uploads = 50, upload_bytes = 125000000, reserved_bytes = 100").run();
  await reserveOwnerImage(env.DB, 'one', 25);
  expect(await env.DB.prepare('SELECT * FROM owner_usage').first()).toMatchObject({ uploads: 1, upload_bytes: 25, reserved_bytes: 125 });
});
