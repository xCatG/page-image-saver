# Shirohato 1.0.14 smoke: confirmed ProductSubImages rejection

The owner's three-product smoke failed before any capture with gallery-readiness
timeouts. The returned live probe on Triumph `c6510226179ef` identifies the cause:

- One recognized slider, one matching Product JSON-LD, matching canonical and JPY.
- All 14 selected image sources were absolute HTTPS on `img.wakudoki.ne.jp`,
  without query/fragment; loaded at 1200×1200.
- Images 1–3 use `/Contents/ProductImages/0/` (primary and `-cfNN` images).
- Images 4–14 use `/Contents/ProductSubImages/0/c6510226179ef_sub01_LL.jpg`
  through `_sub11_LL.jpg`.

The old gallery validator accepted only `ProductImages`. Image 4 rejected the
entire gallery on every readiness poll. Polling suppressed the extraction error
and eventually reported a generic timeout. This was not a size, focus, lazy-load,
canonical or slider-selection failure on the probed page.

## 1.0.15 fix

Keep the existing primary-image rule and additionally accept exactly
`/Contents/ProductSubImages/0/<current-product-id>_sub<digits>_LL.jpg`.
Keep the HTTPS/retailer-CDN host restrictions, credential/port/query/fragment
checks, current-product identity and original-image suffix. Wrong products,
other subimage directories, thumbnails and non-numbered subimage names fail.
Do not construct, rewrite or guess URLs: retain the accepted DOM source verbatim.
Selectors, timing, selected-colour behavior and capture format are unchanged.
The timeout also retains the last Shirohato condition and image index without
printing raw URL values. The read-only owner probe remains available for future
diagnosis, but no additional probe is needed to implement this fix.

## Saved-page audit and fixture correction

The 17 saved HTML pages comprise 12 PDPs and five listings. Chrome rewrote gallery
URLs to local filenames. Initial fixtures incorrectly inferred `ProductImages`
for every gallery image from the primary JSON-LD directory. Correct the Triumph
fixture and oracle using the returned live paths: 3 primary +11 subimages.

The 12 saved PDP galleries have primary `_LL`, colour `-cfNN_LL` (Mon cher pigeon
uses `-czNN_LL`), and numbered `_subNN_LL` filenames. Wacoal smoke `40pxb178ml`
has 7 numbered subimages; HIMICO smoke `c2226hm038gb` has 15. Both fit the same
new exact subimage pattern. The `-czNN` primary family is already accepted by the
existing primary rule; no extra allowance is needed. Filenames alone cannot
prove original directories, so the other saved fixtures' directory restoration
remains explicitly inferred. No live Wacoal/HIMICO directory observation is
claimed, and no runtime URL restoration is introduced.

## Tests and ingestion compatibility

Before the fix, three Node regressions failed and the corrected owner-probed
browser fixture reproduced `image 4 is not a current-product original` followed
by the readiness timeout. After the fix, all 260 Node tests, five Shirohato browser
tests and 21 existing browser tests pass. Strict negative cases cover unrelated
IDs, wrong directories, malformed/non-numbered subimage filenames, thumbnails,
queries/fragments, unsafe origins and relative URLs.

The real extension capture/export of the corrected Triumph fixture passes
unchanged through the `lingerie_trends` receiver, already-captured check, indexer,
view and media-inventory publication in temporary local roots. All 14 URLs retain
their exact spelling, including 11 ProductSubImages; brand, JP/JPY, sizes/colours
and URL identity remain intact. Test image bytes are synthetic one-pixel PNGs.
The importer validates generic HTTP(S) evidence URLs; neither its validator nor
the Shirohato adapter restricts these directory families. No importer change or
second PR is needed.

All test browser requests are fulfilled locally. No Linux retailer/CDN requests,
owner Chrome/loaded checkout edits, NAS writes, or production receiver changes.
A successful owner-browser rerun has not yet been observed; the confirmed
validation failure is fixed and reproduced offline.
