const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const black = 'https://shop.example.test/bra-black';
const red = 'https://shop.example.test/bra-red';

test('Shopify feed download message keeps the port open and writes exactly one Downloads file', async () => {
  const b = bridge();
  const downloads = [];
  b.sandbox.Blob = Blob;
  b.sandbox.blobToDataUrl = async blob => 'data:application/json,' + await blob.text();
  b.sandbox.PageImageSaverHelpers.saveCaptureDownload = async (_chrome, data, filename) => {
    downloads.push({data, filename});
  };
  const report = {version: 1, host: 'shop.example.test', prefix: '',
    fetched: [{status: 200}], pages: [{products: [{id: 1}]}]};
  const response = await new Promise(resolve => {
    assert.equal(b.runtimeMessages[0]({action: 'saveShopifyFeedDownload', report},
      {tab: {id: 7, url: black}, url: black}, resolve), true);
  });
  assert.equal(response.success, true);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].filename, /^shop\.example\.test-products-feed-.*\.json$/);
  assert.deepEqual(JSON.parse(downloads[0].data.split(',').slice(1).join(',')), report);
  const rejected = await new Promise(resolve => b.runtimeMessages[0](
    {action: 'saveShopifyFeedDownload', report: {...report, host: 'other.test'}},
    {tab: {id: 7, url: black}, url: black}, resolve));
  assert.equal(rejected.success, false);
  assert.equal(downloads.length, 1);
});

function bridge() {
  const tabRemoved = [];
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
    tabs: {onUpdated: event(tabUpdated), onRemoved: event(tabRemoved),
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
  const session = {};
  chrome.storage.session = {
    get(key, callback) { callback({[key]: session[key]}); },
    set(value, callback) { Object.assign(session, value); callback?.(); },
    remove(key, callback) { delete session[key]; callback?.(); }
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
    PageImageSaverHelpers: {...require('../extension_helpers.js')}};
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    .split('// Product capture is always local.')[0]
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: 'background.js'});
  return {io, tab, stored, controls, chrome, messages, webCompleted, webHeaders, tabUpdated,
    runtimeMessages, sandbox, tabRemoved, session};
}

test('feed reservation prevents duplicate starts and takeover until completion or tab loss', async () => {
  const b = bridge();
  b.stored.catalogTakeoverRun.status = 'paused';
  const dispatch = (action, id = 7, documentId = 'doc-a') => new Promise(resolve => {
    const handled = b.runtimeMessages[0]({action}, {tab: {id, url: black}, url: black, documentId}, resolve);
    if (!handled) resolve({success: false, error: 'unhandled'});
  });
  assert.equal((await dispatch('shopifyFeedAcquire')).success, true);
  for (const [id, doc] of [[7, 'doc-a'], [8, 'doc-b']])
    assert.match((await dispatch('shopifyFeedAcquire', id, doc)).error, /feed.*active/i);
  for (const action of ['takeoverStart', 'takeoverResume'])
    assert.match((await dispatch(action)).error, /feed.*active/i);
  await dispatch('shopifyFeedRelease', 8, 'doc-b');
  assert.match((await dispatch('shopifyFeedAcquire')).error, /feed.*active/i);
  await dispatch('shopifyFeedRelease');
  assert.equal((await dispatch('shopifyFeedAcquire')).success, true);
  for (const listener of b.tabUpdated) listener(7, {status: 'loading'}, b.tab);
  assert.equal((await dispatch('shopifyFeedAcquire', 7, 'doc-new')).success, true);
  await dispatch('shopifyFeedRelease', 7, 'doc-a');
  assert.match((await dispatch('shopifyFeedAcquire', 8)).error, /feed.*active/i);
  for (const listener of b.tabRemoved) listener(7);
  assert.equal((await dispatch('shopifyFeedAcquire', 8)).success, true);
});

test('feed reservation refuses a running takeover', async () => {
  const b = bridge();
  const result = await new Promise(resolve => {
    if (!b.runtimeMessages[0]({action: 'shopifyFeedAcquire'},
      {tab: {id: 7, url: black}, url: black, documentId: 'doc-a'}, resolve)) resolve({error: 'unhandled'});
  });
  assert.match(result.error, /pause take-over/i);
});

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

test('query-added capture accepts original sender URL only with the exact saved document binding', async () => {
  const b=captureBridge();
  const binding={tabId:7,documentId:'doc-black',generation:2,expectedUrl:black,documentUrl:black+'?size=OS'};
  b.stored.catalogTakeoverRun.current.binding=binding;
  b.tab.url=binding.documentUrl;
  const message={action:'captureProductLocal',runBinding:binding,payload:{identity:{domain:'shop.example.test',product_url:black,color_key:'url'}}};
  assert.equal((await b.dispatch(message,7,black)).success,true);
  assert.equal((await b.dispatch(message,7,red)).success,false);
  b.tab.url=black+'?size=M';
  assert.equal((await b.dispatch(message,7,black)).success,false);
});

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

test('query-added document binding permits capture but stays pinned to the inspected URL', async () => {
  const b=bridge();
  const binding={tabId:7,documentId:'doc-black',generation:2,expectedUrl:black,documentUrl:black+'?size=OS'};
  b.stored.catalogTakeoverRun.current.binding=binding;
  b.tab.url=binding.documentUrl;
  b.chrome.tabs.sendMessage=(_id,message,callback)=>callback(message.action==='takeoverDocumentCheck'
    ? {success:true,documentId:'doc-black',url:b.tab.url}
    : {success:true,result:{identity:{product_url:black}}});
  assert.equal((await b.io.capture(black,{},binding)).identity.product_url,black);
  b.tab.url=black+'?size=M';
  await assert.rejects(()=>b.io.capture(black,{},binding),/URL changed/);
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

test('tab URL comparison accepts real VS apostrophe encodings but not another product or query', () => {
  const b=bridge();
  for (const url of require('./fixtures/victoriassecret-apostrophe-urls.json')) {
    assert.equal(b.sandbox.takeoverSameUrl(url.replaceAll("'",'%27'),url),true);
    assert.equal(b.sandbox.takeoverSameUrl(url,url.replaceAll("'",'%27')),true);
    assert.equal(b.sandbox.takeoverSameUrl(url+'?choice=other',url),false);
  }
  assert.equal(b.sandbox.takeoverSameUrl('https://shop.example.test/a%2Fb','https://shop.example.test/a/b'),false);
  assert.equal(b.sandbox.takeoverSameUrl('https://shop.example.test/a%2527','https://shop.example.test/a%27'),false);
});
