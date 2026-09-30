const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
const start = source.indexOf('setTimeout(async () => {', source.indexOf('// A site must be explicitly enabled'));
const end = source.indexOf('// Share the panel entry point', start);
const callbackSource = source.slice(start, end);

async function configuredHost(hostname, fixtures) {
  const requests = [];
  const configStart = source.indexOf('async function loadCaptureSiteConfig()');
  const configEnd = source.indexOf('function captureJsonLd()', configStart);
  const sandbox = {window: {location: {hostname}}, Map,
    captureConfigCache: new Map(),
    chrome: {runtime: {getURL: file => file}},
    fetch: async path => {
      requests.push(path);
      const config = fixtures[path];
      return config ? {ok: true, status: 200, json: async () => config} : {ok: false, status: 404};
    }};
  vm.createContext(sandbox);
  vm.runInContext(configStart < 0 ? '' : source.slice(configStart, configEnd), sandbox);
  const config = await vm.runInContext('loadCaptureSiteConfig()', sandbox);
  return {config, requests};
}

test('www Lise config falls back to the bare file with requested host identity', async () => {
  const bare = require('../site_config/lisecharmel.com.json');
  const result = await configuredHost('www.lisecharmel.com', {
    'site_config/lisecharmel.com.json': bare});
  assert.equal(result.config.domain, 'www.lisecharmel.com');
  assert.equal(result.config.product.allImagesSelector, bare.product.allImagesSelector);
  assert.deepEqual(result.requests, [
    'site_config/www.lisecharmel.com.json', 'site_config/lisecharmel.com.json']);
});

test('exact site config wins and non-www subdomains do not inherit a bare config', async () => {
  const bare = require('../site_config/lisecharmel.com.json');
  const exact = {...bare, domain: 'www.lisecharmel.com', platform: 'exact-fixture'};
  const matched = await configuredHost('www.lisecharmel.com', {
    'site_config/www.lisecharmel.com.json': exact,
    'site_config/lisecharmel.com.json': bare});
  assert.equal(matched.config.platform, 'exact-fixture');
  assert.deepEqual(matched.requests, ['site_config/www.lisecharmel.com.json']);
  const other = await configuredHost('shop.lisecharmel.com', {
    'site_config/lisecharmel.com.json': bare});
  assert.equal(other.config, null);
  assert.deepEqual(other.requests, ['site_config/shop.lisecharmel.com.json']);
});

test('saved Lise-shaped microdata and OG-only Aubade facts enter the product evidence envelope', () => {
  const begin = source.indexOf('function captureJsonLd()');
  const finish = source.indexOf('function captureGallery(', begin);
  const fields = new Map([
    ['[itemscope][itemtype*="Product"]', {}],
    ['[itemprop="name"]', {textContent: 'Demi cup bra'}],
    ['[itemprop="price"]', {getAttribute: () => '196'}],
    ['[itemprop="priceCurrency"]', {getAttribute: () => 'USD'}],
    ['form[data-product-sku]', {getAttribute: () => 'ACH3013_0005'}],
    ['input[name="product"]', {value: '66720'}],
    ['.product-colors .current-color img[alt]', {getAttribute: () => 'Noir'}]
  ]);
  const metas = {'og:type': 'product', 'og:title': 'Demi cup bra',
    'product:price:amount': '196', 'product:price:currency': 'USD'};
  const helpers = require('../extension_helpers.js');
  const document = {querySelector: selector => fields.get(selector) || null,
    querySelectorAll: selector => selector === 'script[type="application/ld+json"]' ? [] :
      selector === 'meta[property]' ? Object.entries(metas).map(([property, content]) => ({
        getAttribute: name => name === 'property' ? property : content})) : []};
  const sandbox = {document, PageImageSaverHelpers: helpers};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source.slice(begin, finish), sandbox);
  const lise = vm.runInContext('capturePageProductEvidence()', sandbox);
  assert.equal(lise.fact_source, 'microdata');
  assert.equal(lise.facts.sku, 'ACH3013_0005');
  assert.equal(lise.facts.color, 'Noir');
  fields.clear();
  metas['og:title'] = 'Rules of Attraction Tanga Exciting Pink';
  metas['product:price:amount'] = '44.50';
  metas['product:price:currency'] = 'CHF';
  const aubade = vm.runInContext('capturePageProductEvidence()', sandbox);
  assert.equal(aubade.fact_source, 'meta');
  assert.equal(aubade.facts.offers.currency, 'CHF');
});

test('configured product marker reports a product even before facts load, while a listing stays quiet', () => {
  const begin = source.indexOf('function captureProductSeen(');
  const end = source.indexOf('function captureGallery(', begin);
  const document = {querySelector: selector => selector === '.known-product' ? {} : null};
  const sandbox = {document};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(begin, end), sandbox);
  const empty = {name: null, sku: null, product_id: null, color: null};
  assert.equal(vm.runInContext('captureProductSeen({product: {pageSelector: ".known-product"}}, empty)',
    Object.assign(sandbox, {empty})), true);
  assert.equal(vm.runInContext('captureProductSeen({product: {pageSelector: ".other"}}, empty)', sandbox), false);
  const cardFacts = {name: 'Listing card microdata', sku: 'CARD-1', product_id: null, color: null};
  sandbox.cardFacts = cardFacts;
  assert.equal(vm.runInContext('captureProductSeen({product: {pageSelector: ".other"}}, cardFacts)',
    sandbox), false, 'listing Product microdata is not a PDP without its configured marker');
});

test('packaged site selectors target gallery IMG nodes and narrow Chantelle product cards', () => {
  const lise = require('../site_config/lisecharmel.com.json');
  const aubade = require('../site_config/aubade.com.json');
  const chantelle = require('../site_config/us.chantelle.com.json');
  assert.match(lise.product.allImagesSelector, /\.fotorama__img img/);
  assert.equal(lise.product.pageSelector, 'form#product_addtocart_form');
  assert.equal(aubade.domain, 'aubade.com');
  assert.equal(aubade.product.allImagesSelector, '.product-gallery__media img');
  assert.match(chantelle.listing.productLinkSelector, /data-testid=['"]ProductCard_link['"]/);
  assert.doesNotMatch(chantelle.listing.productLinkSelector, /(^|,)\s*a\[href/);
});

async function runAuto({allowedAt = [true, true], delayedReady = false,
  captureResult = {storage: 'receiver', status: 'published'}, captureError = null} = {}) {
  const requests = [];
  const captures = [];
  const notices = [];
  const failures = [];
  let callback;
  let release;
  const body = {appendChild(element) { notices.push(element); }};
  const sandbox = {
    window: {location: {hostname: 'shop.example.test'}},
    console: {warn() {}},
    setTimeout(fn) { callback = fn; },
    document: {body, createElement() { return {style: {}, textContent: '', id: '',
      setAttribute() {}, remove() {}}; }, getElementById() { return null; }},
    loadCaptureSiteConfig: async () => ({product: {allImagesSelector: '.gallery img'}}),
    chrome: {storage: {local: {get(_defaults, cb) {
      cb({captureAutoDomains: {'shop.example.test': true}});
    }}}},
    takeoverRequest: async action => {
      requests.push(action);
      return {allowed: allowedAt[Math.min(requests.length - 1, allowedAt.length - 1)]};
    },
    PageImageSaverHelpers: {waitForAutoCaptureReady: async () => {
      if (delayedReady) await new Promise(resolve => { release = resolve; });
      return true;
    }},
    captureCurrentProduct: async options => {
      captures.push(options);
      if (captureError) throw captureError;
      return captureResult;
    },
    recordCaptureFailure: async error => { failures.push(error.message); }
  };
  sandbox.globalThis = sandbox;
  const noticeStart = source.indexOf('function showAutoCaptureToast(');
  if (noticeStart >= 0) {
    const noticeEnd = source.indexOf('async function loadCaptureSiteConfig()', noticeStart);
    vm.runInNewContext(source.slice(noticeStart, noticeEnd), sandbox, {filename: 'content-toast.js'});
  }
  vm.runInNewContext(callbackSource, sandbox, {filename: 'content-auto.js'});
  await callback();
  for (let i = 0; i < 5 && delayedReady && !release; i++) await new Promise(resolve => setImmediate(resolve));
  if (release) release();
  await new Promise(resolve => setImmediate(resolve));
  return {requests, captures, notices: notices.map(notice => notice.textContent), failures};
}

test('automatic capture shows distinct verified, exported, and failure on-page notices', async () => {
  const published = await runAuto();
  assert.deepEqual(published.notices, ['Product capture verified locally.']);
  const exported = await runAuto({captureResult: {storage: 'downloads', status: 'fallback'}});
  assert.deepEqual(exported.notices, ['Product exported to Downloads; import to verify.']);
  const failed = await runAuto({captureError: new Error('receiver HTTP 409')});
  assert.deepEqual(failed.notices, ['Automatic product capture failed: receiver HTTP 409']);
  assert.deepEqual(failed.failures, ['receiver HTTP 409']);
});

test('page-load callback checks tab authority before and after delayed readiness', async () => {
  assert.deepEqual((await runAuto({allowedAt: [false]})).captures, []);
  assert.deepEqual((await runAuto({allowedAt: [true, false], delayedReady: true})).captures, []);
  const unrelated = await runAuto();
  assert.deepEqual(unrelated.requests, ['autoCaptureAllowed', 'autoCaptureAllowed']);
  assert.equal(unrelated.captures.length, 1);
  assert.equal(unrelated.captures[0].autoPageLoad, true);
});

test('automatic product capture forwards its acquisition authority marker', async () => {
  const sent = [];
  const captureStart = source.indexOf('async function captureCurrentProduct(');
  const captureEnd = source.indexOf('function takeoverRequest(', captureStart);
  const sandbox = {URL, Date, Map,
    assertTakeoverBinding() {},
    loadCaptureSiteConfig: async () => ({colorVariantStrategy: 'separate-url'}),
    captureCanonicalUrl: () => 'https://shop.example.test/bra',
    capturePageProduct: () => ({name: 'Bra', color: 'Black'}),
    capturePageProductEvidence: () => ({format: 'page-image-saver-product-evidence/v1',
      facts: {name: 'Bra', color: null}}),
    captureSelectedColor: () => 'Black',
    capturePageHtml: () => '<p>Bra</p>',
    captureJsonLd: () => [],
    previousCaptureStates: new Map(),
    PageImageSaverHelpers: {
      waitForCaptureState: async () => ({color: 'Black', gallery: ['https://shop.example.test/bra.png']}),
      captureIdentity: () => ({domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
        selected_color: 'Black', color_key: 'url'}),
      captureImageUrls: url => ({original_url: url, fetched_url: url})
    },
    chrome: {runtime: {lastError: null, sendMessage(message, cb) {
      sent.push(message); cb({success: true});
    }}}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source.slice(captureStart, captureEnd), sandbox);
  await vm.runInContext('captureCurrentProduct({manual: false, autoPageLoad: true})', sandbox);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'captureProductLocal');
  assert.equal(sent[0].autoPageLoad, true);
  assert.equal(sent[0].runBinding, null);
  assert.equal(sent[0].payload.identity.selected_color, 'Black');
  assert.equal(sent[0].payload.product.color, null, 'UI-selected color cannot become a source-backed fact');
  assert.equal(sent[0].payload.jsonld.facts.color, null);
});

async function integratedAuto(stage) {
  const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const listeners = [];
  const stored = {catalogTakeoverRun: {status: 'running'}, catalogTakeoverTabId: 8};
  const imageRequests = [];
  const event = () => ({addListener(fn) { listeners.push(fn); }, removeListener() {}});
  const passive = () => ({addListener() {}, removeListener() {}});
  const background = {
    URL, Date, Promise, console,
    chrome: {
      runtime: {lastError: null, onMessage: event(), onStartup: passive()},
      webRequest: {onCompleted: passive(), onHeadersReceived: passive()},
      alarms: {onAlarm: passive(), clear() {}, create() {}},
      notifications: {create() {}},
      storage: {local: {get(key, cb) { cb({[key]: stored[key]}); }, set(value, cb) {
        Object.assign(stored, value); cb?.();
      }}},
      tabs: {onUpdated: passive()}
    },
    PageImageSaverTakeover: {createTakeoverRunner() {
      return {read: async () => stored.catalogTakeoverRun};
    }},
    PageImageSaverHelpers: {captureWithReceiver: async (_payload, _settings, io) => {
      await io.fetchImage('https://shop.example.test/bra.png');
      return {storage: 'receiver', status: 'published'};
    }},
    CONFIG: {receiver: {enabled: true}},
    fetch: async url => {
      imageRequests.push(url);
      return {ok: true, url, arrayBuffer: async () => new Uint8Array([1]).buffer};
    }
  };
  background.globalThis = background;
  vm.createContext(background);
  const prefix = backgroundSource.slice(0, backgroundSource.indexOf('// Product capture is always local.'))
    .replace("import './extension_helpers.js';", '').replace("import './takeover_runner.js';", '');
  vm.runInContext(prefix, background);
  const captureStart = backgroundSource.indexOf('chrome.runtime.onMessage.addListener(',
    backgroundSource.indexOf('// Product capture is always local.'));
  vm.runInContext(backgroundSource.slice(captureStart,
    backgroundSource.indexOf('/*\n  The product capture path')), background);
  const send = message => new Promise(resolve => {
    for (const listener of listeners) {
      if (listener(message, {tab: {id: 7, url: 'https://shop.example.test/bra'},
        url: 'https://shop.example.test/bra'}, resolve) === true) return;
    }
    resolve(null);
  });

  let callback;
  let release;
  const content = {
    URL, Date, Map, console: {warn() {}},
    window: {location: {hostname: 'shop.example.test'}},
    document: {body: {appendChild() {}}, getElementById() { return null; },
      createElement() { return {style: {}, setAttribute() {}, remove() {}}; }},
    setTimeout(fn) { callback = fn; },
    chrome: {
      runtime: {lastError: null, sendMessage(message, cb) { void send(message).then(cb); }},
      storage: {local: {get(_defaults, cb) { cb({captureAutoDomains: {'shop.example.test': true}}); }}}
    },
    loadCaptureSiteConfig: async () => ({product: {allImagesSelector: '.gallery img'},
      colorVariantStrategy: 'separate-url'}),
    assertTakeoverBinding() {}, captureCanonicalUrl: () => 'https://shop.example.test/bra',
    capturePageProduct: () => ({name: 'Bra', color: 'Black'}),
    capturePageProductEvidence: () => ({format: 'page-image-saver-product-evidence/v1',
      facts: {name: 'Bra', color: 'Black'}}),
    captureSelectedColor: () => 'Black', capturePageHtml: () => '<p>Bra</p>',
    captureJsonLd: () => [], previousCaptureStates: new Map(),
    recordCaptureFailure: async () => {},
    PageImageSaverHelpers: {
      waitForAutoCaptureReady: async () => {
        if (stage === 'readiness') await new Promise(resolve => { release = resolve; });
        return true;
      },
      waitForCaptureState: async () => {
        if (stage === 'acquisition') await new Promise(resolve => { release = resolve; });
        return {color: 'Black', gallery: ['https://shop.example.test/bra.png']};
      },
      captureIdentity: () => ({domain: 'shop.example.test',
        product_url: 'https://shop.example.test/bra', selected_color: 'Black', color_key: 'url'}),
      captureImageUrls: url => ({original_url: url, fetched_url: url})
    }
  };
  content.globalThis = content;
  vm.createContext(content);
  const noticeStart = source.indexOf('function showAutoCaptureToast(');
  vm.runInContext(source.slice(noticeStart,
    source.indexOf('async function loadCaptureSiteConfig()', noticeStart)), content);
  const captureStartContent = source.indexOf('async function captureCurrentProduct(');
  vm.runInContext(source.slice(captureStartContent, source.indexOf('function takeoverRequest(', captureStartContent)), content);
  const requestStart = source.indexOf('function takeoverRequest(');
  vm.runInContext(source.slice(requestStart, source.indexOf('async function refreshTakeoverProgress(', requestStart)), content);
  vm.runInContext(callbackSource, content);
  if (stage === 'before') {
    stored.catalogTakeoverTabId = 7;
    stored.catalogTakeoverRun.status = 'stopped';
  }
  await callback();
  if (stage !== 'before') {
    for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release, 'reached the chosen asynchronous boundary');
    stored.catalogTakeoverTabId = 7;
    stored.catalogTakeoverRun.status = 'paused';
    release();
  }
  await new Promise(resolve => setImmediate(resolve));
  return imageRequests;
}

test('actual content and background routes block owned tab before callback, after readiness, and at acquisition', async () => {
  for (const stage of ['before', 'readiness', 'acquisition']) {
    assert.deepEqual(await integratedAuto(stage), [], stage);
  }
});
