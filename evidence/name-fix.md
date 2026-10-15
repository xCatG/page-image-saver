# Bravissimo trailing product names (1.0.20)

The 2026-10-15T06-23-52-008Z run recorded three HTTP 400 completion failures:

- https://www.bravissimo.com/us/products/boost-me-up-lace-bra-ck202/
- https://www.bravissimo.com/us/products/magdalena-t-shirt-bra-fa358/
- https://www.bravissimo.com/us/products/silicone-nipple-covers-yb116/

Read-only incomplete evidence under `catalog-capture/www.bravissimo.com/captures/evidence/`:

| Product | Evidence identity / attempt | Raw styleName (JSON notation) |
| --- | --- | --- |
| CK202 | 34ba600286e7d74a71a5ce565fec452d / 1bfaba9bcc6b8599 | `"Boost Me Up Lace Bra "` |
| FA358 | 7524b5cfbfd15e2cf2ee958cd3dbb007 / f67fe977f2f9a290 | `"Magdalena T Shirt Bra "` |
| YB116 | d6a798cc04fb452108960f74ad76d2d6 / f1d3e4e2d14df579 | `"Silicone Nipple Covers "` |

Each incomplete product.json selects `fact_source: microdata`. Both its facts.name and microdata.name retain the final ASCII space. `gold_set._check_product_envelope` calls `_check_product_source(..., trim=True)`, which strips microdata evidence before comparing against claimed facts. The untrimmed claim therefore disagrees. JSON-LD variant names differ too, but JSON-LD is not the selected source and does not cause these failures.

Trim the current dataLayer styleName when emitting Bravissimo facts; the synthesized microdata name derives from those facts. Product identity, brand, currency, selected color, and gallery checks remain unchanged. Receiver validation stays unchanged. The catalog importer separately needs to compare against trimmed saved names when processing future retry captures (coordinated with lingerie_trends scope work).

Fixtures contain allowlisted public dataLayer product fields, public JSON-LD and a minimal DOM reconstructed from each saved page; no original page scripts, state, account/session data or full raw HTML are copied. Images in export tests are synthetic PNGs. Every browser request is fulfilled locally.

Regression evidence:

- Before fix: focused Node tests report precisely 3 failed name assertions; production capture export fails the unchanged receiver envelope check with `completion product name differs from saved product evidence`.
- After fix: 17 focused Node tests pass; all 314 Node tests pass (`node --test --test-isolation=none`).
- All 5 Bravissimo browser tests pass, including 10 saved product extractions and six production exports (three existing smoke products plus the three failures), checked through unchanged `_check_product_envelope` and full `_validate_capture_record` including image decoding.

Browser command from this extension checkout (requires sibling lingerie_trends on PYTHONPATH and a Python environment with Playwright):

```sh
UV_CACHE_DIR=/tmp/uv-bravissimo-name PYTHONPATH=/home/yenchi/src/lingerie_trends uv run --offline --no-project --python /home/yenchi/.pyenv/versions/3.12.12/bin/python tests/bravissimo_browser.py
```

Chromium and Node localhost server tests require the ordinary local socket permissions blocked in the restricted sandbox. No retailer/CDN network was used. Actual temporary production exports are available at `/tmp/bravissimo-name-fix-exports/PageImageSaver/` for the coordinated importer regression.
