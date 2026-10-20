# Local restore of the August 2026 snapshot

The supplied `data/gimme-presents-heroku-production-raw-2026-08-15.dump` was restored locally on October 19, 2026. Its SHA-256 matched the supplied checksum:

```text
2c91e714dd22fbc70c9699da95af49f457261dede17e68fdfb5bdb6847c64b2e
```

The archive uses PostgreSQL custom format 1.16. The default PostgreSQL 14 client cannot read it; the installed PostgreSQL 17.11 tools at `/opt/homebrew/opt/postgresql@17/bin` restored it successfully.

## Open the review

From the repository root:

```sh
GIMME_LOCAL_STATE_DIR=data/local-restore-2026-08-15/d1-state npm run dev
```

Open `http://127.0.0.1:5173/local/all-lists`. The text index links to all lists and shows their creation dates and gift counts, newest first. It does not change the existing list UI. The API only serves this index when `ENVIRONMENT` is `local`; production returns 404.

This is a separate local D1 database. Ordinary development state remains at `.wrangler/state`. Imported lists are view-only because neither Google credentials nor Rails sessions were imported. No Cloudflare resources, remote database contents, or production routing were changed.

## Results and explicit reconciliation

| Records | Restored PostgreSQL | Local review D1 |
| --- | ---: | ---: |
| Users / owners | 91 | 91 |
| Lists | 135 | 135 |
| Gifts | 858 | 848 |
| New app sessions | — | 0 |

- All 135 lists are retained. Fifteen have empty names; the index displays `Untitled list #<id>` for them while leaving the stored name unchanged.
- Fourteen lists have a null or empty slug. Only the local review copy assigns `legacy-list-<id>` URLs, with collision checking. These lists have no gifts. Every nonempty original slug is preserved, including two beginning with `-` or `_`.
- Ten gifts refer to five lists absent from the source dump. Their rows remain in the untouched PostgreSQL restore, the original export, and a separate `orphaned-gifts.json`. They are not reassigned to another owner or list.
- Thirteen attached gifts have empty names, preserved exactly.
- The existing converter clears five unsupported product URLs and three unsupported image URLs in D1. The gift records remain; original URL text is retained in the source export. Remote image availability was not audited.

Readback compared every imported list and gift with the source export. IDs, exact names, ownership, timestamps, prices in cents, and gift ordering match. All nonempty source slugs match; only the 14 explicitly recorded missing-slug repairs differ. D1 reports zero missing owner/list references and zero foreign-key violations.

The missing-slug assignments and orphan exclusion are a local review decision, not automatic importer behavior. The importer still stops on these conditions. Review them again against a fresh export before production cutover; this August snapshot cannot represent later edits.

## Private local artifacts

Everything below is under ignored `data/local-restore-2026-08-15/`:

- `postgres/`, `socket/`, and `postgres.log`: isolated PostgreSQL cluster, Unix socket, and log. It uses port 55432 with TCP listening disabled.
- `schema.sql`: inspected archive schema.
- `legacy-export.json`: unchanged minimal export from the restored database; includes user IDs but omits account emails, passwords, and Google identifiers.
- `reconcile.mjs`: the explicit local transformation, producing new files without overwriting existing ones.
- `legacy-review.json`, `reconciliation-report.json`, and `orphaned-gifts.json`: separate review copy and audit trail.
- `legacy-import.sql`, `d1-import.log`, and `d1-state/`: converted SQL, local import log, and isolated preview state.
- `verify-restored.mjs` and `verification-report.json`: full local readback verification and aggregate results.

The original dump and checksum remain unchanged. The parent restore directory is private, and none of its contents are committed. The isolated PostgreSQL server was stopped after verification; the preview reads D1 and does not need it running.

## Repeating the import in a fresh directory

With the reviewed SQL already generated, choose a new persistence directory:

```sh
gimme_review_state=data/local-restore-2026-08-15/another-d1-state
npx wrangler d1 migrations apply DB --local --persist-to "$gimme_review_state" --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_review_state" --file data/local-restore-2026-08-15/legacy-import.sql --config wrangler.jsonc
npx wrangler d1 execute DB --local --persist-to "$gimme_review_state" --file scripts/verify-import.sql --config wrangler.jsonc
GIMME_LOCAL_STATE_DIR="$gimme_review_state" npm run dev
```

Do not rerun the import into occupied application tables. The SQL guard will refuse it.
