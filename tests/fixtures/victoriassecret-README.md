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
