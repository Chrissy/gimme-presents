import { env, exports as worker } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import type { ListResponse } from '../shared/api';
import { MAX_DAILY_NEW_LISTS } from '../worker/list-budget';

const ORIGIN = 'https://gimme.test';
function create(name = 'Gift list') {
  return worker.default.fetch(`${ORIGIN}/api/lists`, {
    method: 'POST', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

it('caps concurrent list creation before creating extra anonymous owners or sessions', async () => {
  const responses = await Promise.all(Array.from({ length: MAX_DAILY_NEW_LISTS + 6 }, () => create()));
  expect(responses.filter(response => response.status === 201)).toHaveLength(MAX_DAILY_NEW_LISTS);
  expect(responses.filter(response => response.status === 429)).toHaveLength(6);
  for (const table of ['lists', 'owners', 'sessions']) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(MAX_DAILY_NEW_LISTS);
  }
  const saved = responses.find(response => response.status === 201)!;
  const data = await saved.json<ListResponse>();
  const cookie = saved.headers.get('Set-Cookie')!.split(';')[0];
  const edit = await worker.default.fetch(`${ORIGIN}/api/lists/${data.list.id}`, {
    method: 'PUT', headers: { Origin: ORIGIN, 'X-Requested-With': 'gimme-presents', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Existing lists still work', revision: data.list.revision }),
  });
  expect(edit.status).toBe(200);
});

it('resets list creation allowance on the next UTC day', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare('UPDATE list_creation_budget SET day = ?, attempts = ?').bind(day, MAX_DAILY_NEW_LISTS).run();
  expect((await create()).status).toBe(429);
  await env.DB.prepare("UPDATE list_creation_budget SET day = '2000-01-01'").run();
  expect((await create()).status).toBe(201);
  expect(await env.DB.prepare('SELECT * FROM list_creation_budget').first()).toMatchObject({ day, attempts: 1 });
});

it('does not consume list allowance for invalid names and fails closed without its counter', async () => {
  expect((await create('')).status).toBe(400);
  expect(await env.DB.prepare('SELECT attempts FROM list_creation_budget').first('attempts')).toBe(0);
  await env.DB.prepare('DELETE FROM list_creation_budget').run();
  expect((await create()).status).toBe(429);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM owners').first('count')).toBe(0);
});
