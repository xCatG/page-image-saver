# Skarlett Blue offline fixtures

Trimmed from nine owner-saved HTML pages under the explicitly supplied
`catalog-runs/scarletblue-fixtures/` (spelling intentional), 2026-10-22.
`skarlettblue-expected.json` maps each excerpt to its original filename and SHA-256.
No storefront/CDN requests were made. Scripts other than JSON-LD, SVGs, large
listing images, forms and incidental attributes were removed. Gallery trees retain
hidden slides, video entries, thumbnail links and lazy-image attributes; an outside
product-card image remains as a negative control. Main-product ancestry is retained.

Pages 7 and 8 are `/collections/bras` pages 1 and 2. Each has exactly 50 title/card
links; their sets are disjoint, so 100 observed cards fit the displayed total of 163
and four numbered pages (pages 3/4 were not supplied). Off-grid product links and
multiple links within cards remain, to catch broad discovery selectors. Production
discovery normalizes collection-scoped card URLs to direct `/products/` URLs,
matching the saved PDP canonicals; the browser test covers the discovery output
and strict PDP binding, including rejection of unrelated/foreign links.

PDPs 0–6 yield respectively 6, 4, 4, 4, 36, 46 and 5 unique image-anchor URLs.
The two Entice saves expose several colours in the same gallery; other saves mark
sibling-colour slides hidden. The selector excludes hidden slides, video posters,
thumbnail copies and off-gallery cards. Anchor hrefs carry the original image URL
even when `img` only has `data-manual-src`. The configured width 1500 matches saved
source dimensions; this is not proof of a larger original rendition.

The saved structured data is `ProductGroup`, not a top-level `Product` understood
by the current generic extractor. Existing metadata extraction retains the title;
price, SKU and selected colour may be null. Do not infer colour purity from the URL
or claim complete structured facts. The Shopify feed separately supplies vendor,
variants and images; it is whole-store evidence, not a capture scope decision.

Run `npm test` and `uv run --with playwright python tests/skarlettblue_browser.py`.
The browser harness intercepts every request locally, including document loads.
