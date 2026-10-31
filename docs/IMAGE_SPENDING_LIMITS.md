# Image-hosting resource limits

The app uses a private R2 Standard bucket with application-enforced resource
limits. Provider budget alerts are informational and do not enforce these limits.

## Enforced application limits

- Each image is at most 2 MiB; oversized files show a clear error in the form.
- At most 100 image upload attempts per UTC day, shared by all owners and lists.
- At most 250,000,000 reserved upload bytes (250 MB) per UTC day.
- At most 5,000,000,000 reserved bytes for this bucket, across its lifetime.
- At most 1,000 R2 image reads per UTC day, shared by all visitors and hostnames.
- At most 10 new lists per UTC day, before creating anonymous owners/sessions.

Atomic D1 updates reserve allowance **before** URL downloads or R2 operations.
Concurrent requests cannot overshoot the counters. Database errors, missing
budget state, and exhausted limits stop the operation. Gifts without a new
image and ordinary edits do not consume upload allowance. New-list exhaustion
does not block reading or editing existing lists. These counters bound image
operations and new lists, not every gift edit or API request.

Local/clipboard uploads reserve their actual byte size. URL imports reserve the
full 2 MiB maximum against both daily bytes and lifetime capacity before
downloading. Even 100 maximum-size images reserve only 209,715,200 bytes, below
the 250 MB daily allowance. The retained lifetime-storage cap still takes
precedence if capacity has filled over time.
Reservations are never automatically
refunded: failed downloads, uncertain R2 writes, stale list saves, replacements,
and deletions all retain their reservation. This deliberately overestimates
storage and can pause uploads before the bucket reaches 5 GB. Only daily counts
reset at midnight UTC; daily upload bytes reset too. Lifetime reserved capacity
does not reset. The 250 MB daily cap was chosen below 10 GB divided by 32 days
(312.5 MB), leaving room for billing periods crossing UTC-day boundaries.

Every valid-shaped `/media/:key` request reserves a read, including HEAD,
conditional GET, nonexistent objects, and URLs with cache-busting query strings.
Daily exhaustion returns 429 without another R2 call. Existing browser-cached
images can still display. Budget failures are never cached.

At these limits, app traffic can perform at most 3,200 R2 writes and 32,000 R2
reads across 32 UTC dates, and reserve no more than 5 GB in total. Daily byte
reservations also cannot exceed 8 GB across those dates, but the lifetime cap
always takes precedence. Storage is not a monthly upload allowance: R2 bills
retained data in GB-months, so dividing 10 GB by the number of days alone would
not bound costs in later months. The 5 GB lifetime reservation cap does.
This leaves headroom under
R2 Standard's included 1 million Class A operations, 10 million Class B
operations, and 10 GB-month storage. Other apps and manual operations in this
Cloudflare account share those allowances and are outside this app's counters.

## Keep the boundary intact

- Keep Workers on **Free**. It stops at platform limits rather than charging
  request/CPU overages; D1 Free also stops at its limits. A deliberate upgrade
  changes that protection for this and other Workers in the account.
- Keep `r2.dev` public access disabled, with no bucket custom domains or other
  apps/credentials writing to this bucket. All public reads must use our Worker.
- Retain the daily limits even if caching is added. Cache bypasses and misses
  must still count before any R2 operation.
- Apply migration `0003_image_budget.sql` only when the bucket is empty.
  For an existing populated bucket, inventory all
  objects and initialize `reserved_bytes` conservatively before enabling writes.
- Do not reset/delete the budget row to unblock uploads. Inventory and reconcile
  R2, including orphaned objects, before deliberately increasing capacity.
- Rollbacks are production changes requiring explicit approval. Do not deploy
  an older R2-enabled Worker that would bypass these guards. Review the pre-R2
  release as a possible target if the guarded release fails.

## Rollout requirements

Migration `0003_image_budget.sql` establishes the image accounting row.
Migration `0004_family_usage_budgets.sql` adds daily byte accounting and new-list
limits. Apply pending migrations as part of an approved release. Do not edit or
replay previously applied migrations.

See [the repository working agreements](../AGENTS.md) and
[deployment instructions](DEPLOYMENT.md#updating-the-deployed-app).

## Emergency image shutoff

This stops further R2 reads/writes through the app while retaining accounting:

```sh
npx wrangler d1 execute DB --env production --remote --config wrangler.jsonc --command 'UPDATE image_budget SET enabled = 0 WHERE id = 1;'
```

Read counters without exposing list contents:

```sh
npx wrangler d1 execute DB --env production --remote --config wrangler.jsonc --command 'SELECT * FROM image_budget;'
```

After investigation, `UPDATE image_budget SET enabled = 1 WHERE id = 1` restores
image traffic subject to the same retained limits. An emergency rollback to the
pre-R2 Worker also stops all app R2 traffic. Stored objects continue occupying
storage; deleting references or disabling reads does not delete those objects.

These controls bound this app's R2 activity independently of provider billing
alerts. Account-wide usage also includes other applications and direct bucket
operations. No image transformation service, queue, or Durable Object is needed.

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).
