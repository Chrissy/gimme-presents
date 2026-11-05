# Gift suggestions

New gifts start with a URL. A valid HTTP(S) link starts a lookup automatically
after 400 ms without further input; Enter starts it immediately. The result opens
an editable draft in the existing gift form; saving remains a separate action.
If lookup fails, the same form opens for manual completion. The full form opens once, after the lookup
finishes or reaches its deadline; late results cannot overwrite edits. Existing
gift editing is unchanged.

The secondary **Manually enter gift** button below the URL field opens the same
form with an empty name, link, price, and image. This supports general wishes
such as jewelry or hats, with an optional picture and no product link. Choosing
manual entry cancels any pending lookup and ignores late results; it starts no
new lookup or image upload. Images upload only when the gift is explicitly saved.

The draft's back link returns to the URL field and discards unsaved fields and
image selections. It preserves the URL without another automatic lookup until
the link is edited; Enter can retry it. The image control sits to the left of
the create action. Image selection only previews locally or from the source URL;
uploading or importing into hosted storage happens on explicit gift save.

```mermaid
sequenceDiagram
  participant Browser
  participant Worker
  participant D1
  participant Page as Product page
  participant AI as Workers AI
  Browser->>Worker: Gift URL and owned list ID
  Worker->>D1: Check verified owner; reuse result or reserve allowance
  Worker->>Page: Bounded HTML fetch
  Worker->>Worker: Collect product and share metadata
  Worker->>AI: Extract product type and candidate indices
  AI-->>Worker: Plain product type and candidate indices
  Worker->>AI: Write a silly title for the product
  AI-->>Worker: Creative title (or keep plain type on failure)
  Worker->>D1: Cache validated draft for ten minutes
  Worker-->>Browser: Editable fields or partial fallback
  Browser->>Worker: Save edited gift
  Worker->>Worker: Existing gift validation and image import
```

## Extraction and inference

`worker/product-page.ts` reads product JSON-LD, Open Graph, Twitter cards,
product price metadata, and selected product image elements. Relative image
URLs resolve against the final page URL. It reads at most 512 KiB, follows at
most three redirects, and identifies requests as `GimmePresents/1.0`. The beginning of
large documents can still supply useful metadata. It does not execute scripts.

`worker/gift-suggestion-model.ts` uses `@cf/meta/llama-3.2-3b-instruct` through the
Workers AI binding. The first prompt includes selected variant hints and candidate
labels/image filenames. A second prompt receives only the extracted product type
and writes the silly title. The two prompts and their response schemas share a
1,700 UTF-8 byte cap (1,050 for extraction, 650 for naming), leaving framing room
within the existing 2,000-token input allowance. Outputs share the 256-token cap
(160 for extraction, 96 for naming). Fetching and both calls share a 2.5-second deadline,
leaving response time before the browser opens the form at three seconds. A
provider that ignores cancellation cannot keep the form waiting. There are no
automatic inference retries. Only validated candidate indices can populate an
image or price; prices must explicitly use USD. The response schema constrains
selections to candidate indices. For a named `color` URL parameter, images must
mention that color in their label or filename, including in metadata fallback.
Unconfirmed colors stay blank. All fields remain editable.

The model handles both jobs distinctly: identify the item, then write a short,
blunt, silly name for it. The naming pass uses higher sampling temperature and
returns the complete title; the application has no adjective list. A failed,
invalid, oversized, or late naming response keeps the plain product type and
already validated image/price. A product type too long for the naming prompt
skips that call. Neither step retries. The complete draft is cached, so repeating
a URL within ten minutes preserves its title without new inference. Titles can
still repeat; variety and humor are not guaranteed.

Metadata remains available if inference fails or is not configured. Missing or
ambiguous fields stay blank. A page with no product images or prices does not
trigger inference. Suggested image URLs use the existing preview; R2 copying
and image allowances only apply when the user saves.

Retailers can return an interstitial, omit a price, or expose a default product
image rather than the selected variant. Large documents may place useful data
past the read limit. These cases require manual completion; they do not prevent
saving a gift. Suggestions are not a guarantee of current stock or pricing.

## Allowances

| Resource | Allowance |
| --- | ---: |
| Lookup attempts per verified owner, across all lists | 50 / UTC day |
| Lookup attempts across all hostnames and owners | 300 / UTC day |
| Active lookup per owner | 1, with a 90-second recovery lease |
| Cached result per owner and URL | 10 minutes |

D1 reserves owner and global counters together before external work. Failed and
uncertain work counts. Repeating the same URL reuses its cached result without
more model calls. Fragments are ignored; variant query parameters are retained.
Expired records are removed by the existing scheduled handler. Missing budget
records stop new lookups. Exhausting suggestions does not disable manual entry.

## Local checks

The default environment has no remote AI binding, so ordinary development and
CI cannot accidentally invoke a paid provider. API tests mock the model and
page transport while exercising real local D1 reservations. Browser tests cover
URL entry, draft editing, explicit save, manual fallback, and canceled lookups
on desktop and mobile. Existing image and ownership tests also run.

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run build:production
npx wrangler deploy --env production --dry-run
```

## Review and release QA

A bounded check of the final creative prompt on 2026-11-04 used twelve real
model calls with four supplied product types (three names each). It produced ten
distinct names, preserved each supplied product phrase, and did not use
`clumsy`. Examples included `dumb massage gun`, `totally bogus massage gun`, and
`utterly useless ceramic coffee mug`. This isolates naming quality; it does not
measure retailer fetching, extraction accuracy, or end-to-end latency. Repetition
and awkward phrasing remain possible with the small model.

Representative checks on 2026-11-03 used an isolated Cloudflare preview, without
application database or image-storage bindings. An explicit application
User-Agent changed Mount to Coast and L.L.Bean from rejection/interstitial
responses to product HTML; the comparison was repeated with the same outcome.

| Retailer samples | Fetch and extraction result |
| --- | --- |
| Amazon, Target, IKEA | Product title and image; no USD price candidate |
| Mount to Coast | Product title and USD price; unconfirmed selected-color image excluded |
| L.L.Bean, Nike, Apple, LEGO | Product title, image, and USD price candidates |
| REI, Walmart, Etsy | Access denied or bot challenge; manual completion |
| Patagonia | Maintenance page; manual completion |

Eight of twelve selected pages supplied useful metadata, five supplied USD
price candidates. This is one product per retailer, not a representative success
rate or a guarantee of variant accuracy. With real inference, the eight successful
pages took 0.51–1.44 seconds as observed by the preview client (median 1.02 seconds).
Those timings include fetch, extraction, inference, and the preview response trip;
they exclude application database checks and image loading and are not a latency
SLA. The sample used 32–47 output tokens per lookup.

Desktop/mobile smoke tests also edited an actual model result, saved its real
retailer image to local hosted storage, reloaded it, and checked the public view.
The dedicated cutoff tests cover metadata preservation, a hanging provider, a
slow fetch, and late browser responses after editing begins.

1. Exercise representative product URLs from at least three retailers in an
   isolated local/preview environment. Record transport status separately from
   extraction results; HTML retrieved by another client is parser evidence,
   not proof that a Worker can fetch the same page.
2. With an explicitly enabled remote AI binding, inspect the actual model title,
   selected image/color, exact USD price, latency, and token usage. Limit the
   sample and do not retry failures automatically. Confirm a failed model call
   still returns available metadata.
3. Compare a default product URL with a variant URL. Edit every suggested field,
   replace/remove the image, save, reload, and check the public list view. The
   resulting image must be served through the existing hosted-media path.
4. Check a blocked page and a page without price data. Confirm the URL survives
   and the manual form remains usable. Repeat a lookup to verify cached results;
   exercise exhausted allowances in local storage only.
5. After review and merge into `main`, release requires explicit authorization.
   Apply `0007_gift_suggestions.sql` before the guarded deployment. The production
   config adds the `AI` binding; no new application secret or plan upgrade is
   required. Check the account's Workers AI availability and included allowance.
6. Repeat a small production smoke test after deployment; local or captured-HTML
   results do not establish production retailer compatibility. Keep manual entry
   available if a retailer or the provider is unavailable.
