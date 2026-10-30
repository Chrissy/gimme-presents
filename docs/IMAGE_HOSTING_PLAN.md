# Image hosting and capture plan

Build this in small PRs, reviewing each step before starting the next. R2 is the storage layer; the existing Worker controls writes and serves public image URLs. Keep the current UI intact until the capture UI step.

## 1. Host new image links in R2 (implemented in #26)

When an owner saves a gift with a new image URL, download the image once, store its bytes in R2, and display our `/media/<key>` URL. Retain the original URL in `gifts.image` and add a nullable `image_key`; the API supplies `imageUrl` for display. A blank image remains valid. Editing a title or price without changing the source does not refetch it, including for legacy gifts.

Use the existing ownership, same-origin and revision checks before downloading. Limit downloads to 5 MiB and 10 seconds, validate every redirect (at most three), reject IP/local targets and nonstandard ports, and identify PNG/JPEG/GIF/WebP by file signatures rather than trusting the remote MIME type. SVG and other formats are not accepted for new copies in this step. Production uses Workers' public `fetch` network boundary; do not add private-origin or VPC access to this importer. Fetches carry no user cookies or credentials. No resizing, recompression, or metadata stripping is performed yet.

Store before updating D1. A failed download leaves the gift and list revision unchanged and returns an actionable form error; never silently save a hotlink instead. The existing form keeps the draft for a retry. R2 errors also leave D1 unchanged. A stale write discovered after a download cannot change the list, though its newly uploaded object can remain unreferenced. Objects use unique immutable keys. Public GET/HEAD responses include the verified content type, `nosniff`, ETag/304 support and a one-year browser cache lifetime.

For this first step, retain superseded, deleted and unreferenced objects. Do not use a blanket bucket expiration rule: it would delete images still used by gifts. Garbage collection needs a separate reference-aware pass with a grace period and a dry run. Image URLs are public, just like public gift lists; deleting a gift does not revoke previously shared image URLs or cached copies.

Acceptance: a newly saved image keeps rendering after its source becomes unavailable; public visitors can view it; unauthorized or stale writes do not initiate downloads; malformed/oversized/failed sources cannot change a gift; existing lists and ordinary editing still work on desktop and mobile.

## 2. Migrate existing images

Back up current D1 and create a dry-run inventory of distinct sources. Copy in bounded, resumable batches, preserve the original URL, and verify each stored object's bytes/metadata before linking it. Update a gift only if its source and prior key still match the inventory, so migration cannot overwrite a user's newer edit. Report copied, unavailable, blocked, unsupported and skipped images separately. Keep failed sources unchanged and available for later repair. No backfill runs in PR 1 or during normal page reads.

Add reference-aware cleanup with a dry-run report and grace period for failed writes, replacements and deletions. Confirm retention and cache expectations before removing objects.

## 3. Add the image capture UI (implemented ahead of migration)

A small `+` button at the bottom right of each gift form replaces the permanent “Link to a photo” input. Its menu offers **Upload from device** and **Paste image URL**. Image clipboard paste is scoped to the gift form and uses the file path; ordinary text paste is unchanged. One image is supported per gift.

All three sources show a removable thumbnail before saving. Local files use temporary browser object URLs, which are revoked when replaced or the form unmounts. URL entry exists only in the menu. Escape and outside clicks dismiss the popover. Existing saved images appear in the editor preview; `+` replaces them and `×` removes them. Mobile editing keeps the controls within the viewport.

Upload happens **on gift save**, not on selection. This avoids abandoned uploads from canceled previews. A multipart request contains the gift fields and one image file; it uses the existing create/update endpoint and ownership/revision checks. Both the entire request and the file are size-bounded, and the existing byte-signature validation is shared with URL ingestion. The browser shows “Saving…” while the request is pending. File bytes and fields stay in the draft on failure or a revision conflict, so the user can retry. Unsaved local files are not persisted across page reloads.

Uploaded images have no external source URL. Ordinary edits preserve their key; an explicit `removeImage` flag clears it. No new database migration or R2 binding is needed beyond the hosting release. The image content policy permits `blob:` previews; script and object policies remain unchanged. Superseded/stale-write objects still follow the retention/cleanup policy above.

Acceptance: preview before save, upload/reload/public delivery, edit without losing an uploaded image, removal/replacement, URL errors with preserved drafts, clipboard image paste, unchanged text paste, invalid/oversized-file rejection, keyboard dismissal, and desktop/mobile browser coverage. AI discovery and the existing-image backfill remain separate work.

## 4. Discover images from product URLs

Add a small agent that can fetch image candidates for a pasted product URL, beginning with ordinary product metadata and using AI only where useful. Show candidate previews for the user to choose or replace. Once selected, persist through the same R2 ingestion path. Bound work, cost and retries; failures should leave manual URL, upload and clipboard options available. Never let third-party page content issue instructions or access private services.

Review the agent behavior and budget separately after the manual capture workflow is working.

## First deployment

The hosting work from PR #26 was merged into the production configuration branch in PR #25. That prerequisite must land on `master` before the image capture PR can target it with only the UI/upload changes. No production bucket, migration, backfill or deployment is performed merely by opening a PR.

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
