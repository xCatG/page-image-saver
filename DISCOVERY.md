# Listing discovery pilot

Open a configured listing page, open **Catalog capture**, choose **Listing discovery only**,
then **Preview catalog**, **Take over**. A listing preview is sufficient. The run follows
listing pagination only; it does not visit product URLs, acquire product media, classify
scope, or require a local receiver. Pause, resume, stop, pacing and challenge guards use
the existing runner. Changing the selected mode requires another preview before starting.
**Product capture** remains the default and retains its receiver requirement. Each new preview
replaces the previous preview and its seed. A listing preview starts at the displayed **Start URL**;
a product-only preview has no listing seed. Galleries are checked when each PDP is visited, so a
separate, accumulated product preview is no longer required to start listing capture.

## Capture a saved discovery queue

Inside **Catalog capture**, choose one or several JSON files with **Discovery exports**, or
press **Reuse current discovery** after stopping/finishing a discovery run. Either action
prepares **Capture discovery queue**; review the displayed **Start URL** and target count,
then press **Take over**. File selection prepares the queue without starting navigation.
To use a different source, load/reuse it again. Active and paused runs must stop first.

Only the imported product URLs are captured: no listing walk, no extra color URLs. URLs
are normalized with fragments removed and deduplicated, preserving query strings and the
first-seen order. Every input must be a version-1 discovery export for the current configured
host. Validation completes before replacing the saved run; empty, malformed, mixed-host or
oversized inputs fail without changing it. Existing limits apply: 1,000 source listing rows
across inputs and 10,000 unique products (at most 10,000 entries per listing).

Pacing, pause/resume, stop and restart use the existing runner. Before visiting a queued PDP,
the receiver checks the existing URL-only capture identity. Only a verified receiver result
counts as **skipped**. Restart rechecks saved captured/skipped identities. Missing or unavailable
verification never grants a skip. This mode also works without a receiver: Downloads bundles
are counted as **failed / exported-unverified**, not captured/skipped or verified complete.
Challenge/403/429 responses pause the run.

All requested URLs retain evidence, including targets whose existing scope metadata is
`exclude`; scope decisions belong to the downstream reader. Legacy listing capture keeps
its old exclusion behavior. Product capture envelopes and image files retain their existing
format. Only the takeover run report adds provenance on each queue row:

```json
{
  "mode": "capture-discovery",
  "seedUrl": "https://us.chantelle.com/product/bra-black",
  "products": [{
    "url": "https://us.chantelle.com/product/bra-black",
    "status": "pending",
    "origins": [
      {"file_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "listing_url": "https://us.chantelle.com/list-bras"},
      {"run_started_utc": "2026-10-03T18:00:00.000Z", "listing_url": "https://us.chantelle.com/list-panties"}
    ]
  }]
}
```

Each imported file is identified by SHA-256 of its exact bytes. Reusing the current run uses
its saved `started_utc`. Every distinct source/listing origin is retained for a duplicate
product. The snippet illustrates the two origin shapes; a preparation uses either file
imports or current-run reuse. The full report keeps `page-image-saver-takeover-run/v1` and
adds `accounting.skipped` for this mode. `complete` means this fixed queue is verified,
not that the source discovery covered the entire catalog. Export remains in `catalog-runs`.

Use **Export run JSON** at any point. Both modes download under
`PageImageSaver/catalog-runs/<site>/<timestamp>-run.json`. Discovery exports use
`format: "page-image-saver-discovery/v1"`; the existing capture report keeps
`page-image-saver-takeover-run/v1` unchanged. There is no new artifact namespace.

## Discovery export contract

The following synthetic example shows one page with no next link and no configured
positive end check (the current Chantelle configuration). This is a gap, not proof of
complete coverage. `complete` requires a positive configured end check to pass. Other
statuses include `preview`, `running`, `paused`, `stopped`, and `discovery_incomplete`.

```json
{
  "schema_version": 1,
  "format": "page-image-saver-discovery/v1",
  "mode": "discovery",
  "started_utc": "2026-10-03T18:00:00.000Z",
  "exported_utc": "2026-10-03T18:05:00.000Z",
  "extension_version": "1.0",
  "site": "us.chantelle.com",
  "locale": "en-US",
  "selectors": {
    "productLinkSelector": "a.product-card__link, a[data-testid='ProductCard_link'][href*='/product/']",
    "nextSelector": "a[data-testid='Pagination_next-button']",
    "endCheck": null
  },
  "listings": [{
    "url": "https://us.chantelle.com/list",
    "final_url": "https://us.chantelle.com/list",
    "products": [{"url": "https://us.chantelle.com/product/bra-black", "card_text": "Lace Bra $42"}],
    "next_url": null,
    "end_check": {"observed": null, "passed": false}
  }],
  "totals": {"listing_pages": 1, "product_urls": 1},
  "status": "finished_with_gaps",
  "stop_reason": "missing next page without passing end check at https://us.chantelle.com/list"
}
```

- `site` is the configured hostname. `locale` is the preview page's observed HTML `lang`,
  or null; it is language evidence, not proof of market, currency or shipping destination.
- `started_utc` is the saved run start time, or null for an unstarted preview.
  `exported_utc` records this export's UTC time; `extension_version` comes from the installed
  extension manifest. The background export handler supplies both to the report builder;
  direct callers that omit export context receive null values instead of invented provenance.
- `listings` contains successfully inspected, accepted listing pages. `url` is the queued
  URL and `final_url` the inspected page URL. Unexpected redirects retain the existing
  stop behavior, with the reason recorded rather than accepting redirected page evidence.
- Product URLs are absolute, restricted to the configured host, deduplicated per listing,
  and stripped of fragments. Query strings remain intact. `card_text` collapses whitespace
  in the nearest `.product-card`, `[data-testid="ProductCard"]`, or `article` ancestor,
  falling back to the anchor text. Missing text is the empty string.
- `next_url` is the next link or null. `end_check.observed` is null or the existing
  `{type:"explicit",present}`, `{type:"page-count",current,total}`, or
  `{type:"result-total",total}` observation. `passed` means that the configured end check
  passed on a page with no next link. It is not inferred from missing pagination alone.
- Totals count accepted listing pages and **globally unique** discovered product URLs,
  not card occurrences. Export contains no HTML markup, product capture records, scope
  labels or per-seed accounting. Python ingestion remains separate work.

## Lazy gallery capture

For `product.lazyLoad` configs, manual, page-load and takeover capture scroll pending
configured image elements into view, wait for every image to match the configured URL
pattern and have no `--blurring` ancestor, then rescan image discovery. Readiness is bounded
to eight seconds and reports the ready/total shortfall instead of accepting a partial
gallery. Scroll position is restored. Non-lazy configurations and the ordinary toolbar
retain their existing behavior. No mouse events are synthesized.
Selected image URLs and their panel checkbox mapping survive capture-triggered rescans;
Lazy site capture uses the same stable `src` attribute preferred by readiness, falling back
to `currentSrc` only when `src` is absent/empty. This avoids viewport-dependent srcset URLs
and preserves the configured `/w=1024` to `/w=2048` high-resolution transform. Stale `data-src`
does not override this source.

Offline Chromium fixtures cover IntersectionObserver-only loading, installed extension listing
discovery, and fixed-queue import/reuse/capture. The user reports successful live listing discovery
in Windows Chrome (Bras: 9 pages / 496 product URLs; Panties: 9 pages / 464) and successful product
capture without hovering. These prior live checks are **passed per user report**, not independently
repeated here. The new fixed-queue capture workflow has offline fixture coverage; it has not yet
been verified live. No new positive end selector or market-wide completeness claim was added.
