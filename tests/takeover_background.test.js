const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const black = 'https://shop.example.test/bra-black';
const red = 'https://shop.example.test/bra-red';

function bridge() {
  const webCompleted = [];
  const webHeaders = [];
  const tabUpdated = [];
  const runtimeMessages = [];
  const messages = [];
  const tab = {id: 7, status: 'loading', url: black};
  const stored = {catalogTakeoverRun: {domain: 'shop.example.test', status: 'running', generation: 2,
    current: {phase: 'product', url: black}}, catalogTakeoverTabId: 7};
  const controls = {beforeStop: null};
  let io;
  const event = listeners => ({addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); }});
  const passive = () => ({addListener() {}});
  const chrome = {
    runtime: {lastError: null, onMessage: event(runtimeMessages), onStartup: passive()},
    webRequest: {onCompleted: event(webCompleted), onHeadersReceived: event(webHeaders)},
    alarms: {onAlarm: passive(), create() {}, clear() {}},
    notifications: {create() {}},
    storage: {local: {
      get(key, callback) { callback({[key]: stored[key]}); },
      set(value, callback) { Object.assign(stored, value); callback?.(); }
    }},
    tabs: {onUpdated: event(tabUpdated),
      create(_details, callback) { callback({...tab}); },
      update(_id, details, callback) { tab.url = details.url; callback({...tab}); },
      get(_id, callback) { callback({...tab}); },
      remove(_id, callback) { callback?.(); },
      sendMessage(_id, message, callback) {
        messages.push(message);
        if (message.action === 'takeoverInspect') callback({success: true, page: {
          kind: 'product', url: black, documentId: 'doc-black',
          product: {name: 'Lace Bra', category: 'Bras'}, colorLinks: []}});
        else callback({success: true, result: {storage: 'receiver', status: 'already',
          identity: {domain: 'shop.example.test', product_url: red,
            selected_color: 'Red', color_key: 'url'}}});
      }
    }
  };
  const sandbox = {chrome, URL, Date, Promise, console,
    setTimeout() { return 1; }, clearTimeout() {},
    PageImageSaverTakeover: {createTakeoverRunner(value) {
      io = value;
      return {tick: async () => {}, read: async () => stored.catalogTakeoverRun,
        preview: async config => {
          stored.catalogTakeoverRun = {domain: config.domain, status: 'preview', generation: 3};
          return stored.catalogTakeoverRun;
        },
        stop: async () => {
          await controls.beforeStop?.();
          stored.catalogTakeoverRun.status = 'stopped'; return stored.catalogTakeoverRun;
        }};
    }, summarizeTakeover() { return {}; }},
    PageImageSaverHelpers: {}};
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    .split('// Product capture is always local.')[0]
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: 'background.js'});
  return {io, tab, stored, controls, chrome, messages, webCompleted, webHeaders, tabUpdated,
    runtimeMessages, sandbox};
}

function captureBridge() {
  const b = bridge();
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const captureStart = source.indexOf('chrome.runtime.onMessage.addListener(',
    source.indexOf('// Product capture is always local.'));
  const captureSource = source.slice(captureStart, source.indexOf('/*\n  The product capture path'));
  const acquisitions = [];
  const imageRequests = [];
  b.sandbox.CONFIG = {receiver: {enabled: true}};
  b.sandbox.requireSettingsReady = async () => {};
  b.sandbox.fetch = async url => {
    imageRequests.push(url);
    return {ok: true, url, arrayBuffer: async () => new Uint8Array([1]).buffer};
  };
  b.sandbox.PageImageSaverHelpers.captureWithReceiver = async (_payload, _settings, io) => {
    await io.fetchImage(black + '.png');
    acquisitions.push('published');
    return {storage: 'receiver', status: 'published'};
  };
  vm.runInContext(captureSource, b.sandbox, {filename: 'background-capture.js'});
  const dispatch = (message, tabId = 7, tabUrl = black) => new Promise(resolve => {
    for (const listener of b.runtimeMessages) {
      if (listener(message, {tab: {id: tabId, url: tabUrl}, url: tabUrl}, resolve) === true) return;
    }
    resolve(null);
  });
  return {...b, acquisitions, imageRequests, dispatch};
}

test('background discovery export records actual export time and manifest version in downloaded JSON', async () => {
  const b = captureBridge();
  b.stored.catalogTakeoverRun = {version: 1, mode: 'discovery', domain: 'shop.example.test',
    status: 'stopped', startedAt: '2026-10-01T10:20:30.000Z', products: [],
    config: {listing: {productLinkSelector: 'a.card', pagination: {nextSelector: 'a.next'}}},
    listings: {visited: []}, reason: 'stopped by user'};
  b.sandbox.PageImageSaverTakeover.exportTakeoverReport = require('../takeover_runner.js').exportTakeoverReport;
  b.chrome.runtime.getManifest = () => ({version: '7.8.9'});
  b.sandbox.Blob = Blob;
  b.sandbox.blobToDataUrl = async blob => 'data:application/json,' + encodeURIComponent(await blob.text());
  let downloaded;
  b.sandbox.PageImageSaverHelpers.saveCaptureDownload = async (_chrome, url) => {
    downloaded = JSON.parse(decodeURIComponent(url.split(',')[1]));
  };
  const before = Date.now();
  const reply = await b.dispatch({action: 'takeoverExport', domain: 'shop.example.test'});
  assert.equal(reply.success, true, reply.error);
  assert.equal(downloaded.started_utc, '2026-10-01T10:20:30.000Z');
  assert.equal(downloaded.extension_version, '7.8.9');
  assert.ok(Date.parse(downloaded.exported_utc) >= before);
  assert.ok(Date.parse(downloaded.exported_utc) <= Date.now());
});

test('owned runner tab blocks page-load capture after pause, challenge, or stop', async () => {
  for (const status of ['paused', 'stopped']) {
    const b = captureBridge();
    b.stored.catalogTakeoverRun.status = status;
    if (status === 'paused') b.stored.catalogTakeoverRun.current = null;
    const permission = await b.dispatch({action: 'autoCaptureAllowed'});
    assert.equal(permission.allowed, false, status);
    const result = await b.dispatch({action: 'captureProductLocal', autoPageLoad: true,
      payload: {identity: {domain: 'shop.example.test', product_url: black}}});
    assert.equal(result.success, false, status);
    assert.deepEqual(b.acquisitions, []);
    assert.deepEqual(b.imageRequests, []);
  }
});

test('catalog action from another host cannot stop the saved run', async () => {
  const b = captureBridge();
  const foreign = await b.dispatch({action: 'takeoverStop', domain: 'other.example.test'});
  assert.equal(foreign.success, false);
  assert.match(foreign.error, /saved catalog run belongs to shop\.example\.test/);
  assert.equal(b.stored.catalogTakeoverRun.status, 'running');
  const owner = await b.dispatch({action: 'takeoverStop', domain: 'shop.example.test'});
  assert.equal(owner.success, true);
  assert.equal(b.stored.catalogTakeoverRun.status, 'stopped');
});

test('old-site stop cannot overwrite a new-site preview during an async control action', async () => {
  const b = captureBridge();
  b.stored.catalogTakeoverRun.status = 'preview';
  let enteredStop;
  const stopEntered = new Promise(resolve => { enteredStop = resolve; });
  let releaseStop;
  b.controls.beforeStop = async () => {
    enteredStop();
    await new Promise(resolve => { releaseStop = resolve; });
  };
  const stopping = b.dispatch({action: 'takeoverStop', domain: 'shop.example.test'});
  await stopEntered;
  const otherUrl = 'https://other.example.test/product';
  const previewing = b.dispatch({action: 'takeoverPreview',
    config: {domain: 'other.example.test'}, page: {kind: 'product', url: otherUrl}}, 8, otherUrl);
  await new Promise(resolve => setImmediate(resolve));
  releaseStop();
  const [stopResult, previewResult] = await Promise.all([stopping, previewing]);
  assert.equal(stopResult.success, true);
  assert.equal(stopResult.run.domain, 'shop.example.test');
  assert.equal(previewResult.success, true);
  assert.equal(b.stored.catalogTakeoverRun.domain, 'other.example.test');
  assert.equal(b.stored.catalogTakeoverRun.status, 'preview');
});

test('late pause is rechecked when automatic image acquisition begins', async () => {
  const b = captureBridge();
  let release;
  b.sandbox.PageImageSaverHelpers.captureWithReceiver = async (_payload, _settings, io) => {
    await new Promise(resolve => { release = resolve; });
    await io.fetchImage(black + '.png');
    b.acquisitions.push('published');
    return {storage: 'receiver', status: 'published'};
  };
  const pending = b.dispatch({action: 'captureProductLocal', autoPageLoad: true,
    payload: {identity: {domain: 'shop.example.test', product_url: black}}}, 8);
  while (!release) await Promise.resolve();
  b.stored.catalogTakeoverTabId = 8;
  b.stored.catalogTakeoverRun.status = 'paused';
  release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.deepEqual(b.acquisitions, []);
  assert.deepEqual(b.imageRequests, []);
});

test('late pause prevents Downloads publication after data conversion', async () => {
  const b = captureBridge();
  b.sandbox.CONFIG.receiver.enabled = false;
  b.sandbox.Blob = Blob;
  let release;
  const saved = [];
  b.sandbox.blobToDataUrl = async () => new Promise(resolve => { release = () => resolve('data:example'); });
  b.sandbox.PageImageSaverHelpers.exportProductCapture = async (_payload, io) => {
    await io.saveBytes('PageImageSaver/complete.json', new Uint8Array([1]));
  };
  b.sandbox.PageImageSaverHelpers.saveCaptureDownload = async (_chrome, _url, filename) => {
    saved.push(filename);
  };
  const pending = b.dispatch({action: 'captureProductLocal', autoPageLoad: true,
    payload: {identity: {domain: 'shop.example.test', product_url: black}}}, 8);
  while (!release) await Promise.resolve();
  b.stored.catalogTakeoverTabId = 8;
  b.stored.catalogTakeoverRun.status = 'stopped';
  release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.deepEqual(saved, []);
});

test('manual capture and unrelated same-site tab retain capture access', async () => {
  const b = captureBridge();
  b.stored.catalogTakeoverRun.status = 'stopped';
  const manual = await b.dispatch({action: 'captureProductLocal', payload: {
    identity: {domain: 'shop.example.test', product_url: black}}});
  assert.equal(manual.success, true);
  const other = await b.dispatch({action: 'captureProductLocal', autoPageLoad: true,
    payload: {identity: {domain: 'shop.example.test', product_url: black}}}, 8);
  assert.equal(other.success, true);
  assert.equal(b.acquisitions.length, 2);
  assert.equal(b.imageRequests.length, 2);
});

test('known 429 main-frame response settles load while tab stays loading', async () => {
  const b = bridge();
  let settled = false;
  const loading = b.io.load(black).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  b.webCompleted[0]({type: 'main_frame', tabId: 7, statusCode: 429});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'known 429 must not wait for tab complete or the deadline');
  assert.equal((await loading).status, 429);
});

test('404 and 410 page loads report HTTP status without a content inspector', async () => {
  for (const status of [404, 410]) {
    const b = bridge();
    b.tab.status = 'complete';
    b.chrome.tabs.update = (_id, details, callback) => {
      b.tab.url = details.url;
      b.webCompleted[0]({type: 'main_frame', tabId: 7, statusCode: status});
      callback({...b.tab});
    };
    b.chrome.tabs.sendMessage = (_id, _message, callback) => {
      callback({success: false, error: 'content inspector unavailable'});
    };
    assert.equal((await b.io.load(black)).status, status);
  }
});

test('take-over reuses its owned tab without activating it on later pages', async () => {
  const b = bridge();
  b.tab.status = 'complete';
  const created = [];
  const updated = [];
  b.chrome.tabs.create = (details, callback) => {
    created.push(details); callback({...b.tab});
  };
  b.chrome.tabs.update = (id, details, callback) => {
    updated.push({id, ...details});
    b.tab.url = details.url;
    callback({...b.tab});
  };
  await b.io.load(black);
  await b.io.load(red);
  assert.deepEqual(created, []);
  assert.equal(updated.length, 2);
  assert.deepEqual(updated.map(entry => ({id: entry.id, url: entry.url, active: entry.active})), [
    {id: 7, url: black, active: false},
    {id: 7, url: red, active: false}
  ]);
  assert.equal(b.stored.catalogTakeoverTabId, 7);
});

test('blocked status survives later main-frame events before tab creation callback', async () => {
  const b = bridge();
  b.stored.catalogTakeoverTabId = null;
  b.chrome.tabs.create = (_details, callback) => {
    b.webCompleted[0]({type: 'main_frame', tabId: 7, statusCode: 429});
    b.webCompleted[0]({type: 'main_frame', tabId: 7, statusCode: 200});
    callback({...b.tab});
  };
  let settled = false;
  const loading = b.io.load(black).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal((await loading).status, 429);
});

test('tab navigation after inspection rejects capture before media acquisition', async () => {
  const b = bridge();
  b.tab.status = 'complete';
  const inspected = await b.io.load(black);
  assert.equal(inspected.url, black);
  b.tab.url = red;
  const before = b.messages.length;
  await assert.rejects(() => b.io.capture(black, {decision: 'include', reason: 'Bras'}, {
    tabId: 7, documentId: 'doc-black', generation: 2, expectedUrl: black
  }), /tab|URL|identity|binding/i);
  assert.equal(b.messages.length, before, 'no capture message may reach the changed tab');
});

test('navigation during capture prevents accepting a receiver result for the old document', async () => {
  const b = bridge();
  b.tab.status = 'complete';
  const inspected = await b.io.load(black);
  const binding = {tabId: inspected.tabId, documentId: inspected.documentId,
    generation: 2, expectedUrl: black};
  b.stored.catalogTakeoverRun.current.binding = binding;
  b.chrome.tabs.sendMessage = (_id, message, callback) => {
    if (message.action === 'takeoverCapture') {
      b.tab.url = red;
      callback({success: true, result: {storage: 'receiver', status: 'already',
        identity: {domain: 'shop.example.test', product_url: black,
          selected_color: 'Black', color_key: 'url'}}});
    } else callback({success: true, documentId: 'doc-black', url: black});
  };
  await assert.rejects(() => b.io.capture(black, {decision: 'include', reason: 'Bras'}, binding),
    /tab URL changed|document changed/);
});
