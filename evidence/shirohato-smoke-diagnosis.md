# Shirohato 1.0.14 smoke: root cause not yet determined

The owner run `2026-10-14T23-53-22-539Z-run.json` records three attempts per
product, all failing `automatic product gallery readiness timeout`, and zero
captures. The exact live gallery attributes were not included in that report.

## What the code requires

`inspectTakeoverPage` first calls `capturePageProduct` (strict Shirohato Product
JSON-LD, canonical/URL/productID/SKU, JP/JPY binding). It recognizes the product
using `#js-main-slider`, then polls gallery extraction every 200 ms for 8 seconds.
A gallery must contain at least one URL and **every** selected image must pass:

- Selector: `#js-main-slider .swiper-slide:not(.swiper-slide-duplicate) img`.
- Read the literal `getAttribute('src')`, not resolved `img.src`, `currentSrc`,
  `data-src`, or srcset.
- `new URL(raw)` without a base: relative and protocol-relative forms fail.
- HTTPS `img.wakudoki.ne.jp` or `www.wakudoki.ne.jp`, no credentials, nondefault
  port, query or fragment; `/Contents/ProductImages/0/`, current product filename
  with an `_LL.jpg` suffix. One invalid image rejects the entire gallery.

There is no image-size, `naturalWidth`, `complete`, focus or visibility condition.
`lazyLoad` is false in this config. Initial missing/invalid JSON-LD would throw its
own product error before this gallery wait. This run's timeout therefore shows
that initial product binding/slider recognition succeeded but no poll produced
an accepted gallery; it does not establish which gallery check failed.

## Saved evidence and its limit

All three owner saves still match the source hashes recorded in the fixtures:

| Product | Slider roots | Selected images | `loading=lazy` | `data-src` |
| --- | ---: | ---: | ---: | ---: |
| Triumph `c6510226179ef` | 1 | 14 | 2 | 0 |
| Wacoal `40pxb178ml` | 1 | 23 | 15 | 0 |
| HIMICO `c2226hm038gb` | 1 | 19 | 3 | 0 |

Each canonical is the expected `/productdetail/<id>/1/` URL and each saved
Product has the matching identity and JPY offer. Saved productdetail.js initializes
Swiper on the same slider root; that does not prove the failed run's DOM state.

**Chrome rewrote every selected `src` to a local `./…_files/…_LL.jpg` path.** The
existing scrubbed tests restore absolute CDN paths using the primary JSON-LD
image directory, explicitly an inference. Those tests cannot distinguish whether
the live attribute was absolute, protocol-relative, root-relative, or different.
No original request was made to fill that gap. Missing matches, an alternate URL
form, and another rejected live gallery entry remain distinguishable hypotheses.
Do not change selectors, enable scrolling, normalize URLs or weaken validation
until the live evidence identifies the condition.

## Minimal owner action

On `https://www.wakudoki.ne.jp/productdetail/c6510226179ef/1/`, after loading,
paste `evidence/owner-probe.js` into DevTools Console and return its JSON output.
No extension update or smoke rerun is needed for this probe. It reads only the
readiness-relevant DOM: selector counts, redacted source forms/resolved URLs,
load dimensions, canonical and Product JSON-LD field checks. It makes no requests,
clicks, DOM/storage writes or navigation. Query/fragment values and credentials
are omitted. One PDP is sufficient to identify the next implementation step.

## Diagnostics-only 1.0.15

The readiness timeout now retains the last Shirohato extraction condition and
image index (without raw URL values). Gallery validation, retry duration, capture
format and acceptance remain unchanged. This improves the next failure report;
**it is not a claimed fix for the three live smoke failures**.

Tests reproduce diagnostic loss and cover a synthetic protocol-relative URL
on each of the three saved PDPs. That synthetic condition is a test case, not
live evidence. The probe is exercised against each DOM and checked for no DOM
mutation or disclosure of a query-value sentinel.
