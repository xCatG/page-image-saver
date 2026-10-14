# Shirohato saved-page evidence (2026-10-14)

Source: owner-saved Webpage, Complete HTML in
`/mnt/nas_data/lingerie_trends/catalog-runs/shirohato-pages-20261014/`.
`shirohato-expected.json` records original filenames and SHA-256, canonical URL,
Product JSON-LD observations, colors, size text, gallery names and listing totals.
The fixtures retain only public product facts/specification rows, the main gallery,
and listing cards/pager. Account forms, viewstate, tokens, trackers, recommendations,
reviews, styles and executable scripts are omitted. Product JSON-LD is inert data.

Chrome rewrote gallery image URLs to local filenames. **Test-only restoration**
uses the directory of that page's explicit JSON-LD primary image
(`https://img.wakudoki.ne.jp/Contents/ProductImages/0/`) with the unchanged saved
`_LL.jpg` basename. This directory mapping is an inference from the primary image,
not proof of each live URL or a network validation. Production never performs
that restoration: it accepts only existing absolute gallery `_LL.jpg` URLs for
this exact product on the retailer/CDN. The original saved filenames, gallery
ordering and color labels independently establish the expected membership;
Swiper's duplicated first/last slides are ignored. No thumbnails or recommendation
images enter the gallery. Main-image URL is independently evidenced in JSON-LD.

No selected color is evidenced in the saved PDPs. All gallery color labels are
retained as supplemental evidence. Size text is the offered specification range,
not a selection or availability assertion. The capture envelope remains v1 with
only name, sku, product_id, color and offers in its product object; carried brand
and category remain in product.json JSON-LD, colors/size in microdata. Supplemental
microdata also carries verified sku, productID and canonical url so the importer
can independently bind these options to the selected product before retaining them.

## Saved PDP audit

| Product ID | Carried brand | Category | JPY | Original gallery images | Color labels |
|---|---|---|---:|---:|---|
| c6510226179ef | Triumph／トリンプ | ワイヤーブラ | 7260 | 14 | VL-バニラ, LBU-薄ブルー |
| c2226hm038gb | HIMICO／ヒミコ | ガーターベルト | 2860 | 19 | BU-ブルー, SP-サーモンピンク, SX-サックス |
| c2226hm038br | HIMICO／ヒミコ | ワイヤーブラ | 4840 | 27 | BU-ブルー, SP-サーモンピンク, SX-サックス |
| c2226hm038ts | HIMICO／ヒミコ | Tバック・Gスト | 2640 | 20 | BU-ブルー, SP-サーモンピンク, SX-サックス |
| c2226hm038ns | HIMICO／ヒミコ | スタンダード | 2640 | 18 | BU-ブルー, SP-サーモンピンク, SX-サックス |
| mcp8003 | Mon cher pigeon／モンシェルピジョン | ガーターベルト | 2200 | 22 | OW-オフホワイト, PU-パープル, DNV-濃ネイビー |
| 40kb2060ab | Wing／ウイング | ワイヤーブラ | 3630 | 23 | IV-アイボリー, PI-ピンク, NV-ネイビー, LPU-薄パープル, OC-オークル, LPI-薄ピンク, YE-イエロー, SKY-スカイブルー, LBE-薄ベージュ, ME-メロン |
| 40btj443gi | Salute／サルート | ワイヤーブラ | 11550 | 16 | IV-アイボリー, SKY-スカイブルー, DNV-濃ネイビー, LPI-薄ピンク |
| 40ptj743llw3 | Salute／サルート | スタンダード | 5390 | 14 | IV-アイボリー, SKY-スカイブルー, DNV-濃ネイビー, LPI-薄ピンク |
| 40btj743gw2 | Salute／サルート | ワイヤーブラ | 11550 | 16 | IV-アイボリー, SKY-スカイブルー, DNV-濃ネイビー, LPI-薄ピンク |
| 40btj448df | Salute／サルート | ワイヤーブラ | 14080 | 10 | SX-サックス, BK-ブラック, IV-アイボリー |
| 40pxb178ml | Wacoal／ワコール | スタンダード | 3080 | 23 | CR-クリーム, PU-パープル, SP-サーモンピンク, TU-ターコイズ, BE-ベージュ, YE-イエロー, GY-グレー, RE-レッド, WH-ホワイト, GG-グレージュ, ME-メロン, BGY-ブルーグレー, RP-ロマンピンク, BR-ブラウン, SX-サックス |

## Saved listing audit

| Listing | Cards | Visible range | Total | Next page |
|---|---:|---|---:|---|
| shirohato-listing-three-quarter.html | 60 | 1件～60件 | 1204 | 2 |
| shirohato-listing-triumph.html | 60 | 1件～60件 | 776 | 2 |
| shirohato-listing-wacoal.html | 60 | 1件～60件 | 1164 | 2 |
| shirohato-listing-bra.html | 60 | 1件～60件 | 1993 | 2 |
| shirohato-listing-bra-p2.html | 60 | 61件～120件 | 1993 | 3 |

Saved listing URLs retain their original `?bid=<number>` evidence in the oracle.
Discovery removes only that single numeric brand-navigation query before queuing
the PDP; variant/unknown or repeated query keys remain unchanged and fail strict
canonical binding. Bound capture regression uses the saved `40btj448df` link and
its independently saved queryless PDP canonical.

No final listing page was saved. Browser tests assert all five observed pages;
a synthetic end-check test verifies that 120 observed bra URLs cannot complete a
1,993-product listing and that changing totals fail. A future live run may pause
on changed totals or URL duplicates; do not weaken the completion check to force
success.

TR635 HTML is present. notes.txt, terms and robots snapshots remain missing;
this does not block offline implementation. Owner smoke should use Triumph
`c6510226179ef` (bra), Wacoal `40pxb178ml` (brief) and HIMICO `c2226hm038gb`
(garter). No live capture, catalog completeness, or receiver deployment is claimed.

Validation: `npm test`; `uv run --with playwright python tests/shirohato_browser.py`
and `uv run --with playwright python tests/saved_page_fixtures.py`.
All browser page/CDN requests are fulfilled locally by the existing harness.
`PIS_SHIROHATO_EXPORT=<local-folder>` optionally retains the real production
capture/export output for offline receiver compatibility checks; images in that
artifact are explicitly synthetic one-pixel PNGs, never archived product images.
