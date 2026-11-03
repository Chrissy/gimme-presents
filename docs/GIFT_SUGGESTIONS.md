# Gift suggestions

New gifts start with a URL. Submitting it returns an editable draft in the
existing gift form; saving remains a separate action. Manual entry is available
before, during, and after a lookup. Existing gift editing is unchanged.

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
  Worker->>AI: One bounded prompt with candidate facts
  AI-->>Worker: Title and candidate indices
  Worker->>D1: Cache validated draft for ten minutes
  Worker-->>Browser: Editable fields or partial fallback
  Browser->>Worker: Save edited gift
  Worker->>Worker: Existing gift validation and image import
```

## Extraction and inference

`worker/product-page.ts` reads product JSON-LD, Open Graph, Twitter cards,
product price metadata, and selected product image elements. Relative image
URLs resolve against the final page URL. It reads at most 512 KiB, follows at
most three redirects, and has a ten-second fetch deadline. The beginning of
large documents can still supply useful metadata. It does not execute scripts.

`worker/gift-suggestion-model.ts` uses `@cf/meta/llama-3.2-3b-instruct` through the
Workers AI binding. The prompt includes selected variant hints and candidate
labels/image filenames. Prompt content plus the response schema is capped at
1,700 UTF-8 bytes, leaving framing room within a 2,000-token input allowance; output is
capped at 256 tokens and the call has a twenty-second deadline. There are no
automatic inference retries. Only validated candidate indices can populate an
image or price; prices must explicitly use USD. The response schema constrains
selections to candidate indices. For a named `color` URL parameter, images must
mention that color in their label or filename, including in metadata fallback.
Unconfirmed colors stay blank. All fields remain editable.

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
another model call. Fragments are ignored; variant query parameters are retained.
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

Representative checks on 2026-11-03 used the real model through an isolated
Cloudflare preview, without application database or image-storage bindings:

| Retailer sample | Worker fetch | Result |
| --- | --- | --- |
| Amazon duffel | Product HTML available | Editable humorous title and main image; price absent and left blank |
| Mount to Coast trainer | Product HTML unavailable | Manual completion; captured-HTML model check separately found USD 180.00 and excluded the unconfirmed default color image |
| L.L.Bean sweater | Interstitial without product data | Manual completion; captured-HTML model check separately found the product image and USD 99.95 |

The final captured-HTML model samples used 279–412 input tokens and 36–40 output
tokens, with 0.4–0.7-second handler durations. The Amazon preview lookup took
about 1.9 seconds including fetch and inference. This is a small sample, not a
latency guarantee. Captured-HTML success does not establish retailer compatibility.
The two unavailable retailer pages remain a known limitation of this approach.

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
