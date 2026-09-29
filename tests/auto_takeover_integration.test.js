const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
const start = source.indexOf('setTimeout(async () => {', source.indexOf('// A site must be explicitly enabled'));
const end = source.indexOf('// Share the panel entry point', start);
const callbackSource = source.slice(start, end);

async function runAuto({allowedAt = [true, true], delayedReady = false} = {}) {
  const requests = [];
  const captures = [];
  let callback;
  let release;
  const sandbox = {
    window: {location: {hostname: 'shop.example.test'}},
    console: {warn() {}},
    setTimeout(fn) { callback = fn; },
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
    captureCurrentProduct: async options => { captures.push(options); },
    recordCaptureFailure: async () => {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(callbackSource, sandbox, {filename: 'content-auto.js'});
  await callback();
  for (let i = 0; i < 5 && delayedReady && !release; i++) await new Promise(resolve => setImmediate(resolve));
  if (release) release();
  await new Promise(resolve => setImmediate(resolve));
  return {requests, captures};
}

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
    setTimeout(fn) { callback = fn; },
    chrome: {
      runtime: {lastError: null, sendMessage(message, cb) { void send(message).then(cb); }},
      storage: {local: {get(_defaults, cb) { cb({captureAutoDomains: {'shop.example.test': true}}); }}}
    },
    loadCaptureSiteConfig: async () => ({product: {allImagesSelector: '.gallery img'},
      colorVariantStrategy: 'separate-url'}),
    assertTakeoverBinding() {}, captureCanonicalUrl: () => 'https://shop.example.test/bra',
    capturePageProduct: () => ({name: 'Bra', color: 'Black'}),
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
