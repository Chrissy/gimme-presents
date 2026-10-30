# GimmePresents

A small Christmas list builder: React and Vite in the browser, a Hono API on Cloudflare Workers, and SQLite data in Cloudflare D1. The original Rails CSS, native input appearance, spacing, fixed forms, edit popovers, link controls, and sarcastic copy are retained. This is a runtime port, not a UI redesign; the original mobile layout and its quirks are intentional. Google sign-in and its account-only list history are removed.

Live on [gimmesomefreakingpresents.com](https://gimmesomefreakingpresents.com) since 2026-10-20. Both the apex and `www` are attached as Cloudflare Worker Custom Domains; `www` redirects to the HTTPS apex with paths and query strings preserved. The [workers.dev address](https://gimme-presents.fivefourths.workers.dev) remains available. The domain change reused the existing D1 database without reimporting it: 135 lists and 848 attached gifts remain after smoke-test cleanup. Main-domain browser, ownership, editing, and redirect checks passed.

## Run locally

Use Node.js 24 and npm. Local development uses simulated D1; a Cloudflare account is not needed for these commands.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open the address printed by Vite. Create a list, then add gifts with a name, product URL, and optional price. Use the small **+** button to upload an image or paste an image URL; pasting an image from the clipboard while focused in the gift form also adds it. Each choice shows a removable preview. Images are uploaded or copied into R2 (simulated locally) only when the gift is saved, then served from this app. Use a public PNG, JPEG, GIF, or WebP link of at most 5 MiB. Existing images remain external until migrated or replaced. Lists are public at their share URL. The browser that creates a list can rename it, edit/delete/reorder gifts, and delete the list.

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

**Imported lists are public and view-only.** Rails sessions and Google authentication were not imported. New lists use anonymous browser ownership. Cookies are host-only: a list created on workers.dev remains editable there with its existing cookie, but that cookie does not grant editing on the main domain.

See [the deployment and recovery guide](docs/DEPLOYMENT.md) for the deployed version, domain routing, remote readback, verification status, backups, and archival recovery tools. The `www` canonical redirect uses a Cloudflare Single Redirect rule outside Wrangler, preserving the path and query string on the HTTPS apex domain.

## Scope

This version includes anonymous ownership, ordinary list/gift editing, and R2 image hosting with URL, file, and clipboard previews. Production deployment requires the R2 bucket and additive D1 migration described in the [image hosting plan](docs/IMAGE_HOSTING_PLAN.md). The capture UI is implemented; the plan also covers a separate legacy-image migration and later image discovery from product URLs. AI image discovery, Google OAuth, email recovery, and the future drag/resize image layout editor are not included yet.
