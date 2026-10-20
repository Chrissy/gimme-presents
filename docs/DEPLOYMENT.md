# Deployment and recovery

## Current workers.dev release

The app was deployed on **2026-10-20** to [gimme-presents.fivefourths.workers.dev](https://gimme-presents.fivefourths.workers.dev), using the reviewed August 15, 2026 backup. The old Rails site is offline; this release restores the supplied snapshot. A fresh Rails export or write freeze is not a prerequisite for this completed release.

| Item | Released state |
| --- | --- |
| Worker | `gimme-presents` |
| Worker version | `783e5120-8e91-42c2-9f2f-ee876a1deb1a` |
| Deployment readback | 100% of traffic on that version; author `fivefourths@gmail.com` |
| Cloudflare account | Personal account for `fivefourths@gmail.com` |
| Account ID | `6fcfd050639f1bcffd6534443c89e0e5` |
| Saved Wrangler profile | `pp-diaper`, activated for this repository |
| D1 database | `gimme-presents-production` |
| D1 UUID | `03721551-2659-4493-a792-b85360cae0c2` |
| Applied schema | `0001_initial.sql` |
| Remote import readback, before smoke tests | 91 owners, 135 lists, 848 gifts, 0 sessions; no foreign-key violations |
| Remote readback after smoke tests | 135 lists, 848 gifts, 91 legacy owners; no foreign-key violations |
| Live smoke verification | Passed on workers.dev; imported-list browser rendering, anonymous ownership, edits, and cleanup verified |
| Main domain | Unchanged; connecting it is deferred until separately requested |

The production account ID and database UUID are pinned in `wrangler.jsonc`; the default local D1 binding remains isolated. The existing database is populated. **Do not rerun the initial legacy import or create another production database for an ordinary update.**

## Updating the deployed app

Use Node.js 24 and the reviewed source. Verify that Wrangler is using the personal account before deployment. This repository uses the existing `pp-diaper` auth profile; the global default used during initial development was a work account and must not be used for this project.

```sh
npx wrangler whoami
npm ci
npm run deploy
```

Confirm the `whoami` result is the intended personal identity/account before running the remaining commands. `npm run deploy` builds with `CLOUDFLARE_ENV=production` and deploys with `--env production`. It updates the Worker and assets; it does not replay the data import or apply new D1 migrations. Review and back up the database before any separately planned schema/data change.

Keep the release on workers.dev. Do not add routes, Custom Domains, or DNS changes as part of these updates. D1 management commands below explicitly use `--config wrangler.jsonc`, so a prior Vite build cannot redirect them to generated configuration. Deployment deliberately uses the generated production build.

## Remote data readback

For read-only queries on remote D1, use `--command`. Remote `d1 execute --file` takes the file-import path and did not return the `SELECT` rows during this deployment; it is not the correct readback command here.

```sh
npx wrangler d1 execute DB --env production --remote --config wrangler.jsonc --command "SELECT (SELECT COUNT(*) FROM owners) AS owners, (SELECT COUNT(*) FROM lists) AS lists, (SELECT COUNT(*) FROM gifts) AS gifts, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM lists LEFT JOIN owners ON owners.id = lists.owner_id WHERE owners.id IS NULL) AS lists_without_owner, (SELECT COUNT(*) FROM gifts LEFT JOIN lists ON lists.id = gifts.list_id WHERE lists.id IS NULL) AS gifts_without_list;"
npx wrangler d1 execute DB --env production --remote --config wrangler.jsonc --command "PRAGMA foreign_key_check;"
```

The import baseline is 91 owners, 135 lists, 848 gifts, and zero sessions. New usage and smoke tests can add owners/sessions, so that baseline is historical rather than an invariant. Both missing-reference counts should be zero, and `foreign_key_check` should return no violations. These queries expose counts/integrity results rather than list contents.

## Live smoke checks

The following checks passed on the deployed workers.dev site:

- `/api/health` returned success, and `/api/local/lists` returned 404 in production.
- An imported slug and its numeric link returned view-only access and the exact expected gift order. The imported list rendered in the browser with fonts, images, 11 gifts, and no edit forms.
- A disposable list was created, renamed, reloaded, and deleted. Two gifts were added, a price read back as 29 cents, and their order was changed and verified. The deleted list returned 404.
- Cookie ownership and `/api/me` were verified through live API requests; an unauthenticated edit attempt returned 403.
- The ownership cookie was Secure, HttpOnly, SameSite=Lax, and host-only.

Only disposable records were used for mutation checks. After cleanup, remote readback confirmed 135 lists, 848 gifts, and all 91 legacy owners, with no foreign-key violations. A test owner/session may remain after deleting its list. These results verify the workers.dev release, not a future main domain.

## Ownership and the future main domain

Imported lists retain their public slugs and owner relationships, but legacy Rails sessions and Google credentials are not imported. There is no ownership-claim endpoint or email recovery in this version. Imported lists are view-only on the new site; new lists belong to the browser that creates them. New sessions have a rolling 180-day lifetime, renewed on use at most once per day. Lost, cleared, or expired cookies remain unrecoverable.

**The main domain must remain unchanged until a later request.** Before that future move, decide how to handle editing access for legacy owners and for lists created on workers.dev. Cookies are host-only and will not transfer to a custom domain automatically. A workers.dev smoke test also cannot verify routing or cookies on a future hostname. Do not grant ownership based solely on a public slug or an unverified email address.

Email recovery and draggable/resizable image layouts remain future work. No Google auth, email service, or R2 bucket is required for the current release.

## Backups and rollback

The original PostgreSQL archive and the reviewed reconciliation artifacts remain recovery sources. The running Worker now accepts new writes in D1, so the August archive is no longer a complete backup of current activity. Before a future data/schema change, export D1 to a new file in a private directory:

```sh
umask 077
npx wrangler d1 export DB --env production --remote --config wrangler.jsonc --output /absolute/private/location/new-d1-backup.sql
```

Use a new filename and retain the export privately. A Worker code rollback does not roll back D1 data/schema. Restoring the August archive would discard newer lists and sessions unless they are reconciled first. There is no reverse migration or automatic dual-write system, and the old Rails site is not a running rollback target. Stop writes and back up D1 before any recovery that could replace its data.

After this release and smoke cleanup, a remote D1 export was saved to the ignored private file `data/workers-dev-release-2026-10-20/d1-after-release.sql`. No restore was performed. Keep that data file out of Git.

## Archive: recovering data into a separate environment

The remaining instructions preserve the offline recovery workflow. They are **not outstanding steps for the deployed app**. Another rehearsal or fresh source export is unnecessary for this completed release. If a future recovery uses a running PostgreSQL source, stop its writes during the final backup/export so both snapshots describe the same state.

Use an isolated local state directory or a newly provisioned recovery database with a separate, explicit Wrangler configuration. Apply migrations/import SQL only to that empty recovery target. Never repoint the current production binding or replay legacy SQL into the populated live database as part of an ordinary deployment.

### Prepare recovery tools

For a future restore, use Node.js 24, npm, and PostgreSQL clients compatible with the source server (`pg_dump`, `pg_restore`, and `psql`). Check out the reviewed PR commit/branch. The branch for this change is `codex/cloudflare-react-port`:

```sh
git fetch origin
git switch codex/cloudflare-react-port
npm ci
npm run typecheck
npm test
npm run build
```

D1 commands below explicitly use `--config wrangler.jsonc` so a prior Vite build cannot redirect them to generated deployment configuration. `npm run deploy` deliberately uses that generated production build instead.

The app can be tried locally with `npm run db:migrate:local` and `npm run dev`. Local D1 and production D1 are separate. Never use `--remote` for a rehearsal.

### Back up PostgreSQL, then capture the minimal export

Configure the PostgreSQL connection through a libpq service (`PGSERVICE` with a private `.pg_service.conf` and `.pgpass`) or existing `PGHOST`, `PGPORT`, `PGDATABASE`, and `PGUSER` environment settings. Keep password files mode `0600`; do not put database URLs/passwords in command arguments, shell history, this repository, or this document. Use a database role that can read all application rows. The exporter does not prompt for a password.

Pick a new absolute directory outside the repository; its parent directory must already exist. The helper refuses an existing output directory, creates it with mode `0700`, and creates private files with mode `0600`:

```sh
export PGSERVICE=gimme-presents-legacy
gimme_backup_dir=/absolute/private/location/gimme-presents-final
sh scripts/export-legacy.sh "$gimme_backup_dir"
```

The helper runs these operations in order:

1. `pg_dump --format=custom` produces `legacy-backup.dump`, a full recovery backup. It contains sensitive legacy account fields; keep it private and retain it through cutover. A readable archive listing is checked with `pg_restore --list`; an isolated restore rehearsal is still recommended before retiring PostgreSQL.
2. `psql --single-transaction` runs `scripts/export-legacy.sql` with a repeatable-read, read-only transaction and writes `legacy-export.json`. All three tables come from one consistent snapshot. The backup and JSON use separate snapshots, so only a write freeze makes their source state identical.

The JSON contains user IDs, list records, and gift records only. It omits emails, Google provider identifiers, passwords, and session material. Prices are exported as decimal strings, and Rails timestamps are treated as UTC. The command exits on failure; do not use incomplete files. Retain a successful backup even if a later export step fails, and rerun into a new directory after resolving the error.

### Convert offline and inspect the result

```sh
node scripts/import-legacy.mjs \
  "$gimme_backup_dir/legacy-export.json" \
  "$gimme_backup_dir/legacy-import.sql"
```

The converter has no network or database access. It writes a new mode-`0600` SQL file and prints only aggregate counts. It never overwrites a file. The same input produces the same SQL, regardless of record-array ordering.

The conversion preserves list/gift IDs, exact public slug strings (including numeric slugs), names, timestamps, owner associations, and stored gift positions. Prices become integer cents without floating-point rounding. Owners become `legacy-<numeric user ID>`; their creation time is the earliest available list creation time, or the export time for an owner without a list. Sessions are deliberately absent. Explicit imported IDs advance SQLite's generated IDs for new records.

Unknown fields, duplicate IDs/slugs, missing user/list references, invalid required values (including null names, timestamps, or gift positions), unsupported public slugs, and out-of-range prices stop conversion. Empty string names and safe slugs beginning with a hyphen or underscore are preserved. The supplied August 2026 snapshot has been audited locally; see [the restore report](LOCAL_RESTORE.md) for its missing slugs and orphan gifts. A different source export would need its own audit; it is not required for the deployed August snapshot. Orphan gifts are reported by ID and must be reconciled explicitly, never silently dropped. The new app reserves `api`, `assets`, `webfonts`, `index.html`, `favicon.ico`, and `robots.txt`. If a legacy slug cannot be served, plan its redirect before changing data. Keep the original export unchanged; make a separately retained, reviewed correction file if reconciliation is necessary.

HTTP(S) product/image URLs are preserved verbatim. Unsupported schemes, embedded credentials, and whitespace/control characters clear that URL to an empty string and increment an aggregate warning. The gift itself is retained. Null/empty URL fields become empty strings. Review warnings and affected records privately in the source export before proceeding; the tool does not download or validate remote images. Empty URLs mean no corresponding link/image in the new app.

### Optional isolated local rehearsal for a future restore

Use a fresh persistence directory so rehearsal cannot overwrite ordinary local development data:

```sh
npx wrangler d1 migrations apply DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --file "$gimme_backup_dir/legacy-import.sql" --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --file scripts/verify-import.sql --config wrangler.jsonc
```

Owners, lists, and gifts must match the converter summary. Sessions must be zero before the app is used, both missing-reference counts must be zero, and `foreign_key_check` must report no violations. Review a few lists privately for preserved names, timestamps, cents, and descending gift order, including a numeric slug if one exists.

The generated SQL checks that all four application tables are empty before inserting data. It uses plain `INSERT`, never `REPLACE`, and contains no source-data deletes. A small guard table enforces the empty-database check and is removed on success. A failed import may leave a guard or partial state depending on the executor: diagnose the cause and rehearse in a new database/persistence directory instead of rerunning into occupied data. Never remove real records just to satisfy the guard.

For browser validation, run `GIMME_LOCAL_STATE_DIR="$gimme_backup_dir/rehearsal-state" npm run dev` and open `/local/all-lists`. The Vite plugin uses this directory for local persistence; the default `.wrangler/state` remains separate. The index shows every list, including empty lists, with creation dates and gift counts. Blank names receive an index-only label without changing stored names. The index API is disabled in production. Review several public slugs; numeric legacy ID links should resolve to the canonical slug unless that path is itself an exact slug.

Cloudflare documents the [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [SQL import format](https://developers.cloudflare.com/d1/best-practices/import-export-data/). Local `--file scripts/verify-import.sql` works for rehearsal; use the explicit remote `--command` queries above for remote readback. The generated import intentionally omits `BEGIN`/`COMMIT` because D1 import manages transactions.

## Earlier migration validation

On 2026-10-19, ten migration/export tests passed on Node.js 24.14.1. They exercise real SQLite imports, exact cents, SQL escaping, deterministic ordering, blank legacy names and hyphen/underscore slugs, invalid source records, empty-target enforcement, private output modes, no-overwrite behavior, count-only CLI output, and backup-before-export sequencing using mocked PostgreSQL clients.

A separate synthetic rehearsal passed through Wrangler 4.151.2 with `--local` and isolated D1 persistence. Readback matched one owner, one list, two gifts, and zero sessions; missing-reference counts and foreign-key violations were zero. Assertions confirmed quoted text, owner mapping, microsecond timestamp text, descending gift order, prices of 29 and 9,999,999,999 cents, and unsafe-URL clearing.

The supplied August 15 production dump was also restored into isolated PostgreSQL 17 and exported through the real SQL exporter. After explicit local reconciliation, isolated D1 contains all 135 lists, 91 owners, and 848 attached gifts, with zero sessions or foreign-key violations. Ten orphan gifts remain in the original restore and a separate private JSON file. See [the full local restore report](LOCAL_RESTORE.md). The same reviewed snapshot was subsequently imported into the remote D1 database on 2026-10-20; the live release status is recorded above.
