// Paste once in DevTools on the Triumph smoke PDP after it has loaded.
// Read-only: no clicks, DOM writes, storage, fetches, navigation or image loading.
// URL query/fragment values and credentials are omitted from the printed JSON.
(() => {
  const selector = '#js-main-slider .swiper-slide:not(.swiper-slide-duplicate) img';
  const urlInfo = raw => {
    if (!raw) return {form: 'empty'};
    if (typeof raw !== 'string') return {form: 'invalid-type'};
    raw = raw.trim();
    const form = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? 'absolute' : raw.startsWith('//') ? 'protocol-relative' : raw.startsWith('/') ? 'root-relative' : 'path-relative';
    try {
      const u = new URL(raw, document.baseURI);
      return {form, url: ['http:', 'https:'].includes(u.protocol) ? `${u.protocol}//${u.host}${u.pathname}` : '[non-http URL]',
        hasQuery: !!u.search, hasFragment: !!u.hash, hasCredentials: !!(u.username || u.password)};
    } catch { return {form, invalid: true}; }
  };
  const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : '[missing/invalid]';
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  let invalidJson = 0;
  const parsed = scripts.map(n => { try { return JSON.parse(n.textContent); } catch { invalidJson++; return null; } });
  const products = parsed.filter(p => p?.['@type'] === 'Product');
  const images = [...document.querySelectorAll(selector)];
  const report = {
    page: urlInfo(location.href), base: urlInfo(document.baseURI), documentReadyState: document.readyState,
    visibility: document.visibilityState, hasFocus: document.hasFocus(),
    canonical: urlInfo(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
    pageSelectorCount: document.querySelectorAll('#js-main-slider').length,
    selector, matchingImages: images.length,
    allMainSliderImages: document.querySelectorAll('#js-main-slider img').length,
    duplicateSlides: document.querySelectorAll('#js-main-slider .swiper-slide-duplicate').length,
    jsonLd: {scripts: scripts.length, invalidJson, topLevelProducts: products.length,
      products: products.map(p => ({url: urlInfo(p.url), sku: safeId(p.sku), productID: safeId(p.productID),
        hasName: !!p.name, hasBrandName: !!p.brand?.name, hasCategory: !!p.category,
        currencyJPY: p.offers?.priceCurrency === 'JPY',
        positiveIntegerPrice: /^\d+(?:\.0+)?$/.test(String(p.offers?.price)) && Number(p.offers?.price) > 0}))},
    images: images.map((n, i) => ({index: i + 1, src: urlInfo(n.getAttribute('src')),
      resolvedSrc: urlInfo(n.src), currentSrc: urlInfo(n.currentSrc), dataSrc: urlInfo(n.getAttribute('data-src')),
      hasSrcset: !!n.getAttribute('srcset'), hasDataSrcset: !!n.getAttribute('data-srcset'),
      loading: n.loading, complete: n.complete, naturalWidth: n.naturalWidth, naturalHeight: n.naturalHeight}))
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
