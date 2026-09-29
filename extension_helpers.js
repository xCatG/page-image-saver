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

  function getSafeCanvasHeight(totalHeight, dpr, maxCanvasEdge = 16384) {
    const safeDpr = dpr > 0 ? dpr : 1;
    return Math.min(totalHeight, Math.floor(maxCanvasEdge / safeDpr));
  }

  function getElementsForFixedCheck(node) {
    if (!node || node.nodeType !== 1) return [];
    const children = node.children ? Array.from(node.children) : [];
    return [node, ...children];
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
    function findProduct(value) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findProduct(item);
          if (found) return found;
        }
      } else if (value && typeof value === 'object') {
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some(type => typeof type === 'string' && /(^|\/)Product$/i.test(type))) return value;
        if (value['@graph']) return findProduct(value['@graph']);
      }
      return null;
    }
    for (const script of scriptTexts) {
      let parsed;
      try { parsed = JSON.parse(script); } catch (_) { continue; }
      const raw = findProduct(parsed);
      if (!raw) continue;
      const offer = Array.isArray(raw.offers) ? raw.offers[0] : raw.offers;
      const text = value => value == null ? null : String(value);
      return {name: text(raw.name), sku: text(raw.sku), product_id: text(raw.productID),
        color: text(raw.color), offers: {price: text(offer?.price), currency: text(offer?.priceCurrency)}};
    }
    return empty;
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
    while (now() - start <= timeout) {
      const evidence = readEvidence();
      productSeen ||= evidence.productSeen === true;
      if (evidence.productSeen === true && Array.isArray(evidence.gallery) && evidence.gallery.length > 0) return true;
      await delay(poll);
    }
    if (productSeen) throw new Error('automatic product gallery readiness timeout');
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

  async function exportProductCapture(payload, io) {
    const encode = value => new TextEncoder().encode(value);
    const identityHash = await captureSha256(encode(JSON.stringify(captureIdentityKey(payload.identity)) + '\n'));
    const attempt = io.attemptId || globalThis.crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(attempt)) throw new Error('unsafe capture attempt ID');
    const domain = payload.identity.domain;
    if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('unsafe capture domain');
    const base = `PageImageSaver/captures/${domain}/${identityHash}/${attempt}`;
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
      if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) throw new Error('invalid image byte count');
      const digest = await captureSha256(bytes);
      const extension = /\.jpe?g(?:$|\?)/i.test(requested.fetched_url) ? 'jpg' :
        /\.webp(?:$|\?)/i.test(requested.fetched_url) ? 'webp' :
        /\.gif(?:$|\?)/i.test(requested.fetched_url) ? 'gif' : 'png';
      const path = `images/${index}-${digest}.${extension}`;
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

  async function captureWithReceiver(payload, settings, io) {
    const url = new URL(settings.url);
    const host = url.hostname.toLowerCase();
    const privateIp = /^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!['http:', 'https:'].includes(url.protocol) || !privateIp && host !== 'localhost' &&
        !host.endsWith('.local') || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || !settings.token) {
      throw new Error('invalid local receiver URL or token');
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
            'X-Capture-Path': filename, 'X-Content-SHA256': digest});
        }
      });
      return {storage: 'receiver', status: publication.status, captured_at: publication.captured_at};
    } catch (error) {
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

  function saveCaptureDownload(chromeApi, dataUrl, filename, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let id = null;
      let settled = false;
      const early = new Map();
      const timer = setTimeout(() => finish(new Error('capture download timeout')), timeoutMs);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chromeApi.downloads.onChanged.removeListener(onChanged);
        if (error) reject(error);
        else resolve();
      }
      function terminal(delta) {
        if (delta.state?.current === 'interrupted') {
          finish(new Error(`capture download interrupted: ${delta.error?.current || filename}`));
        } else if (delta.state?.current === 'complete') {
          chromeApi.downloads.search({id: delta.id}, items => {
            const savedName = items?.[0]?.filename?.replace(/\\/g, '/');
            if (chromeApi.runtime.lastError || !savedName?.endsWith('/' + filename)) {
              finish(new Error(`capture download filename mismatch: expected ${filename}, got ${savedName || '<missing>'}`));
            } else {
              finish(null);
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
      chromeApi.downloads.download({url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify'}, downloadId => {
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

  const helpers = {
    captureProductFromJsonLd,
    captureIdentity,
    captureIdentityKey,
    captureImageUrls,
    waitForCaptureState,
    waitForAutoCaptureReady,
    recordCaptureFailure,
    buildCaptureCompletion,
    exportProductCapture,
    captureWithReceiver,
    captureResultMessage,
    saveCaptureDownload,
    sanitizeFolderPath,
    isFindImagesPageShortcut,
    filenameFromUrl,
    getScrollStep,
    getSafeCanvasHeight,
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
