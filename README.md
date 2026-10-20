# GimmePresents

A small Christmas list builder: React and Vite in the browser, a Hono API on Cloudflare Workers, and SQLite data in Cloudflare D1. The original Rails CSS, native input appearance, spacing, fixed forms, edit popovers, link controls, and sarcastic copy are retained. This is a runtime port, not a UI redesign; the original mobile layout and its quirks are intentional. Google sign-in and its account-only list history are removed.

Live on [gimme-presents.fivefourths.workers.dev](https://gimme-presents.fivefourths.workers.dev) since 2026-10-20. The reviewed August backup is imported: 135 lists and 848 attached gifts. Live smoke checks passed on workers.dev. The main domain is unchanged and remains deferred.

## Run locally

Use Node.js 24 and npm. Local development uses simulated D1; a Cloudflare account is not needed for these commands.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open the address printed by Vite. Create a list, then add gifts with a name, product URL, image URL, and optional price. Lists are public at their share URL. The browser that creates a list can rename it, edit/delete/reorder gifts, and delete the list.

The local-only `/local/all-lists` page is a plain index of every list, newest first, with creation dates and gift counts. Its API returns 404 in production. To inspect an imported database separately from your ordinary development data, run `GIMME_LOCAL_STATE_DIR=/path/to/rehearsal-state npm run dev`, using the same directory as Wrangler's `--persist-to` argument. See the [local restore report](docs/LOCAL_RESTORE.md) for the supplied August 2026 snapshot.

Ownership uses a private HttpOnly browser cookie with a 180-day lifetime, renewed during use at most once per day. Keep that cookie: clearing browser data, letting it expire, or switching browsers loses edit access in this version. The public URL alone does not grant editing.

## Validate

```sh
npm run typecheck
npm test
npm run build
```

`npm test` runs Worker/API tests and offline import tests. The import tests use Node's built-in SQLite support. `npm run test:e2e` runs the browser suite; install its browser with `npx playwright install chromium` first.

## Existing Rails data and deployment

Production runs in the personal Cloudflare account using the repository's saved `pp-diaper` Wrangler profile. Its account and D1 IDs are pinned in `wrangler.jsonc`. To update the deployed app, confirm the personal account with `npx wrangler whoami`, then run `npm run deploy`. The database is already populated: do not repeat its initial import for an ordinary update.

**Imported lists are public and view-only.** Rails sessions and Google authentication were not imported. New lists use anonymous browser ownership. Cookies created on workers.dev will not transfer automatically to a future custom domain.

See [the deployment and recovery guide](docs/DEPLOYMENT.md) for the deployed version, remote readback, live verification status, backups, and archival recovery tools. No main-domain, Custom Domain, or DNS change is part of this release.

## Scope

This version includes anonymous ownership and ordinary list/gift editing. Google OAuth, email recovery, image uploads, and the future drag/resize image layout editor are not included. Image fields remain external URLs; no R2 bucket or email service is required. React provides the base for adding layout metadata and interactive image editing later.
