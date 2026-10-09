# Victoria's Secret / PINK rendered fixtures

Small scrubbed excerpts of owner Chrome saves from
`/mnt/nas_data/lingerie_trends/catalog-runs/victoriassecret-fixtures/` (2026-10-09).
Each HTML header records the original saved HTML SHA-256. No live pages were loaded.

Preserved canonical links; primary title, generic SKU when present, price, selected
colour and primary-gallery image elements; product JSON-LD. Additional `meta content`
entries retain exact image URL strings found in the original saved HTML (including
bare-host JSON-LD URLs) to resolve Chrome's rewritten `_files/` paths offline.
No dimensions, image filenames or original image paths are invented. Unrelated
script code, account/location UI and most surrounding page markup were omitted.

- Wave Stripe Peekaboo Demi: Black, $64.95, ID 1128847700, 3 photos.
- Viper Embroidery Peekaboo Halter Demi: Black, $64.95, ID 1128847600, 3 photos.
- PINK Wink Push-Up Balconette: Rose Taupe, $49.95, ID 5000009521, 5 photos.
- PINK Wink Push-Up Balconette: Sheer Blue, $49.95, ID 5000009521, 4 photos.

Rose and Blue have distinct generic/choice canonical paths despite sharing the
parent product ID. JSON-LD alone lacks selected colour; PINK saves require rendered
DOM facts. No complete saved VS panty HTML was present, so that family remains an
owner smoke-test obligation. The gallery resolver selects the widest evidenced
same-filename rendition and rejects missing/foreign/query-bearing original evidence.

`victoriassecret-adaptive.html` is a scrubbed excerpt of the owner's October 9
Adaptive Ganache save (source SHA-256 in its header). It retains the actual
primary-gallery markup including the adaptive badge, five images, canonical
choice-33F6 URL, selected Ganache label, product facts, and five evidenced URLs.
Four photo URLs use `/tif/`; the digitally rendered front uses `/png/`. The path
segment is retained as evidenced; the delivered filename still ends in `.jpg`.
Scripts, cookies, recommendation images and account content are omitted.
`victoriassecret-apostrophe-urls.json` contains the five failed URLs from the
owner's 2026-10-09T07-50-04-269Z run report, without other run data.
