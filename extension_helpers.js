(function(root) {
  'use strict';

  function filenameFromUrl(url, fallback) {
    if (!url || typeof url !== 'string') {
      return fallback || `image_${Date.now()}.jpg`;
    }

    try {
      const pathname = new URL(url).pathname;
      const name = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1))
        .split('?')[0].split('#')[0].replace(/[\/\\]/g, '_');
      if (name) return name;
    } catch (e) {
      // Fall through for relative or malformed URLs.
    }

    const parts = url.split('/');
    const name = parts[parts.length - 1].split('?')[0].split('#')[0].replace(/[\/\\]/g, '_');
    return name || fallback || `image_${Date.now()}.jpg`;
  }

  function getScrollStep(viewportHeight) {
    return viewportHeight > 0 ? viewportHeight : 500;
  }

  function getSafeCanvasSize(totalWidth, totalHeight, dpr, maxCanvasEdge = 16384, maxCanvasPixels = 67108864) {
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const width = Math.round(totalWidth * safeDpr);
    if (!Number.isFinite(width) || width < 1 || width > maxCanvasEdge) {
      throw new Error(`Full-page screenshot canvas width exceeds the supported ${maxCanvasEdge}-pixel limit. Use visible-area capture instead.`);
    }
    const height = Math.round(totalHeight * safeDpr);
    if (!Number.isFinite(height) || height < 1 || height > maxCanvasEdge) {
      throw new Error(`Full-page screenshot canvas height exceeds the supported ${maxCanvasEdge}-pixel limit. Use visible-area capture instead.`);
    }
    if (width * height > maxCanvasPixels) {
      throw new Error('Full-page screenshot canvas pixel area exceeds the supported limit. Use visible-area capture instead.');
    }
    return { width, height };
  }

  function* getElementsForFixedCheck(node, seen = new WeakSet()) {
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (!current || current.nodeType !== 1 || seen.has(current)) continue;
      seen.add(current);
      yield current;
      if (current.children) {
        for (let i = current.children.length - 1; i >= 0; i--) {
          stack.push(current.children[i]);
        }
      }
    }
  }

  function buildCaptureVisibleTabResponse(lastError, dataUrl) {
    if (lastError) {
      return { error: lastError.message || 'captureVisibleTab failed' };
    }
    if (dataUrl) {
      return { dataUrl };
    }
    return { error: 'Failed to capture screenshot' };
  }

  /** Keep user folder paths relative while preserving Unicode and safe subfolders. */
  function sanitizeFolderPath(name) {
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
    return String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .map(part => {
        let safe = part.replace(/[<>:"|?*\x00-\x1f]/g, '_')
          .replace(/^[. ]+|[. ]+$/g, '')
          .substring(0, 100);
        if (reserved.test(safe)) safe = '_' + safe;
        return safe;
      })
      .filter(Boolean)
      .join('/')
      .substring(0, 240);
  }

  /** Match the page-level shortcut used when automation cannot reach Chrome's toolbar. */
  function isFindImagesPageShortcut(event) {
    const target = event.target || {};
    const tag = (target.tagName || '').toUpperCase();
    return event.key?.toLowerCase() === 'i'
      && event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey
      && !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  }

  function captureProductFromJsonLd(scriptTexts) {
    const empty = {name: null, sku: null, product_id: null, color: null,
      offers: {price: null, currency: null}};
    const candidates = [];
    function collectProducts(value) {
      if (Array.isArray(value)) {
        for (const item of value) collectProducts(item);
      } else if (value && typeof value === 'object') {
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some(type => typeof type === 'string' && /(^|\/)Product$/i.test(type)))
          candidates.push(value);
        if (value['@graph']) collectProducts(value['@graph']);
      }
    }
    for (const script of scriptTexts) {
      let parsed;
      try { parsed = JSON.parse(script); } catch (_) { continue; }
      collectProducts(parsed);
    }
    const raw = candidates.find(item => {
      const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      return item.name && offer?.price != null && offer?.priceCurrency;
    }) || candidates[0];
    if (!raw) return empty;
    const offer = Array.isArray(raw.offers) ? raw.offers[0] : raw.offers;
    const text = value => value == null ? null : String(value);
    return {name: text(raw.name), sku: text(raw.sku), product_id: text(raw.productID),
      color: text(raw.color), offers: {price: text(offer?.price), currency: text(offer?.priceCurrency)}};
  }

  function captureProductEvidence(jsonld = [], microdata = null, meta = null) {
    const text = value => value == null || value === '' ? null : String(value).trim() || null;
    const jsonFacts = captureProductFromJsonLd(jsonld.map(value => JSON.stringify(value)));
    const microFacts = microdata ? {name: text(microdata.name), sku: text(microdata.sku),
      product_id: text(microdata.productID), color: text(microdata.color),
      offers: {price: text(microdata.offers?.price),
        currency: text(microdata.offers?.priceCurrency)}} : null;
    const metaFacts = meta?.['og:type']?.toLowerCase() === 'product' ? {
      name: text(meta['og:title']), sku: null, product_id: null, color: null,
      offers: {price: text(meta['product:price:amount']),
        currency: text(meta['product:price:currency'])}} : null;
    const hasFacts = facts => !!(facts && (facts.name || facts.sku || facts.product_id ||
      facts.color || facts.offers.price));
    const complete = facts => !!(facts?.name && facts.offers.price && facts.offers.currency);
    const sources = [['jsonld', jsonFacts], ['microdata', microFacts], ['meta', metaFacts]];
    const selected = sources.find(([, facts]) => complete(facts)) ||
      sources.find(([, facts]) => hasFacts(facts)) || ['meta', metaFacts || {
        name: null, sku: null, product_id: null, color: null,
        offers: {price: null, currency: null}}];
    return {format: 'page-image-saver-product-evidence/v1', fact_source: selected[0],
      facts: selected[1], jsonld, microdata, meta};
  }

  function captureIdentity(pageUrl, colorKey, selectedColor) {
    const url = new URL(pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('product URL must be HTTP(S)');
    url.hash = '';
    if (!['color', 'url'].includes(colorKey)) throw new Error('unknown color identity policy');
    const color = selectedColor == null ? null : String(selectedColor).trim();
    if (colorKey === 'color' && !color) throw new Error('selected color is required for this page');
    return {domain: url.hostname.toLowerCase(), product_url: url.href,
      selected_color: color || null, color_key: colorKey};
  }

  function captureIdentityKey(identity) {
    if (identity.color_key === 'url') {
      return {color_key: 'url', domain: identity.domain, product_url: identity.product_url};
    }
    if (identity.color_key === 'color' && identity.selected_color) {
      return {color_key: 'color', domain: identity.domain, product_url: identity.product_url,
        selected_color: identity.selected_color};
    }
    throw new Error('invalid capture identity key');
  }

  function captureUrlError(step, value, detail) {
    // Never include URL credentials, query secrets or large inline image payloads.
    const sample = String(value ?? '').replace(/(https?:\/\/)[^/]*@/gi, '$1[redacted]@')
      .split(/[?#]/)[0].slice(0, 120);
    return new Error(`${step}: ${detail}; input=${JSON.stringify(sample)}`);
  }

  // Opt-in site rule: retain only evidenced originals, never guess a path from a SKU.
  function resolveGalleryOriginal(raw, pattern, base, candidates = []) {
    const origin = new URL(base).origin;
    const re = new RegExp(pattern);
    const extract = value => {
      try {
        const url = new URL(value, base);
        if (url.origin !== origin || url.protocol !== 'https:') return null;
        let source = url.href;
        if (url.pathname.startsWith('/tco-images/')) {
          source = decodeURIComponent(source);
          // Proxy embeds either an absolute, protocol-relative or bare-host original.
          const hostPath = new URL(base).host + '/static/media/catalog/product/';
          const offset = source.indexOf(hostPath, origin.length);
          if (offset < 0) return null;
          source = 'https://' + source.slice(offset);
        }
        const match = source.match(re)?.[0];
        if (!match || source !== match || new URL(match).origin !== origin) return null;
        return new URL(match).href;
      } catch (_) { return null; }
    };
    const direct = extract(raw);
    if (direct) return direct;
    let local;
    try { local = new URL(raw, base); }
    catch (_) { throw captureUrlError('gallery original', raw, 'invalid URL'); }
    if (local.origin !== origin || !local.pathname.includes('_files/'))
      throw captureUrlError('gallery original', raw, 'no evidenced original URL');
    const filename = local.pathname.split('/').pop();
    const matches = new Set(candidates.map(extract).filter(url => url &&
      new URL(url).pathname.split('/').pop() === filename));
    if (matches.size !== 1) {
      const error = captureUrlError('gallery original', raw, 'missing or ambiguous original URL');
      error.unresolvedOriginal = true;
      throw error;
    }
    return [...matches][0];
  }

  // Manual saves only: preserve the selected proxy URL, grouping by evidenced original.
  function dedupeManualImages(images, pageUrl) {
    let page;
    try { page = new URL(pageUrl); } catch (_) { return images; }
    if (page.origin !== 'https://www.agentprovocateur.com') return images;
    const pattern = 'https://www\\.agentprovocateur\\.com/static/media/catalog/product/[^\\s"<>?#]+\\.(?:jpg|jpeg|png|webp)';
    const chosen = new Map();
    for (const image of images) {
      let key;
      try { key = resolveGalleryOriginal(image.url, pattern, page.href); }
      catch (_) {
        // Let the existing per-image processor handle unsupported/invalid sources.
        chosen.set(image, {image, area: 0});
        continue;
      }
      const dimensions = new URL(image.url, page.href).pathname.match(/^\/tco-images\/unsafe\/(\d+)x(\d+)\//);
      // Loaded images carry intrinsic dimensions. Lazy images carry DOM layout
      // dimensions, so prefer their explicit proxy size. 0x0 remains unknown.
      const dimension = (actual, proxy) => image.isLoaded === false
        ? Number(proxy) || Number(actual) || 0 : Number(actual) || Number(proxy) || 0;
      const width = dimension(image.width, dimensions?.[1]);
      const height = dimension(image.height, dimensions?.[2]);
      const area = width * height;
      if (!chosen.has(key) || area > chosen.get(key).area) chosen.set(key, {image, area});
    }
    return Array.from(chosen.values(), row => row.image);
  }

  function galleryNodeOriginal(node, config, doc) {
    const values = ['data-original', 'data-src'].map(name => node.getAttribute(name));
    for (const name of ['data-srcset', 'srcset']) {
      for (const entry of (node.getAttribute(name) || '').split(','))
        values.push(entry.trim().split(/\s+/)[0]);
    }
    values.push(node.getAttribute('src'), node.currentSrc);
    const evidence = Array.from(doc.querySelectorAll('img[src], meta[content]'),
      n => n.getAttribute('src') || n.getAttribute('content'));
    let error, unresolved;
    for (const raw of [...new Set(values.filter(Boolean))]) {
      try { return {url: resolveGalleryOriginal(raw, config.product.originalImageUrlPattern,
        doc.location.href, evidence)}; }
      catch (e) { error ||= e; if (e.unresolvedOriginal) unresolved = e; }
    }
    // A broken alternative candidate cannot poison a valid one. But a saved image
    // with missing/ambiguous original evidence must not silently disappear.
    if (unresolved) throw unresolved;
    return {url: null, error: error || captureUrlError('gallery original', '', 'empty image sources')};
  }

  function captureImageUrls(original, transform) {
    const url = new URL(original).href;
    let fetched = url;
    if (transform?.type === 'query-param') {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(transform.name) ||
          !/^[a-zA-Z0-9_-]+$/.test(transform.value)) {
        throw new Error('invalid query-param image transform');
      }
      const changed = new URL(url);
      changed.searchParams.set(transform.name, transform.value);
      fetched = changed.href;
    } else if (!transform || transform.type === undefined || transform.type === 'literal') {
      if (transform && (typeof transform.find !== 'string' || typeof transform.replace !== 'string')) {
        throw new Error('invalid literal image transform');
      }
      if (transform?.find) fetched = url.replace(transform.find, transform.replace);
    } else {
      throw new Error('unknown image transform type');
    }
    return {original_url: url, fetched_url: fetched};
  }

  async function waitForCaptureState(readState, previous, options = {}) {
    const now = options.now || Date.now;
    const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const start = now();
    const timeout = options.timeoutMs ?? 8000;
    const poll = options.pollMs ?? 150;
    let last = null;
    while (now() - start <= timeout) {
      const state = readState();
      const valid = state && typeof state.color === 'string' && state.color.trim()
        && Array.isArray(state.gallery) && state.gallery.length > 0 && state.colorConflict !== true;
      const colorChanged = previous && state && state.color !== previous.color;
      const galleryChanged = previous && state && JSON.stringify(state.gallery) !== JSON.stringify(previous.gallery);
      const coherent = !previous || (colorChanged && galleryChanged) ||
        (!colorChanged && (!galleryChanged || options.allowSameColorGalleryChange === true));
      if (valid && coherent) {
        if (last && last.color === state.color && JSON.stringify(last.gallery) === JSON.stringify(state.gallery)) {
          return state;
        }
        last = state;
      } else {
        last = null;
      }
      await delay(poll);
    }
    throw new Error('color/gallery transition timeout');
  }

  async function waitForAutoCaptureReady(readEvidence, options = {}) {
    const now = options.now || Date.now;
    const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const start = now();
    const timeout = options.timeoutMs ?? 8000;
    const poll = options.pollMs ?? 200;
    let productSeen = false;
    let galleryError = null;
    while (now() - start <= timeout) {
      const evidence = readEvidence();
      productSeen ||= evidence.productSeen === true;
      galleryError = typeof evidence.galleryError === 'string' ? evidence.galleryError : null;
      if (evidence.productSeen === true && options.prepare) {
        await options.prepare();
        return true;
      }
      if (evidence.productSeen === true && Array.isArray(evidence.gallery) && evidence.gallery.length > 0) return true;
      await delay(poll);
    }
    if (productSeen) throw new Error('automatic product gallery readiness timeout' +
      (galleryError ? `: ${galleryError}` : ''));
    return false;
  }

  async function recordCaptureFailure(chromeApi, url, error, at = new Date().toISOString()) {
    const reason = String(error?.message || error);
    return new Promise(resolve => chromeApi.storage.local.get({captureFailures: []}, result => {
      const failures = Array.isArray(result.captureFailures) ? result.captureFailures : [];
      failures.push({url, at, reason});
      chromeApi.storage.local.set({captureFailures: failures.slice(-100)}, () => {
        chromeApi.runtime.sendMessage({action: 'captureFailureNotice', reason}, () => {
          void chromeApi.runtime.lastError;
          resolve();
        });
      });
    }));
  }

  function buildCaptureCompletion(data) {
    return {schema_version: 1, format: 'page-image-saver-capture/v1',
      identity: data.identity, captured_at: data.captured_at, scope: data.scope,
      product: data.product, evidence: {html: data.html, jsonld: data.jsonld, images: data.images}};
  }

  async function captureSha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function captureImageExtension(bytes, contentType) {
    const starts = signature => signature.every((byte, index) => bytes[index] === byte);
    if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
    if (bytes.length >= 3 && starts([255, 216, 255])) return 'jpg';
    if (bytes.length >= 12 && starts([82, 73, 70, 70]) &&
        bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'webp';
    if (bytes.length >= 6 && starts([71, 73, 70, 56]) &&
        [55, 57].includes(bytes[4]) && bytes[5] === 97) return 'gif';
    if (bytes.length >= 12 && bytes[4] === 102 && bytes[5] === 116 &&
        bytes[6] === 121 && bytes[7] === 112 && bytes[8] === 97 &&
        bytes[9] === 118 && bytes[10] === 105 && [102, 115].includes(bytes[11])) return 'avif';
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const byType = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
      'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif'};
    if (byType[type]) return byType[type];
    throw new Error('unsupported fetched image format');
  }

  async function exportProductCapture(payload, io) {
    const encode = value => new TextEncoder().encode(value);
    const identityHash = await captureSha256(encode(JSON.stringify(captureIdentityKey(payload.identity)) + '\n'));
    const attempt = io.attemptId || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    if (!/^[a-f0-9]{16}$/.test(attempt)) throw new Error('unsafe capture attempt ID');
    const domain = payload.identity.domain;
    if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('unsafe capture domain');
    const base = `PageImageSaver/captures/${identityHash.slice(0, 32)}/${attempt}`;
    const html = encode(payload.html);
    const jsonld = encode(JSON.stringify(payload.jsonld));
    const htmlRef = {path: 'page.html', sha256: await captureSha256(html), bytes: html.byteLength};
    const jsonldRef = {path: 'product.json', sha256: await captureSha256(jsonld), bytes: jsonld.byteLength};
    await io.saveBytes(`${base}/${htmlRef.path}`, html);
    await io.saveBytes(`${base}/${jsonldRef.path}`, jsonld);
    const images = [];
    for (const [index, requested] of payload.images.entries()) {
      const fetched = await io.fetchImage(requested.fetched_url);
      const bytes = fetched.bytes instanceof Uint8Array ? fetched.bytes : new Uint8Array(fetched.bytes);
      if (!bytes.byteLength || bytes.byteLength > 100 * 1024 * 1024) throw new Error('invalid image byte count');
      const digest = await captureSha256(bytes);
      const extension = captureImageExtension(bytes, fetched.contentType);
      const path = `images/${index}.${extension}`;
      await io.saveBytes(`${base}/${path}`, bytes);
      images.push({path, sha256: digest, bytes: bytes.byteLength,
        original_url: requested.original_url, fetched_url: fetched.fetched_url || requested.fetched_url});
    }
    if (!images.length) throw new Error('no selected product images');
    const completion = buildCaptureCompletion({identity: payload.identity, captured_at: payload.captured_at,
      scope: payload.scope, product: payload.product, html: htmlRef, jsonld: jsonldRef, images});
    await io.saveBytes(`${base}/complete.json`, encode(JSON.stringify(completion)));
    return completion;
  }

  function validateReceiverSettings(settings) {
    if (settings?.enabled !== true) return {};
    const errors = {};
    try {
      const url = new URL(settings.url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
      const host = url.hostname.toLowerCase();
      const privateIp = /^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
      if ((!privateIp && host !== 'localhost' && !host.endsWith('.local')) ||
          url.pathname !== '/' || url.search || url.hash) {
        errors.url = 'URL invalid for captures: use a local receiver base URL (private IPv4, localhost, or .local host), without a path, query, or fragment.';
      }
    } catch (_) {
      errors.url = 'URL invalid: enter an http:// or https:// receiver address with a host (no embedded credentials).';
    }
    if (typeof settings.token !== 'string' || !/^[\x21-\x7e]+$/.test(settings.token)) {
      errors.token = 'Enter a receiver token containing only printable ASCII characters, without spaces.';
    }
    return errors;
  }

  async function testReceiverConnection(settings, io = {}) {
    const errors = validateReceiverSettings({...settings, enabled: true});
    if (Object.keys(errors).length) return {success: false, code: 'invalid', message: Object.values(errors).join(' ')};
    const target = new URL(settings.url).origin + '/v1/already';
    const originHelp = `Receiver --extension-origin must match this extension: ${io.origin}.`;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await (io.fetch || globalThis.fetch)(target, {
            method: 'POST', headers: {'Content-Type': 'application/json', 'X-Capture-Token': settings.token},
            // Deliberately invalid identity: authenticates but cannot match or publish a capture.
            body: JSON.stringify({identity: {}}), credentials: 'omit',
            referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal
          });
          if (response.status === 401) return {success: false, code: 'token_rejected', message: 'Receiver token rejected. Check the token in this form.'};
          if (response.status === 403) return {success: false, code: 'origin_rejected', message: `Receiver origin rejected. ${originHelp}`};
          const body = await response.json().catch(() => null);
          if (response.status === 400 && body?.error === 'invalid identity' && body.complete === false) {
            return {success: true, code: 'accepted', message: 'Receiver reachable and token accepted. No capture was written.'};
          }
          return {success: false, code: 'unexpected', message: `Unexpected receiver response (HTTP ${response.status}) at ${target}. Check the receiver address and service.`};
        })(),
        new Promise(resolve => {
          timer = setTimeout(() => {
            resolve({success: false, code: 'timeout', message: `Receiver timed out at ${target}. Check the address and service.`});
            controller.abort();
          }, io.timeoutMs ?? 10000);
        })
      ]);
    } catch (_) {
      // Fetch deliberately hides whether a failure was CORS or transport; do not invent a distinction.
      return {success: false, code: 'unreachable', message: `Receiver unreachable or blocked by CORS at ${target}. Check the address and service. ${originHelp}`};
    } finally {
      clearTimeout(timer);
    }
  }

  async function captureWithReceiver(payload, settings, io) {
    let url;
    try { url = new URL(settings.url); }
    catch (_) { throw captureUrlError('receiver URL', settings.url, 'invalid address; include http:// or https://'); }
    const host = url.hostname.toLowerCase();
    const privateIp = /^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!['http:', 'https:'].includes(url.protocol) || !privateIp && host !== 'localhost' &&
        !host.endsWith('.local') || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || !settings.token) {
      throw captureUrlError('receiver URL', settings.url, 'invalid local receiver URL or token');
    }
    const base = url.origin;
    const fetcher = io.fetch || globalThis.fetch;
    const delay = io.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const validTimestamp = value => typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(Date.parse(value));
    const validateReply = (endpoint, result, body, extraHeaders) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`invalid receiver ${endpoint} response`);
      }
      if (endpoint === 'already' && (typeof result.complete !== 'boolean' ||
          result.complete && !validTimestamp(result.captured_at))) {
        throw new Error('invalid receiver already response');
      }
      if (endpoint === 'evidence' && (result.sha256 !== extraHeaders['X-Content-SHA256'] ||
          result.bytes !== body.byteLength || !['stored', 'reused'].includes(result.status))) {
        throw new Error('invalid receiver evidence response');
      }
      if (endpoint === 'completion' && (!['published', 'reused'].includes(result.status) ||
          !validTimestamp(result.captured_at))) {
        throw new Error('invalid receiver completion response');
      }
      return result;
    };
    const request = async (endpoint, method, body, extraHeaders = {}) => {
      const replyType = endpoint.slice('/v1/'.length);
      let lastNetworkError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        let timeout;
        let response;
        let result;
        try {
          result = await Promise.race([
            (async () => {
              response = await fetcher(base + endpoint, {method, body,
                credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
                headers: {'X-Capture-Token': settings.token,
                  'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
                  ...extraHeaders}});
              let parsed;
              try {
                parsed = await response.json();
              } catch (error) {
                if (controller.signal.aborted || error?.name === 'AbortError') throw error;
                throw new Error('invalid receiver JSON response');
              }
              return parsed;
            })(),
            new Promise((_resolve, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                const error = new Error('receiver request timed out');
                error.name = 'AbortError';
                reject(error);
              }, io.timeoutMs ?? 10000);
            })
          ]);
        } catch (error) {
          if (response && !response.ok && (error instanceof TypeError || error?.name === 'AbortError')) {
            // Headers establish an HTTP rejection even when its diagnostic body stalls.
            result = {};
          } else {
            if (!(error instanceof TypeError) && error?.name !== 'AbortError') throw error;
            lastNetworkError = error;
            if (attempt === 2) break;
            await delay(200 * (attempt + 1));
            continue;
          }
        } finally {
          clearTimeout(timeout);
        }
        if (response.ok) return validateReply(replyType, result, body, extraHeaders);
        if (![408, 429].includes(response.status) && response.status < 500) {
          throw new Error(`receiver HTTP ${response.status}: ${result.error || 'rejected'}`);
        }
        if (attempt === 2) throw new Error(`receiver HTTP ${response.status}: ${result.error || 'transient failure'}`);
        await delay(200 * (attempt + 1));
      }
      const failure = new Error(`receiver transport unavailable: ${lastNetworkError?.message || 'network or redirect failure'}`);
      failure.receiverTransportFailure = true;
      throw failure;
    };
    try {
      const already = await request('/v1/already', 'POST', JSON.stringify({identity: payload.identity}));
      if (already.complete === true) {
        return {storage: 'receiver', status: 'already', captured_at: already.captured_at};
      }
      if (io.verifyOnly === true) return {storage: 'receiver', status: 'missing'};
      let publication = null;
      await exportProductCapture(payload, {
        attemptId: io.attemptId,
        fetchImage: io.fetchImage,
        saveBytes: async (filename, bytes) => {
          if (filename.endsWith('/complete.json')) {
            publication = await request('/v1/completion', 'POST', JSON.stringify({
              bundle: filename.slice(0, -'/complete.json'.length),
              record: JSON.parse(new TextDecoder().decode(bytes))
            }));
            return;
          }
          const digest = await captureSha256(bytes);
          await request('/v1/evidence', 'PUT', bytes, {
            'X-Capture-Path': filename, 'X-Capture-Domain': payload.identity.domain,
            'X-Content-SHA256': digest});
        }
      });
      return {storage: 'receiver', status: publication.status, captured_at: publication.captured_at};
    } catch (error) {
      if (io.verifyOnly === true) throw error;
      if (!error.receiverTransportFailure) throw error;
      const record = await io.download();
      return {storage: 'downloads', status: 'fallback', reason: 'receiver transport unavailable', record};
    }
  }

  function captureResultMessage(result) {
    if (result.storage === 'receiver' && result.status === 'already') {
      return 'Product already captured and verified on the local receiver.';
    }
    if (result.storage === 'receiver') {
      return 'Product saved to the local receiver. Run capture-index in WSL to update the viewer.';
    }
    if (result.status === 'fallback') {
      return 'Receiver transport unavailable; product bundle saved to Downloads. Run capture-import in WSL.';
    }
    return 'Local product bundle exported. Run capture-import to verify Downloads bytes.';
  }

  function saveCaptureDownload(chromeApi, dataUrl, filename, timeoutMs = 120000, options = {}) {
    return new Promise((resolve, reject) => {
      let id = null;
      let settled = false;
      const early = new Map();
      const timer = setTimeout(() => finish(new Error('capture download timeout')), timeoutMs);
      function finish(error, savedPath) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chromeApi.downloads.onChanged.removeListener(onChanged);
        if (error) reject(error);
        else resolve(savedPath);
      }
      function terminal(delta) {
        if (delta.state?.current === 'interrupted') {
          finish(new Error(`capture download interrupted: ${delta.error?.current || filename}`));
        } else if (delta.state?.current === 'complete') {
          chromeApi.downloads.search({id: delta.id}, items => {
            const savedName = items?.[0]?.filename?.replace(/\\/g, '/');
            const directory = filename.slice(0, filename.lastIndexOf('/'));
            const requestedName = filename.slice(filename.lastIndexOf('/') + 1);
            const savedDirectory = savedName?.slice(0, savedName.lastIndexOf('/'));
            const savedBase = savedName?.slice(savedName.lastIndexOf('/') + 1);
            const dot = requestedName.lastIndexOf('.');
            const stem = dot > 0 ? requestedName.slice(0, dot) : requestedName;
            const extension = dot > 0 ? requestedName.slice(dot) : '';
            const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const unique = new RegExp(`^${escape(stem)} ?\\(\\d+\\)${escape(extension)}$`);
            const sameDirectory = savedDirectory?.endsWith('/' + directory);
            const valid = options.allowUniquified
              ? sameDirectory && (savedBase === requestedName || unique.test(savedBase))
              : savedName?.endsWith('/' + filename);
            if (chromeApi.runtime.lastError || !valid) {
              finish(new Error(`capture download filename mismatch: expected ${filename}, got ${savedName || '<missing>'}`));
            } else {
              finish(null, options.allowUniquified ? `${directory}/${savedBase}` : filename);
            }
          });
        }
      }
      function onChanged(delta) {
        if (delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted') return;
        if (id === null) early.set(delta.id, delta);
        else if (delta.id === id) terminal(delta);
      }
      chromeApi.downloads.onChanged.addListener(onChanged);
      chromeApi.downloads.download({url: dataUrl, filename, saveAs: false, conflictAction: options.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify'}, downloadId => {
        if (chromeApi.runtime.lastError || !Number.isInteger(downloadId)) {
          finish(new Error(chromeApi.runtime.lastError?.message || 'capture download failed to start'));
          return;
        }
        id = downloadId;
        if (early.has(id)) terminal(early.get(id));
      });
    });
  }

  function buildGoldCaptureSettings(settings) {
    const current = settings || {};
    const local = current.local || {};

    return {
      ...current,
      s3: {
        ...(current.s3 || {}),
        region: '',
        bucketName: '',
        folderPath: '',
        accessKeyId: '',
        secretAccessKey: '',
        makePublic: false
      },
      r2: {
        ...(current.r2 || {}),
        accountId: '',
        bucketName: '',
        folderPath: '',
        useApiToken: false,
        accessKeyId: '',
        secretAccessKey: '',
        apiToken: '',
        makePublic: false
      },
      local: {
        ...local,
        enabled: true,
        subfolderPerDomain: true,
        saveJson: true,
        baseFolder: local.baseFolder || 'PageImageSaver'
      }
    };
  }

  async function prepareLazyGallery(config, doc, options = {}) {
    if (!config?.product?.lazyLoad) return;
    const selector = config.product.allImagesSelector || config.allImagesSelector;
    const pattern = new RegExp(config.product.imageUrlPattern || config.imageUrlPattern || '.');
    const deadline = Date.now() + (options.timeoutMs ?? 8000);
    const pollMs = options.pollMs ?? 100;
    const view = doc.defaultView;
    const position = [view.scrollX, view.scrollY];
    let images = [], ready = [];
    // Ready = a matching URL that has either finished loading or lost its placeholder state.
    // Chantelle leaves --blurring on some frames whose image has fully loaded.
    const original = img => galleryNodeOriginal(img, config, doc);
    const isReady = img => (config.product.originalImageUrlPattern
      ? !!original(img).url : pattern.test(img.getAttribute('src') || img.currentSrc || '')) &&
      ((img.complete && img.naturalWidth > 0) || !img.closest('[class*="--blurring"]'));
    try {
      do {
        images = Array.from(doc.querySelectorAll(selector));
        for (const img of images) {
          if (isReady(img)) continue;
          img.scrollIntoView({block: 'center', behavior: 'instant'});
          await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
          if (Date.now() >= deadline) break;
        }
        images = Array.from(doc.querySelectorAll(selector));
        ready = images.filter(isReady);
        // Give unresolved lazy frames the full deadline to acquire real URLs.
        // Only then may unusable candidates be skipped; none grant success alone.
        if (ready.length && ready.length === images.length) return;
        await new Promise(resolve => setTimeout(resolve, pollMs));
      } while (Date.now() < deadline);
      // The final poll sleep may cross the deadline, so evaluate skip eligibility here.
      images = Array.from(doc.querySelectorAll(selector));
      ready = images.filter(isReady);
      if (config.product.originalImageUrlPattern && ready.length &&
          images.every(img => isReady(img) || !original(img).url)) return;
      const failed = images.find(img => !isReady(img));
      const detail = config.product.originalImageUrlPattern && failed ? original(failed).error?.message : null;
      throw new Error(`Lazy gallery shortfall: ${ready.length}/${images.length} configured images ready (URL pattern and blur check)` +
        (detail ? `; ${detail}` : `; lazy src=${JSON.stringify(String(failed?.getAttribute('src') || '').slice(0, 120))}`));
    } finally {
      view.scrollTo({left: position[0], top: position[1], behavior: 'instant'});
    }
  }

  function canSaveShopifyFeed(config) {
    return config?.platform === 'shopify';
  }

  // Runs in the owner's content-script context, never in the service worker.
  async function collectShopifyFeed(config, pageUrl, io = {}) {
    if (!canSaveShopifyFeed(config)) throw new Error('Shopify site config required');
    const page = new URL(pageUrl);
    if (page.protocol !== 'https:' || page.hostname !== config.domain) throw new Error('Feed host mismatch');
    const prefix = page.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[0].replace(/\/$/, '') || '';
    const interval = config.takeover?.intervalMs ?? 10000;
    if (!Number.isFinite(interval) || interval < 0 || interval > 300000) throw new Error('Invalid site pacing interval');
    const sleep = io.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const fetchPage = io.fetch || globalThis.fetch.bind(globalThis);
    const report = {version: 1, host: page.hostname, prefix, fetched: [], pages: []};
    for (let n = 1; ; n++) {
      if (n > 1) await sleep(Math.max(3000, interval));
      const url = `${page.origin}${prefix}/products.json?limit=250&page=${n}`;
      const response = await fetchPage(url, {credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60000)});
      if (!response.ok) throw new Error(`Shopify feed stopped: HTTP ${response.status} at page ${n}; no retry`);
      if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') || ''))
        throw new Error(`Shopify feed stopped: non-JSON response or challenge at page ${n}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(data?.products) || data.products.length > 250)
        throw new Error(`Shopify feed stopped: invalid products page ${n}`);
      const sha256 = await captureSha256(bytes);
      if (report.fetched.some(row => row.sha256 === sha256))
        throw new Error(`Shopify feed stopped: repeated products page ${n}`);
      report.fetched.push({url, status: response.status, fetched_at: new Date().toISOString(),
        sha256, product_count: data.products.length});
      report.pages.push(data);
      io.progress?.(n, report.fetched.reduce((sum, row) => sum + row.product_count, 0));
      if (data.products.length < 250) return report;
    }
  }

  function takeoverStatusText(run, summary = {}, now = Date.now()) {
    const labels = {preview: 'Ready', running: 'Running', paused: 'Paused',
      complete: 'Finished', finished_with_gaps: 'Finished with gaps', stopped: 'Stopped'};
    let state = labels[run.status] || run.status;
    if (run.status === 'running' && !run.current && Number.isFinite(run.nextNavigationAt) && run.nextNavigationAt > now) {
      state = `Waiting — next navigation in ${Math.ceil((run.nextNavigationAt - now) / 1000)} s`;
    } else if (run.reason) state += ` — ${run.reason}`;
    return `${state} · Current URL: ${run.current?.url || 'none (between pages)'} · ` +
      `captured ${summary.productsCaptured || 0} · gone ${summary.gone || 0} · skipped ${summary.skipped || 0} · ` +
      `failed ${summary.failed || 0} · pending ${summary.pending || 0}`;
  }

  // Compare URL spelling without changing stored queue/receiver identities. Decode
  // each path segment once so encoded slashes and double encoding stay distinct.
  function comparableUrl(value) {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.split('/').map(segment =>
      encodeURIComponent(decodeURIComponent(segment)).replace(/[!'()*]/g,
        char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
    return url.href;
  }

  function sameDocumentUrl(actual, expected) {
    try { return comparableUrl(actual) === comparableUrl(expected); }
    catch (_) { return false; }
  }

  // VS may rename only the final merchandising slug. Never use this for
  // navigation/document binding or rewrite the queued receiver identity.
  function victoriasSecretSameProductChoice(actual, expected) {
    try {
      const a = new URL(actual), b = new URL(expected);
      const product = /^(\/us\/(?:vs|pink)\/(?:bras|panties)-catalog\/\d+\/-\/a\/generic-\d+-choice-[A-Za-z0-9]+)\/[^/]+\/?$/;
      const left = a.pathname.match(product), right = b.pathname.match(product);
      return a.origin === 'https://www.victoriassecret.com' && a.origin === b.origin &&
        !a.username && !a.password && !b.username && !b.password &&
        a.search === b.search && !!left && !!right && left[1] === right[1];
    } catch (_) { return false; }
  }

  // A regional fallback is a missing queued choice, never permission to capture its substitute.
  function victoriasSecretUnavailableChoice(expected, actual, alertText = '') {
    try {
      const a = new URL(actual), b = new URL(expected);
      const product = /^\/us\/(?:vs|pink)\/(?:bras|panties)-catalog\/\d+\/-\/a\/generic-(\d+)-choice-([A-Za-z0-9]+)\/[^/]+\/?$/;
      const left = a.pathname.match(product), right = b.pathname.match(product);
      if (a.origin !== 'https://www.victoriassecret.com' || a.origin !== b.origin ||
          a.username || a.password || b.username || b.password ||
          !left || !right || left[1] !== right[1]) return null;
      const unavailable = Array.from(alertText.matchAll(/Item unavailable in ([A-Za-z0-9]+)\b/g), m => m[1]);
      if (left[2] !== right[2]) return `choice unavailable in region: ${right[2]} → ${left[2]}`;
      if (unavailable.includes(right[2])) return `choice unavailable in region: ${right[2]}`;
    } catch (_) { /* Malformed/off-site identities retain the ordinary binding rejection. */ }
    return null;
  }

  // Read only the primary Magento gallery, never recommendation or swatch data.
  function liseCharmelGallery(scripts, pageUrl) {
    const base = new URL(pageUrl);
    if (base.origin !== 'https://www.lisecharmel.com' || !base.pathname.startsWith('/lc_us_en/'))
      throw new Error('LC gallery: wrong storefront');
    const galleries = [];
    for (const text of scripts) {
      let data;
      try { data = JSON.parse(text); }
      catch (_) {
        if (text.includes('mage/gallery/gallery')) throw new Error('LC gallery: malformed init');
        continue;
      }
      const gallery = data?.['[data-gallery-role=gallery-placeholder]']?.['mage/gallery/gallery'];
      if (gallery) galleries.push(gallery);
    }
    if (galleries.length !== 1 || !Array.isArray(galleries[0].data))
      throw new Error('LC gallery: missing or ambiguous primary init');
    const urls = new Set();
    for (const image of galleries[0].data) {
      if (image.type && image.type !== 'image') continue;
      let url;
      try { url = new URL(image.full); } catch (_) { throw new Error('LC gallery: missing full URL'); }
      if (url.origin !== base.origin || url.username || url.password || url.hash ||
          !url.pathname.startsWith('/media/catalog/product/'))
        throw new Error('LC gallery: invalid full URL');
      urls.add(url.href); // Preserve the evidenced full rendition, including its query.
    }
    if (!urls.size) throw new Error('LC gallery: no primary images');
    return [...urls];
  }

  function productEvidenceError(reason) {
    const error = new Error(reason);
    error.code = 'PRODUCT_EVIDENCE_INVALID';
    return error;
  }

  function vandeveldeProduct(data, pageUrl) {
    const url = new URL(pageUrl);
    const page = data?.props?.pageProps;
    const product = page?.product;
    const fail = reason => { throw productEvidenceError(`VDV product: ${reason}`); };
    if (!['www.primadonna.com', 'www.mariejo.com'].includes(url.hostname) ||
        url.protocol !== 'https:' || url.port || url.username || url.password) fail('invalid US page URL');
    if (page?.locale !== 'en-us') fail('locale is not en-us');
    if (!product || typeof product !== 'object') fail('missing product');
    if (!product.id) fail('missing id');
    if (!product.slugs?.en) fail('missing slugs.en');
    if (page.slug !== product.slugs.en) fail('page slug differs from product slugs.en');
    if (url.pathname !== `/en-us/p/${product.slugs.en}`) fail('URL differs from product slugs.en');
    if (!product.slugs.en.endsWith(`-${product.id}`)) fail('slugs.en product id mismatch');
    const price = product.retailPrice;
    const amount = price?.discountedPrice ?? price?.price;
    if (price?.currency !== 'USD') fail('retailPrice.currency is not USD');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) fail('invalid retailPrice amount');
    for (const field of ['name', 'commercialColor', 'styleCode'])
      if (typeof product[field] !== 'string' || !product[field].trim()) fail(`missing ${field}`);
    if (!Array.isArray(product.media) || !product.media.length) fail('missing primary gallery');
    const images = product.media.map(item => {
      let image;
      try { image = new URL(item.url); } catch (_) { fail('invalid media URL'); }
      if (!['images.ctfassets.net', 'media.lingeriestyling.com'].includes(image.hostname) ||
          image.protocol !== 'https:' || image.port || image.username || image.password || image.hash)
        fail('invalid media host');
      return item.url; // Preserve the original URL including any evidenced query parameters.
    });
    return {facts: {name: product.name, sku: product.styleCode, product_id: product.id,
      color: product.commercialColor, offers: {price: String(amount), currency: 'USD'},
      category: [product.rootCategory, product.category].filter(Boolean).join(' / ')}, images};
  }

  function liseCharmelListingProducts(cards) {
    const products = new Map();
    for (const card of cards) {
      const url = new URL(card.url);
      const local = url.origin === 'https://www.lisecharmel.com' && !url.username && !url.password;
      const alias = local && url.pathname.match(/^\/lc_us_en\/catalog\/product\/view\/id\/(\d+)\/s\/[^/]+\/(?:category\/\d+\/?)?$/);
      const direct = local && /^\/lc_us_en\/[^/]+\.html$/.test(url.pathname);
      const id = alias ? alias[1] : direct && /^\d+$/.test(card.product_id || '') ? card.product_id : null;
      const key = id ? `id:${id}` : `url:${card.url}`;
      const old = products.get(key);
      // Never synthesize a route or trim its category: keep an actual listing link.
      if (!old || (direct && !old.direct)) products.set(key, {card, direct});
    }
    return [...products.values()].map(({card}) => card);
  }

  // Bind structured facts to the actual JP PDP, never a recommendation or another market.
  function shirohatoProduct(jsonld, pageUrl, canonicalUrl) {
    const fail = reason => { throw productEvidenceError(`Shirohato product: ${reason}`); };
    const identity = (raw, label) => {
      let url; try { url = new URL(raw); } catch (_) { return fail(`${label}: invalid URL`); }
      const match = url.pathname.match(/^\/productdetail\/([a-z0-9]+)\/1\/$/);
      if (url.origin !== 'https://www.wakudoki.ne.jp' || url.username || url.password || !match)
        fail(`${label}: invalid JP product URL`);
      return match[1];
    };
    const id = identity(pageUrl, 'page');
    if (identity(canonicalUrl, 'canonical') !== id) fail('canonical product ID mismatch');
    const products = jsonld.filter(item => item?.['@type'] === 'Product');
    if (products.length !== 1) fail(`${products.length} Product nodes`);
    const p = products[0], offer = p.offers;
    if (identity(p.url, 'Product.url') !== id) fail('Product.url product ID mismatch');
    if (p.productID !== id) fail('productID mismatch');
    if (p.sku !== id) fail('sku mismatch');
    if (!p.name) fail('missing name');
    if (!p.brand?.name) fail('missing brand');
    if (!p.category) fail('missing category');
    if (offer?.priceCurrency !== 'JPY') fail('no JPY offer');
    if (!/^\d+(?:\.0+)?$/.test(String(offer.price)) || Number(offer.price) <= 0)
      fail('price is not a positive integer');
    return {name: p.name, sku: p.sku, product_id: id, color: null,
      offers: {price: String(offer.price), currency: 'JPY'}};
  }

  // The saved listing's numeric bid is a brand navigation context, not a variant.
  // Keep every other query spelling intact so binding fails closed on unknown state.
  function shirohatoListingUrl(raw) {
    let url; try { url = new URL(raw); } catch (_) { return raw; }
    if (url.origin !== 'https://www.wakudoki.ne.jp' || url.username || url.password ||
        !/^\/productdetail\/[a-z0-9]+\/1\/$/.test(url.pathname) || url.hash ||
        !/^\?bid=\d+$/.test(url.search)) return raw;
    url.search = '';
    return url.href;
  }

  function shirohatoGallery(urls, productId) {
    const fail = reason => { throw new Error(`Shirohato gallery: ${reason}`); };
    if (!urls.length) fail('no matching gallery images');
    if (!/^[a-z0-9]+$/.test(productId || '')) fail('missing or invalid product ID');
    return [...new Set(urls.map((raw, index) => {
      const image = `image ${index + 1}`;
      let url; try { url = new URL(raw); } catch (_) { return fail(`${image} is not an absolute URL`); }
      if (url.protocol !== 'https:' || !['img.wakudoki.ne.jp','www.wakudoki.ne.jp'].includes(url.hostname) ||
          url.port || url.username || url.password) fail(`${image} has an unapproved origin`);
      if (url.search || url.hash) fail(`${image} has a query or fragment`);
      const file = url.pathname.slice('/Contents/ProductImages/0/'.length);
      const primary = url.pathname.startsWith('/Contents/ProductImages/0/') &&
        new RegExp('^' + productId + '(?:[-_][a-zA-Z0-9]+)*_LL\\.jpg$').test(file);
      const subimage = new RegExp('^/Contents/ProductSubImages/0/' + productId +
        '_sub[0-9]+_LL\\.jpg$').test(url.pathname);
      if (!primary && !subimage) fail(`${image} is not a current-product original`);
      return url.href;
    }))];
  }

  function bareNecessitiesProduct(script, pageUrl, canonicalUrl, currency, defaultVariant) {
    const fail = reason => { throw productEvidenceError(`Bare Necessities product: ${reason}`); };
    const marker = 'window.SwymProductInfo.product = ';
    const start = String(script).indexOf(marker);
    if (start < 0) fail('missing Shopify product JSON');
    const text = script.slice(start + marker.length).trimStart();
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) { end = i + 1; break; } }
    }
    let product;
    try { product = JSON.parse(text.slice(0, end)); } catch (_) { fail('invalid Shopify product JSON'); }
    let page, canonical;
    try { page = new URL(pageUrl); canonical = new URL(canonicalUrl); } catch (_) { fail('invalid canonical'); }
    const origin = 'https://www.barenecessities.com';
    if (page.origin !== origin || canonical.origin !== origin || page.pathname !== canonical.pathname ||
        canonical.search || canonical.hash || canonical.pathname !== `/products/${product.handle}`) fail('canonical mismatch');
    if (!Number.isSafeInteger(product.id)) fail('invalid product id');
    if (!product.title) fail('missing title');
    if (!product.vendor) fail('missing vendor');
    if (currency !== 'USD') fail('currency is not USD');
    const variant = product.variants?.find(item => String(item.id) === defaultVariant?.variantId);
    const price = variant?.price;
    if (String(product.id) !== defaultVariant?.productId) fail('page variant price not bound: productId mismatch');
    if (defaultVariant?.name !== product.title) fail('page variant price not bound: name mismatch');
    if (!variant) fail('page variant price not bound: variantId missing from variants');
    if (!Number.isSafeInteger(price) || price < 0) fail('page variant price not bound: invalid Shopify price');
    if (Number(defaultVariant?.price) !== price / 100) fail('page variant price not bound: defaultVariant.price mismatch');
    if (!Array.isArray(product.images) || !product.images.length) fail('images missing');
    const images = product.images.map(raw => {
      let url;
      try { url = new URL(raw, origin); } catch (_) { fail('invalid original image'); }
      if (url.protocol !== 'https:' || url.hostname !== 'www.barenecessities.com' ||
          !url.pathname.startsWith('/cdn/shop/files/') || url.username || url.password) fail('foreign original image');
      return url.href;
    });
    return {facts: {name: product.title, sku: null, product_id: String(product.id), color: null,
      offers: {price: (price / 100).toFixed(2), currency}}, images, category: product.type || ''};
  }

  function bravissimoProduct(product, jsonld, pageUrl, canonicalUrl, selectedColor, currency) {
    const fail = message => { throw productEvidenceError('Bravissimo product: ' + message); };
    let page, canonical;
    try { page = new URL(pageUrl); } catch (_) { fail('invalid page URL'); }
    try { canonical = new URL(canonicalUrl); } catch (_) { fail('invalid canonical URL'); }
    if (page.origin !== 'https://www.bravissimo.com' || canonical.origin !== page.origin ||
        !/^\/us\/products\/[^/]+\/$/.test(page.pathname) || page.pathname !== canonical.pathname ||
        canonical.search || canonical.hash) fail('US canonical mismatch');
    if (!product?.brand) fail('missing brand');
    if (!product.styleCode) fail('missing styleCode');
    if (!product.styleColourCode) fail('missing styleColourCode');
    if (typeof product.styleName !== 'string' || !product.styleName.trim()) fail('invalid styleName');
    if (!canonical.pathname.endsWith('-' + product.styleCode.toLowerCase() + '/')) fail('canonical styleCode mismatch');
    if (product.colour?.colour !== selectedColor) fail('rendered colour mismatch');
    const nodes = jsonld.flat();
    const variant = nodes.find(x => x['@type'] === 'Product' && x.sku === product.styleColourCode);
    const group = nodes.find(x => x['@type'] === 'ProductGroup' && x['@id'] === product.styleCode);
    if (nodes.some(x => x['@type'] === 'Product') && !variant) fail('JSON-LD Product sku mismatch');
    if (nodes.some(x => x['@type'] === 'ProductGroup') && !group) fail('JSON-LD ProductGroup @id mismatch');
    if (currency !== 'USD') fail('currency is not USD');
    if (!Number.isFinite(product.prices?.price) || product.prices.price < 0) fail('invalid prices.price');
    if (variant) {
      if (variant.color !== selectedColor) fail('JSON-LD Product color mismatch');
      if (variant.offers?.priceCurrency !== 'USD') fail('JSON-LD offers.priceCurrency is not USD');
      if (Number(variant.offers.price) !== product.prices.price) fail('JSON-LD offers.price mismatch');
    }
    if (group && group.brand?.name !== product.brand) fail('JSON-LD ProductGroup brand mismatch');
    if (!Array.isArray(product.images) || !product.images.length) fail('missing images gallery');
    // Membership in this product's own images is the binding; filenames can be shared or renamed.
    const images = product.images.map((image, index) => {
      const field = `images[${index}].zoom`;
      let url;
      try { url = new URL(image?.zoom, page.origin); } catch (_) { fail(`${field}: invalid gallery URL`); }
      if (url.protocol !== 'https:') fail(`${field}: gallery scheme is not HTTPS`);
      if (url.hostname !== 'images.ctfassets.net') fail(`${field}: foreign gallery host`);
      if (!url.pathname.startsWith('/bz0fvtkbk5r1/')) fail(`${field}: foreign gallery space`);
      if (url.username || url.password) fail(`${field}: gallery credentials are not allowed`);
      return url.href;
    });
    const sizeLabels = node => node?.label ? [node.label] : (node?.variants || []).flatMap(item => sizeLabels(item.sizes || item));
    // Microdata evidence is trimmed by the receiver; emit the same normalized name.
    const facts = {name: product.styleName.trim(), sku: product.styleColourCode, product_id: product.styleCode,
      color: selectedColor, offers: {price: product.prices.price.toFixed(2), currency: 'USD'}};
    return {facts, images: [...new Set(images)], category: product.productGroup,
      microdata: {name: facts.name, sku: facts.sku, productID: facts.product_id, url: canonical.href,
        brand: product.brand, color: selectedColor, category: product.category, productGroup: product.productGroup,
        offers: {price: facts.offers.price, priceCurrency: 'USD'},
        colors: product.availableColours?.map(x => x.name) || [], sizes: [...new Set(sizeLabels(product.sizes))],
        field_sources: {productID: 'setDataLayer product.styleCode; canonical bound',
          brand: 'setDataLayer product.brand; ProductGroup JSON-LD corroborated when present',
          color: 'rendered selected-colour; matching Product JSON-LD corroborated when present',
          offers: 'setDataLayer product.prices; __STATE__.app.config.currency USD; matching JSON-LD corroborated when present',
          sizes: 'setDataLayer product.sizes (descriptive, not stock)'}}};
  }

  function bareNecessitiesGallery(originals, rendered) {
    const urls = rendered.map(raw => {
      let url;
      try { url = new URL(raw, 'https://www.barenecessities.com'); } catch (_) { throw new Error('Bare Necessities gallery: invalid image'); }
      const matches = originals.filter(original => {
        const candidate = new URL(original);
        return candidate.origin === url.origin && candidate.pathname === url.pathname;
      });
      if (matches.length !== 1) throw new Error('Bare Necessities gallery: rendered image not bound to product original');
      return matches[0];
    });
    if (!urls.length) throw new Error('Bare Necessities gallery: no rendered images');
    return [...new Set(urls)];
  }

  function listingResultTotal(text) {
    const japanese = String(text).match(/^\s*(\d+|\d{1,3}(?:,\d{3})+)\s*件\s*$/);
    if (japanese) {
      const total = Number(japanese[1].replace(/,/g, ''));
      return Number.isSafeInteger(total) ? total : null;
    }
    const range = String(text).match(/^\s*Items\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s*$/i);
    if (range) {
      const [start, end, total] = range.slice(1).map(Number);
      return Number.isSafeInteger(total) && start >= 1 && start <= end && end <= total ? total : null;
    }
    const simple = String(text).match(/\b(\d+)\s*(?:results?|items?|products?)\b/i);
    return simple && Number.isSafeInteger(Number(simple[1])) ? Number(simple[1]) : null;
  }

  function victoriasSecretImage(raw, candidates = []) {
    const base = 'https://www.victoriassecret.com';
    const input = new URL(raw, base);
    if (input.origin !== base) throw new Error('VS gallery: foreign image host');
    const filename = decodeURIComponent(input.pathname.split('/').pop());
    const images = [raw, ...candidates].map(value => {
      try {
        const url = new URL(value.startsWith('www.victoriassecret.com/') ? 'https://' + value : value, base);
        const match = url.pathname.match(/^\/p\/(\d+)x(\d+)\/(?:png|jpg|webp|tif)\/[^?#]+$/);
        return url.origin === base && match && !url.search && !url.hash &&
          decodeURIComponent(url.pathname.split('/').pop()) === filename ?
          {url: url.href, width: Number(match[1]), height: Number(match[2])} : null;
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.width - a.width || b.height - a.height);
    if (!images.length) throw new Error('VS gallery: no evidenced original for ' + filename);
    return images[0].url;
  }

  const helpers = {
    productEvidenceError, shirohatoProduct, shirohatoGallery, shirohatoListingUrl,
    liseCharmelGallery,
    liseCharmelListingProducts,
    vandeveldeProduct,
    bravissimoProduct, listingResultTotal, bareNecessitiesProduct, bareNecessitiesGallery,
    comparableUrl, sameDocumentUrl,
    victoriasSecretImage, victoriasSecretSameProductChoice, victoriasSecretUnavailableChoice,
    takeoverStatusText,
    canSaveShopifyFeed,
    collectShopifyFeed,
    prepareLazyGallery,
    captureProductFromJsonLd,
    captureProductEvidence,
    captureIdentity,
    captureIdentityKey,
    captureImageUrls,
    resolveGalleryOriginal,
    dedupeManualImages,
    galleryNodeOriginal,
    waitForCaptureState,
    waitForAutoCaptureReady,
    recordCaptureFailure,
    buildCaptureCompletion,
    exportProductCapture,
    captureWithReceiver,
    validateReceiverSettings,
    testReceiverConnection,
    captureResultMessage,
    saveCaptureDownload,
    sanitizeFolderPath,
    isFindImagesPageShortcut,
    filenameFromUrl,
    getScrollStep,
    getSafeCanvasSize,
    getElementsForFixedCheck,
    buildCaptureVisibleTabResponse,
    buildGoldCaptureSettings
  };

  root.PageImageSaverHelpers = helpers;
  if (root.window) {
    root.window.PageImageSaverHelpers = helpers;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
})(globalThis);
