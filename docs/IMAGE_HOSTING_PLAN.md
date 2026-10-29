# Image hosting and capture plan

Build this in small PRs, reviewing each step before starting the next. R2 is the storage layer; the existing Worker controls writes and serves public image URLs. Keep the current UI intact until the capture UI step.

## 1. Host new image links in R2 (this PR)

When an owner saves a gift with a new image URL, download the image once, store its bytes in R2, and display our `/media/<key>` URL. Retain the original URL in `gifts.image` and add a nullable `image_key`; the API supplies `imageUrl` for display. A blank image remains valid. Editing a title or price without changing the source does not refetch it, including for legacy gifts.

Use the existing ownership, same-origin and revision checks before downloading. Limit downloads to 5 MiB and 10 seconds, validate every redirect (at most three), reject IP/local targets and nonstandard ports, and identify PNG/JPEG/GIF/WebP by file signatures rather than trusting the remote MIME type. SVG and other formats are not accepted for new copies in this step. Production uses Workers' public `fetch` network boundary; do not add private-origin or VPC access to this importer. Fetches carry no user cookies or credentials. No resizing, recompression, or metadata stripping is performed yet.

Store before updating D1. A failed download leaves the gift and list revision unchanged and returns an actionable form error; never silently save a hotlink instead. The existing form keeps the draft for a retry. R2 errors also leave D1 unchanged. A stale write discovered after a download cannot change the list, though its newly uploaded object can remain unreferenced. Objects use unique immutable keys. Public GET/HEAD responses include the verified content type, `nosniff`, ETag/304 support and a one-year browser cache lifetime.

For this first step, retain superseded, deleted and unreferenced objects. Do not use a blanket bucket expiration rule: it would delete images still used by gifts. Garbage collection needs a separate reference-aware pass with a grace period and a dry run. Image URLs are public, just like public gift lists; deleting a gift does not revoke previously shared image URLs or cached copies.

Acceptance: a newly saved image keeps rendering after its source becomes unavailable; public visitors can view it; unauthorized or stale writes do not initiate downloads; malformed/oversized/failed sources cannot change a gift; existing lists and ordinary editing still work on desktop and mobile.

## 2. Migrate existing images

Back up current D1 and create a dry-run inventory of distinct sources. Copy in bounded, resumable batches, preserve the original URL, and verify each stored object's bytes/metadata before linking it. Update a gift only if its source and prior key still match the inventory, so migration cannot overwrite a user's newer edit. Report copied, unavailable, blocked, unsupported and skipped images separately. Keep failed sources unchanged and available for later repair. No backfill runs in PR 1 or during normal page reads.

Add reference-aware cleanup with a dry-run report and grace period for failed writes, replacements and deletions. Confirm retention and cache expectations before removing objects.

## 3. Add the image capture UI

Add a small `+` button at the bottom right of the image-entry area, using the familiar Slack interaction. Its menu offers **Paste image URL** and **Upload from device**. When image data is on the clipboard, normal paste in the composer adds it directly without needing to open the menu. Preserve ordinary text paste when the clipboard does not contain an image.

All three sources—URL, local file, clipboard image—show a preview with remove/replace, upload progress, and a recoverable failure state. Clipboard images upload through the same owner-authorized pipeline as local files. Use temporary browser object URLs for immediate file previews and release them after use. Define whether previews upload immediately or on gift save, and how abandoned uploads expire, before implementation. Provide keyboard-accessible controls and mobile file selection. Keep a source URL distinct from the hosted display URL.

Review the interaction and placement before changing the existing form. This step should not require an AI feature.

## 4. Discover images from product URLs

Add a small agent that can fetch image candidates for a pasted product URL, beginning with ordinary product metadata and using AI only where useful. Show candidate previews for the user to choose or replace. Once selected, persist through the same R2 ingestion path. Bound work, cost and retries; failures should leave manual URL, upload and clipboard options available. Never let third-party page content issue instructions or access private services.

Review the agent behavior and budget separately after the manual capture workflow is working.

## First deployment

This PR is stacked on the production configuration in PR #25. Merge that configuration first, then retarget this PR to `master`. No production bucket, migration, backfill or deployment is performed merely by opening this PR.

Verify the personal `pp-diaper` profile/account (`6fcfd050639f1bcffd6534443c89e0e5`) before any remote operation. Commands below are operator steps for the reviewed release, not an automatic rollout:

```sh
npx wrangler whoami
npx wrangler r2 bucket list --env production --config wrangler.jsonc
# Create only if the named bucket does not already exist in this account.
npx wrangler r2 bucket create gimme-presents-images --env production --config wrangler.jsonc
# Use a new private backup filename; never replay the legacy import.
umask 077
npx wrangler d1 export DB --env production --remote --config wrangler.jsonc --output /absolute/private/location/before-image-hosting.sql
npx wrangler d1 migrations apply DB --env production --remote --config wrangler.jsonc
npm run deploy
```

Keep the bucket private (no r2.dev public URL, custom domain or browser bucket credentials required); the Worker provides public reads. Default development uses a separate local simulated bucket. The new migration only adds a nullable column, so the old Worker remains compatible. Apply it before deploying the new Worker.

Smoke-test a disposable list with a public image URL: confirm the API retains the source, returns `/media/...`, and that the returned bytes/content type and repeat GET/HEAD/304 behavior are correct. Verify owner edit/reload and a public visitor on desktop/mobile, plus a failed image link that preserves the draft and current gift. Remove the disposable list afterward. Record the deployed version and migration status in `DEPLOYMENT.md`.

Rollback: redeploy the prior Worker without dropping the column or deleting the bucket. It still reads the retained original URLs. This restores external-image display, with its original availability limitations. Back up R2 as well as D1 once hosted images are in use; the D1 export contains references, not image bytes.

References: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Workers fetch boundary](https://blog.cloudflare.com/workers-environment-live-object-bindings/).
