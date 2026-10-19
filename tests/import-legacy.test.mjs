import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compileLegacyExport, priceToCents, writeImport } from '../scripts/import-legacy.mjs';

const date = '2020-11-26T02:27:03.123456Z';
const schema = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');

function fixture() {
  return {
    format_version: 1,
    exported_at: '2026-10-19T00:00:00.000000Z',
    users: [{ id: 7 }, { id: 4 }],
    lists: [
      { id: 9, name: "Chrissy's 🎁 list\nA second line", slug: 'christmas-list', user: 7, created_at: date, updated_at: date },
      { id: 20, name: 'Numeric public URL', slug: '123', user: 4, created_at: date, updated_at: date },
    ],
    gifts: [
      { id: 23, list_id: 9, name: "'); DROP TABLE lists; --\n✨", url: "https://example.test/gift?q=O'Reilly", image: 'https://example.test/image.png', price: '0.29', position: 1, created_at: date, updated_at: date },
      { id: 15, list_id: 9, name: 'Most wanted', url: '', image: null, price: '99999999.99', position: 8, created_at: date, updated_at: date },
    ],
  };
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return db;
}

test('imports exact text, IDs, ownership, numeric slugs, timestamps, prices and descending order', () => {
  const source = fixture();
  const original = JSON.stringify(source);
  const { sql, summary } = compileLegacyExport(source);
  const db = database();
  try {
    db.exec(sql);
    assert.equal(JSON.stringify(source), original, 'conversion must not mutate the source');
    assert.deepEqual(summary, { owners: 2, lists: 2, gifts: 2, clearedGiftUrls: 0, clearedImageUrls: 0 });
    const list = db.prepare('SELECT * FROM lists WHERE id = 9').get();
    assert.equal(list.name, source.lists[0].name);
    assert.equal(list.owner_id, 'legacy-7');
    assert.equal(list.created_at, date);
    assert.equal(list.updated_at, date);
    assert.equal(list.revision, 0);
    assert.equal(db.prepare('SELECT slug FROM lists WHERE id = 20').get().slug, '123');
    const gifts = db.prepare('SELECT * FROM gifts WHERE list_id = 9 ORDER BY position DESC, id DESC').all();
    assert.deepEqual(gifts.map((gift) => gift.id), [15, 23]);
    assert.equal(gifts[0].price_cents, 9_999_999_999);
    assert.equal(gifts[1].price_cents, 29);
    assert.equal(gifts[1].name, source.gifts[0].name);
    assert.equal(gifts[1].url, source.gifts[0].url);
    assert.equal(gifts[1].created_at, date);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // Explicit imported IDs must also advance SQLite's next generated IDs.
    db.exec(`INSERT INTO lists (name, slug, owner_id, created_at, updated_at) VALUES ('Next', 'next', 'legacy-7', '${date}', '${date}')`);
    assert.equal(db.prepare("SELECT id FROM lists WHERE slug = 'next'").get().id, 21);
  } finally {
    db.close();
  }
});

test('emits deterministic SQL even when input arrays have different ordering', () => {
  const first = fixture();
  const second = fixture();
  second.users.reverse();
  second.lists.reverse();
  second.gifts.reverse();
  assert.deepEqual(compileLegacyExport(first), compileLegacyExport(second));
});

test('converts decimal strings exactly and rejects ambiguous or invalid prices', () => {
  for (const [value, expected] of [[null, null], ['0', 0], ['0.01', 1], ['0.29', 29], ['1.1', 110], ['19.99', 1999], ['99999999.99', 9_999_999_999]]) {
    assert.equal(priceToCents(value), expected);
  }
  for (const value of [0.29, '', 'NaN', 'Infinity', '1e3', '-1.00', '1.001', ' 1.00', '01.00', '100000000.00']) {
    assert.throws(() => priceToCents(value));
  }
});

test('clears unsafe URLs with count-only warnings and keeps valid original URLs', () => {
  const source = fixture();
  source.gifts[0].url = 'javascript:alert(1)';
  source.gifts[0].image = 'data:image/svg+xml,private';
  source.gifts[1].url = 'https://user:password@example.test/private';
  source.gifts[1].image = 'https://example.test/\nimage.png';
  const { sql, summary } = compileLegacyExport(source);
  assert.equal(summary.clearedGiftUrls, 2);
  assert.equal(summary.clearedImageUrls, 2);
  assert.ok(!sql.includes('javascript:'));
  assert.ok(!sql.includes('password'));
  const db = database();
  try {
    db.exec(sql);
    assert.ok(db.prepare('SELECT url, image FROM gifts').all().every((row) => row.url === '' && row.image === ''));
  } finally {
    db.close();
  }
});

test('refuses broken ownership, orphan gifts, duplicate IDs/slugs and malformed mandatory data', () => {
  const cases = [
    [(data) => { data.lists[0].user = 99; }, /list 9.user: missing legacy user 99/],
    [(data) => { data.gifts[0].list_id = 99; }, /gift 23.list_id: orphan gift/],
    [(data) => { data.gifts[0].list_id = null; }, /gift 23.list_id/],
    [(data) => { data.users.push({ id: 7 }); }, /duplicate record ID 7/],
    [(data) => { data.lists[1].slug = data.lists[0].slug; }, /duplicate public slug/],
    [(data) => { data.lists[0].slug = 'api'; }, /list 9.slug/],
    [(data) => { data.lists[0].slug = '../private'; }, /list 9.slug/],
    [(data) => { data.lists[0].id = Number.MAX_SAFE_INTEGER + 1; }, /safe integer/],
    [(data) => { data.lists[0].created_at = null; }, /list 9.created_at/],
    [(data) => { data.lists[0].created_at = '2026-02-30T00:00:00Z'; }, /invalid calendar timestamp/],
    [(data) => { data.gifts[0].position = null; }, /gift 23.position/],
    [(data) => { data.gifts[0].name = null; }, /gift 23.name/],
    [(data) => { data.gifts[0].name = 'a\0b'; }, /NUL/],
    [(data) => { data.users[0].password = 'not-for-export'; }, /unexpected or missing fields/],
    [(data) => { data.format_version = 2; }, /unsupported format_version/],
  ];
  for (const [change, expected] of cases) {
    const data = fixture();
    change(data);
    assert.throws(() => compileLegacyExport(data), expected);
  }
});

test('SQL refuses an occupied destination before inserting any legacy records', () => {
  const db = database();
  try {
    db.exec(`INSERT INTO owners (id, created_at) VALUES ('existing-owner', '${date}')`);
    assert.throws(() => db.exec(compileLegacyExport(fixture()).sql), /CHECK constraint failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lists').get().n, 0);
  } finally {
    db.close();
  }
});

test('writes a private file, refuses overwrite, and creates no output for invalid input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gimme-import-test-'));
  const input = join(directory, 'source.json');
  const output = join(directory, 'import.sql');
  try {
    await writeFile(input, JSON.stringify(fixture()), { mode: 0o600 });
    const summary = await writeImport(input, output);
    assert.equal(summary.gifts, 2);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    const original = await readFile(output, 'utf8');
    await assert.rejects(writeImport(input, output), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), original);
    await writeFile(input, '{"private": "unfinished');
    const invalidOutput = join(directory, 'invalid.sql');
    await assert.rejects(writeImport(input, invalidOutput), /Input is not valid JSON/);
    await assert.rejects(stat(invalidOutput), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI prints counts without leaking records or malformed JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gimme-import-cli-test-'));
  const input = join(directory, 'source.json');
  const output = join(directory, 'import.sql');
  const cli = new URL('../scripts/import-legacy.mjs', import.meta.url);
  try {
    await writeFile(input, JSON.stringify(fixture()), { mode: 0o600 });
    const success = spawnSync(process.execPath, [cli.pathname, input, output], { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).lists, 2);
    assert.ok(!`${success.stdout}${success.stderr}`.includes('Chrissy'));
    await writeFile(input, '{"private-record-do-not-log":');
    const failure = spawnSync(process.execPath, [cli.pathname, input, join(directory, 'bad.sql')], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.ok(!`${failure.stdout}${failure.stderr}`.includes('private-record-do-not-log'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export helper backs up before snapshotting and refuses reused directories (mock clients, no database)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gimme-export-test-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.log');
  const destination = join(directory, 'backup');
  const helper = new URL('../scripts/export-legacy.sh', import.meta.url);
  try {
    await mkdir(bin);
    const mockClient = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const name = basename(process.argv[1]);
appendFileSync(process.env.GIMME_EXPORT_LOG, name + '\\n');
if (process.env.GIMME_FAIL_EXPORT === name) process.exit(2);
if (name === 'pg_dump') writeFileSync(process.argv.find((arg) => arg.startsWith('--file=')).slice(7), 'mock custom backup');
if (name === 'psql') process.stdout.write('{}\\n');
`;
    for (const name of ['pg_dump', 'pg_restore', 'psql']) {
      await writeFile(join(bin, name), mockClient, { mode: 0o700 });
    }
    // Make extensionless mock clients ESM regardless of Node's default syntax detection.
    await writeFile(join(bin, 'package.json'), '{"type":"module"}');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIMME_EXPORT_LOG: log };
    const success = spawnSync('sh', [helper.pathname, destination], { encoding: 'utf8', env });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(await readFile(log, 'utf8'), 'pg_dump\npg_restore\npsql\n');
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal((await stat(join(destination, 'legacy-backup.dump'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(destination, 'legacy-export.json'))).mode & 0o777, 0o600);
    const repeat = spawnSync('sh', [helper.pathname, destination], { encoding: 'utf8', env });
    assert.notEqual(repeat.status, 0);
    assert.equal(await readFile(log, 'utf8'), 'pg_dump\npg_restore\npsql\n');
    const failedDestination = join(directory, 'failed-backup');
    const failure = spawnSync('sh', [helper.pathname, failedDestination], {
      encoding: 'utf8', env: { ...env, GIMME_FAIL_EXPORT: 'pg_dump' },
    });
    assert.notEqual(failure.status, 0);
    assert.equal(await readFile(log, 'utf8'), 'pg_dump\npg_restore\npsql\npg_dump\n');
    await assert.rejects(stat(join(failedDestination, 'legacy-export.json')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
