# Migration and deployment

This branch replaces the Rails runtime with a React frontend, a Hono Worker API, and D1 storage. The commands below are an operator runbook. No production PostgreSQL export, Cloudflare resource creation, remote data import, deployment, or domain change was performed while preparing this change.

## Decisions before cutover

- **Choose the Cloudflare account.** The read-only account check during development showed a work account. Confirm that the intended personal/project account is selected before creating D1 or deploying; this repository does not pin an account ID.
- **Decide how old owners will edit.** Imported lists retain their public slugs and owner relationships, but this version intentionally imports no sessions or Google credentials. Rails cookies and Google sign-in will not confer access to `legacy-<user-id>` owners. There is no ownership-claim endpoint or email recovery implementation. Before switching the domain, either implement and verify an owner-access bridge or explicitly accept that imported lists are public, read-only archives in this version. Keep Rails available until that decision is resolved. Do not grant ownership based solely on a public slug or an unverified email address.
- **Choose a write-freeze window.** Rehearsals can use a live read-only snapshot. The final backup/export must run after Rails writes are stopped, and Rails must stay frozen until cutover or rollback. Otherwise changes made after the snapshot will be absent from D1.

These are deployment decisions; local development and offline conversion are available now. Email delivery/recovery and draggable/resizable image layouts are future work, not prerequisites silently supplied by this migration.

## 1. Prepare the reviewed source and local tools

Use Node.js 24, npm, and PostgreSQL clients compatible with the source server (`pg_dump`, `pg_restore`, and `psql`). Check out the reviewed PR commit/branch. The branch for this change is `codex/cloudflare-react-port`:

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

## 2. Back up PostgreSQL, then capture the minimal export

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

## 3. Convert offline and inspect the result

```sh
node scripts/import-legacy.mjs \
  "$gimme_backup_dir/legacy-export.json" \
  "$gimme_backup_dir/legacy-import.sql"
```

The converter has no network or database access. It writes a new mode-`0600` SQL file and prints only aggregate counts. It never overwrites a file. The same input produces the same SQL, regardless of record-array ordering.

The conversion preserves list/gift IDs, exact public slug strings (including numeric slugs), names, timestamps, owner associations, and stored gift positions. Prices become integer cents without floating-point rounding. Owners become `legacy-<numeric user ID>`; their creation time is the earliest available list creation time, or the export time for an owner without a list. Sessions are deliberately absent. Explicit imported IDs advance SQLite's generated IDs for new records.

Unknown fields, duplicate IDs/slugs, missing user/list references, invalid required values (including null names, timestamps, or gift positions), unsupported public slugs, and out-of-range prices stop conversion. Production data has not been audited: a successful synthetic rehearsal is not a guarantee that every legacy row already meets these requirements. Some Rails deletions may have left orphan gifts: those are reported by ID and must be reconciled explicitly, never silently dropped. The new app reserves `api`, `assets`, `webfonts`, `index.html`, `favicon.ico`, and `robots.txt`. If a legacy slug cannot be served, plan its redirect before changing data. Keep the original export unchanged; make a separately retained, reviewed correction file if reconciliation is necessary.

HTTP(S) product/image URLs are preserved verbatim. Unsupported schemes, embedded credentials, and whitespace/control characters clear that URL to an empty string and increment an aggregate warning. The gift itself is retained. Null/empty URL fields become empty strings. Review warnings and affected records privately in the source export before proceeding; the tool does not download or validate remote images. Empty URLs mean no corresponding link/image in the new app.

## 4. Rehearse against an isolated local D1 database

Use a fresh persistence directory so rehearsal cannot overwrite ordinary local development data:

```sh
npx wrangler d1 migrations apply DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --file "$gimme_backup_dir/legacy-import.sql" --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_backup_dir/rehearsal-state" --file scripts/verify-import.sql --config wrangler.jsonc
```

Owners, lists, and gifts must match the converter summary. Sessions must be zero before the app is used, both missing-reference counts must be zero, and `foreign_key_check` must report no violations. Review a few lists privately for preserved names, timestamps, cents, and descending gift order, including a numeric slug if one exists.

The generated SQL checks that all four application tables are empty before inserting data. It uses plain `INSERT`, never `REPLACE`, and contains no source-data deletes. A small guard table enforces the empty-database check and is removed on success. A failed import may leave a guard or partial state depending on the executor: diagnose the cause and rehearse in a new database/persistence directory instead of rerunning into occupied data. Never remove real records just to satisfy the guard.

For browser validation of the imported content, use a fresh local checkout/state, apply migrations and the import to its default local D1 before running `npm run dev`, then open a selection of known public slugs. Numeric legacy ID links should resolve to the canonical slug unless that path is itself an exact slug. Keep ordinary development data separate from this fresh browser rehearsal.

## 5. Provision production D1 in the intended account

Only proceed after the rehearsal and owner-access decision above. Check the active Cloudflare account explicitly; use the desired account's login/profile before proceeding:

```sh
npx wrangler whoami
npx wrangler d1 create gimme-presents-production --env production --update-config=false --config wrangler.jsonc
```

Copy the returned database UUID into `env.production.d1_databases[0].database_id` in `wrangler.jsonc`. Leave the default local binding isolated. Both IDs are initially all-zero placeholders; no production database is provisioned by this PR. Verify the selected production binding and account before every remote command.

Apply the schema, save a pre-import D1 backup, then import the final export captured during the write freeze:

```sh
npx wrangler d1 migrations apply DB --env production --remote --config wrangler.jsonc
npx wrangler d1 export DB --env production --remote --output "$gimme_backup_dir/d1-before-import.sql" --config wrangler.jsonc
npx wrangler d1 execute DB --env production --remote --file "$gimme_backup_dir/legacy-import.sql" --config wrangler.jsonc
npx wrangler d1 execute DB --env production --remote --file scripts/verify-import.sql --config wrangler.jsonc
```

Use a new backup filename for every export and keep the directory private. Match the same counts and integrity checks used in rehearsal before deploying. Import into a newly created, migrated database only. If any step fails, stop and inspect; do not rerun the import over an existing application's data.

Cloudflare documents the [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [SQL import format](https://developers.cloudflare.com/d1/best-practices/import-export-data/). The generated file intentionally omits `BEGIN`/`COMMIT` because D1 import manages transactions.

## 6. Deploy to workers.dev and verify the app

```sh
npm run deploy
```

This runs the production Vite build (`CLOUDFLARE_ENV=production`) and deploys with `--env production`. Check the deployment's actual URL and binding output. Before the domain change, verify:

- Known imported list slugs and legacy numeric links display the expected gifts and order; missing lists show a useful error.
- A new disposable list can be created, renamed, shared, and deleted; gifts can be created, edited, reordered, and deleted.
- A separate browser/private window can view the shared list but cannot edit it. Missing or cross-origin mutation authorization is rejected.
- Desktop and mobile views work, and link/image rendering handles cleared legacy URLs gracefully.

Test writes now modify production D1 even on the temporary workers.dev hostname. Use disposable smoke-test lists, and save an updated D1 export before changing the domain. Sessions are host-only: a workers.dev ownership cookie will not transfer to the custom domain. Do not start real lists on the temporary hostname expecting to edit them after cutover. New sessions have a rolling 180-day lifetime, renewed on use at most once per day; an expired, deleted, or lost cookie remains unrecoverable in this version. Old imported owners still have no new sessions unless a separate, verified ownership bridge has been implemented.

## 7. Change the domain only after the cutover decisions are complete

Keep the Rails app frozen and available as a rollback target. Record the current DNS/routing configuration. Add the intended hostname as a Worker Custom Domain in the correct Cloudflare zone, or add a production `routes` entry with that hostname and `custom_domain: true` and redeploy. Check any existing DNS record conflict before changing it. Use the [Custom Domains guide](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) for the actual hostname and zone.

After the domain points to the Worker, test HTTPS, known old share URLs, and a new list created on the canonical hostname. Confirm both view-only access from a second browser and editing from the creating browser. Verify the canonical hostname directly; success on workers.dev does not prove cookies or routing on the final domain. Retire Rails only after these checks, the owner-access decision, and the agreed backup-retention period.

## Rollback and backup limits

Before any new Worker writes, switching routing back to the frozen Rails app restores the backed-up source state. Once anyone creates or edits lists in D1, PostgreSQL is stale: changing DNS back alone would lose access to those new changes. Stop writes, back up D1, and reconcile its changes into the rollback target before accepting writes there. This PR includes no reverse migration or automatic dual-write system.

A Worker code rollback does not roll back D1 contents or schema. A D1 restore can discard newer writes and sessions. Keep timestamped PostgreSQL/D1 backups and record the final snapshot time, import counts, deployment version, hostname change, and smoke-test outcome. There is no claim here that remote resources, production data, or final-domain authentication have been verified.

## Migration validation performed

On 2026-10-19, nine migration/export tests passed on Node.js 24.14.1. They exercise real SQLite imports, exact cents, SQL escaping, deterministic ordering, invalid source records, empty-target enforcement, private output modes, no-overwrite behavior, count-only CLI output, and backup-before-export sequencing using mocked PostgreSQL clients.

A separate synthetic rehearsal passed through Wrangler 4.151.2 with `--local` and isolated D1 persistence. Readback matched one owner, one list, two gifts, and zero sessions; missing-reference counts and foreign-key violations were zero. Assertions confirmed quoted text, owner mapping, microsecond timestamp text, descending gift order, prices of 29 and 9,999,999,999 cents, and unsafe-URL clearing. PostgreSQL export syntax has not been exercised against the real source database, and production data still needs the audit/rehearsal above.
