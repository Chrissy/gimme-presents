# GimmePresents

A small Christmas list builder: React and Vite in the browser, a Hono API on Cloudflare Workers, and SQLite data in Cloudflare D1. The original typography, artwork, colors, and sarcastic copy are retained.

## Run locally

Use Node.js 24 and npm. Local development uses simulated D1; a Cloudflare account is not needed for these commands.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open the address printed by Vite. Create a list, then add gifts with a name, product URL, image URL, and optional price. Lists are public at their share URL. The browser that creates a list can rename it, edit/delete/reorder gifts, and delete the list.

Ownership uses a private HttpOnly browser cookie with a 180-day lifetime, renewed during use at most once per day. Keep that cookie: clearing browser data, letting it expire, or switching browsers loses edit access in this version. The public URL alone does not grant editing.

## Validate

```sh
npm run typecheck
npm test
npm run build
```

`npm test` runs Worker/API tests and offline import tests. The import tests use Node's built-in SQLite support. `npm run test:e2e` runs the browser suite; install its browser with `npx playwright install chromium` first.

## Existing Rails data and deployment

The offline tools in `scripts/` export a read-only PostgreSQL snapshot and generate D1 SQL. They preserve existing list/gift IDs, share slugs, owner associations, timestamps, prices, and gift ordering. They refuse inconsistent data and existing output files. Production configuration intentionally contains an unset D1 database ID.

**Importing data preserves public lists, not legacy edit access.** Rails sessions and Google authentication are not imported. The deployment guide requires an explicit owner-access decision before changing the production domain.

Follow [the migration and deployment guide](docs/DEPLOYMENT.md) for backup, rehearsal, account selection, provisioning, verification, and cutover. No production migration or deployment is implied by this source change.

## Scope

This version includes anonymous ownership and ordinary list/gift editing. Google OAuth, email recovery, image uploads, and the future drag/resize image layout editor are not included. Image fields remain external URLs; no R2 bucket or email service is required. React provides the base for adding layout metadata and interactive image editing later.
