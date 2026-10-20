#!/usr/bin/env node
import { open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PRICE_CENTS = 9_999_999_999n;
const RESERVED_SLUGS = new Set(['api', 'assets', 'webfonts', 'index.html', 'favicon.ico', 'robots.txt']);

function fail(message) {
  throw new Error(message);
}

function shape(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}: expected an object.`);
  }
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    fail(`${label}: unexpected or missing fields; use scripts/export-legacy.sql without adding account credentials.`);
  }
}

function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label}: expected a safe integer >= ${minimum}.`);
  return value;
}

function string(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && !value.trim())) {
    fail(`${label}: expected ${allowEmpty ? 'text' : 'nonempty text'} without NUL characters.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    fail(`${label}: expected a UTC timestamp from the export SQL; do not invent a missing legacy timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail(`${label}: invalid calendar timestamp.`);
  }
  return value;
}

export function priceToCents(value, label = 'price') {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    fail(`${label}: expected a nonnegative decimal string with at most two decimal places, or null. Export price::text.`);
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_PRICE_CENTS) fail(`${label}: exceeds the legacy decimal(10,2) price range.`);
  return Number(cents);
}

function safeUrl(value, label, warnings, field) {
  if (value === null || value === '') return '';
  if (typeof value !== 'string') fail(`${label}: expected text or null.`);
  try {
    if (/[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) throw new Error();
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return value;
  } catch {
    warnings[field] += 1;
    return '';
  }
}

function quote(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function insert(table, columns, values) {
  const statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.map(quote).join(', ')});`;
  if (Buffer.byteLength(statement, 'utf8') > 95_000) {
    fail(`${table} record ${values[0]}: generated statement is too large; review this record before D1 import.`);
  }
  return statement;
}

function records(value, fields, label) {
  if (!Array.isArray(value)) fail(`${label}: expected an array.`);
  const seen = new Set();
  return value.map((record, index) => {
    const context = `${label}[${index}]`;
    shape(record, fields, context);
    const id = integer(record.id, `${context}.id`);
    if (seen.has(id)) fail(`${label}: duplicate record ID ${id}.`);
    seen.add(id);
    return record;
  }).sort((left, right) => left.id - right.id);
}

/** Pure conversion. It never connects to either database and does not emit private records. */
export function compileLegacyExport(document) {
  shape(document, ['format_version', 'exported_at', 'users', 'lists', 'gifts'], 'export');
  if (document.format_version !== 1) fail('export: unsupported format_version; expected 1.');
  const exportedAt = timestamp(document.exported_at, 'export.exported_at');
  const users = records(document.users, ['id'], 'users');
  const lists = records(document.lists, ['id', 'name', 'slug', 'user', 'created_at', 'updated_at'], 'lists');
  const gifts = records(document.gifts, ['id', 'list_id', 'name', 'url', 'image', 'price', 'position', 'created_at', 'updated_at'], 'gifts');
  const owners = new Map(users.map((user) => [user.id, null]));
  const slugs = new Set();
  const listIds = new Set(lists.map((list) => list.id));
  const warnings = { clearedGiftUrls: 0, clearedImageUrls: 0 };

  for (const list of lists) {
    const label = `list ${list.id}`;
    string(list.name, `${label}.name`, true);
    string(list.slug, `${label}.slug`);
    if (!/^[a-zA-Z0-9_-]+$/.test(list.slug) || RESERVED_SLUGS.has(list.slug.toLowerCase())) {
      fail(`${label}.slug: not a supported public path, or conflicts with an application route. Plan a redirect before changing it.`);
    }
    if (slugs.has(list.slug)) fail(`${label}.slug: duplicate public slug; resolve the conflict before import.`);
    slugs.add(list.slug);
    integer(list.user, `${label}.user`);
    if (!owners.has(list.user)) fail(`${label}.user: missing legacy user ${list.user}; reconcile ownership before import.`);
    timestamp(list.created_at, `${label}.created_at`);
    timestamp(list.updated_at, `${label}.updated_at`);
    if (owners.get(list.user) === null || list.created_at < owners.get(list.user)) owners.set(list.user, list.created_at);
  }

  const statements = [
    '-- Generated offline by scripts/import-legacy.mjs. Contains private list data.',
    '-- Apply once to a freshly migrated, empty database. No sessions are imported.',
    '-- No BEGIN/COMMIT: Wrangler D1 import manages its own transaction.',
    'CREATE TABLE legacy_import_guard (empty_database INTEGER NOT NULL CHECK (empty_database = 1));',
    'INSERT INTO legacy_import_guard (empty_database) SELECT CASE WHEN EXISTS (SELECT 1 FROM owners) OR EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM lists) OR EXISTS (SELECT 1 FROM gifts) THEN 0 ELSE 1 END;',
  ];
  for (const [id, createdAt] of owners) {
    statements.push(insert('owners', ['id', 'created_at'], [`legacy-${id}`, createdAt ?? exportedAt]));
  }
  for (const list of lists) {
    statements.push(insert('lists', ['id', 'name', 'slug', 'owner_id', 'revision', 'created_at', 'updated_at'],
      [list.id, list.name, list.slug, `legacy-${list.user}`, 0, list.created_at, list.updated_at]));
  }
  for (const gift of gifts) {
    const label = `gift ${gift.id}`;
    integer(gift.list_id, `${label}.list_id`);
    if (!listIds.has(gift.list_id)) fail(`${label}.list_id: orphan gift references missing list ${gift.list_id}; reconcile it explicitly before import.`);
    string(gift.name, `${label}.name`, true);
    // Legacy acts_as_list positions are copied verbatim; descending display order remains intact.
    integer(gift.position, `${label}.position`, 0);
    timestamp(gift.created_at, `${label}.created_at`);
    timestamp(gift.updated_at, `${label}.updated_at`);
    const url = safeUrl(gift.url, `${label}.url`, warnings, 'clearedGiftUrls');
    const image = safeUrl(gift.image, `${label}.image`, warnings, 'clearedImageUrls');
    const priceCents = priceToCents(gift.price, `${label}.price`);
    statements.push(insert('gifts', ['id', 'list_id', 'name', 'url', 'image', 'price_cents', 'position', 'created_at', 'updated_at'],
      [gift.id, gift.list_id, gift.name, url, image, priceCents, gift.position, gift.created_at, gift.updated_at]));
  }
  statements.push('DROP TABLE legacy_import_guard;');
  return {
    sql: `${statements.join('\n')}\n`,
    summary: { owners: owners.size, lists: lists.length, gifts: gifts.length, ...warnings },
  };
}

export async function writeImport(inputPath, outputPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('Input is not valid JSON. Re-run the supplied export SQL; no output was written.');
    throw error;
  }
  const result = compileLegacyExport(parsed);
  const output = await open(outputPath, 'wx', 0o600);
  try {
    await output.writeFile(result.sql, 'utf8');
    await output.sync();
  } catch (error) {
    await output.close();
    await unlink(outputPath);
    throw error;
  }
  await output.close();
  return result.summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length) {
    process.stderr.write('Usage: node scripts/import-legacy.mjs INPUT.json OUTPUT.sql\n');
    process.exitCode = 1;
  } else {
    try {
      const summary = await writeImport(inputPath, outputPath);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      if (summary.clearedGiftUrls || summary.clearedImageUrls) {
        process.stderr.write('Warning: unsupported or unsafe legacy URLs were cleared; review the aggregate counts before import. Source JSON is unchanged.\n');
      }
    } catch (error) {
      process.stderr.write(`${error.code === 'EEXIST' ? 'Output already exists; refusing to overwrite it.' : error.message}\n`);
      process.exitCode = 1;
    }
  }
}
