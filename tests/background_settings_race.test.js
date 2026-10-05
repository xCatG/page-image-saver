const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const receiver = {enabled: true, url: 'http://127.0.0.1:8765', token: 'test-token'};
const productUrl = 'https://shop.example.test/bra-black';

function bridge() {
  const startup = [];
  const alarms = [];
  const runtimeMessages = [];
  const requests = [];
  const errors = [];
  let releaseSettings;
  const stored = {catalogTakeoverRun: {
    version: 1, generation: 2, status: 'running', domain: 'shop.example.test',
    config: {takeover: {intervalMs: 10000}},
    listings: {queue: [], visited: [], discoveryComplete: true},
    products: [{url: productUrl, status: 'captured', identity: {
      domain: 'shop.example.test', product_url: productUrl,
      color_key: 'url', selected_color: null}}],
    current: null, lastNavigationStarted: null, loadFailures: {}
  }};
  const event = listeners => ({addListener(fn) { listeners.push(fn); }});
  const passive = () => ({addListener() {}});
  const chrome = {
    runtime: {lastError: null, onMessage: event(runtimeMessages),
      onInstalled: passive(), onStartup: event(startup)},
    webRequest: {onCompleted: passive()},
    alarms: {onAlarm: event(alarms), create() {}, clear() {}},
    storage: {
      sync: {get(_key, callback) { releaseSettings = callback; }},
      local: {get(key, callback) { callback({[key]: stored[key]}); },
        set(value, callback) { Object.assign(stored, value); callback?.(); }},
      onChanged: passive()
    },
    notifications: {create() {}},
    contextMenus: {removeAll(callback) { callback(); }, create() {}, onClicked: passive()},
    action: {onClicked: passive()}, commands: {onCommand: passive()},
    scripting: {executeScript: async () => []},
    tabs: {onRemoved: passive(), onUpdated: passive(), create() {}, sendMessage() {}, query() {}, captureVisibleTab() {}},
    downloads: {search(_query, callback) { callback([]); }}
  };
  const sandbox = {chrome, URL, Date, Promise, Blob, Uint8Array, ArrayBuffer,
    navigator: {userAgent: 'Chrome'},
    PageImageSaverHelpers: require('../extension_helpers.js'),
    PageImageSaverTakeover: require('../takeover_runner.js'),
    fetch: async url => {
      requests.push(url);
      return {ok: true, status: 200,
        json: async () => ({complete: true, captured_at: '2026-09-29T12:00:00Z'})};
    },
    console: {log() {}, warn() {}, error(error) { errors.push(error); }},
    setTimeout() { return 1; }, clearTimeout() {}
  };
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  vm.runInNewContext(source, sandbox, {filename: 'background.js'});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {chrome, stored, startup, alarms, requests, errors, flush,
    capture() {
      return new Promise(resolve => {
        const message = {action: 'captureProductLocal', payload: {
          identity: {domain: 'shop.example.test', product_url: productUrl,
            color_key: 'url', selected_color: null}}};
        for (const listener of runtimeMessages) {
          if (listener(message, {tab: {id: 8}}, resolve) === true) return;
        }
        resolve(null);
      });
    },
    loadSettings() { releaseSettings({imageUploaderSettings: {receiver}}); },
    failSettings() {
      chrome.runtime.lastError = {message: 'sync storage unavailable'};
      releaseSettings({});
      chrome.runtime.lastError = null;
    }};
}

for (const trigger of ['startup', 'alarm']) {
  test(`${trigger} waits for receiver settings before re-verifying saved capture`, async () => {
    const b = bridge();
    if (trigger === 'startup') b.startup[0]();
    else b.alarms[0]({name: 'catalog-takeover-step'});
    await b.flush();
    assert.equal(b.stored.catalogTakeoverRun.products[0].status, 'captured');
    assert.deepEqual(b.requests, []);
    b.loadSettings();
    await b.flush();
    assert.equal(b.stored.catalogTakeoverRun.products[0].status, 'captured');
    assert.equal(b.stored.catalogTakeoverRun.status, 'complete');
    assert.equal(b.requests.length, 1);
    assert.equal(b.errors.length, 0);
  });
}

test('sync storage failure settles the gate without changing saved capture evidence', async () => {
  const b = bridge();
  b.startup[0]();
  b.failSettings();
  await b.flush();
  assert.equal(b.stored.catalogTakeoverRun.products[0].status, 'captured');
  assert.deepEqual(b.requests, []);
  assert.match(String(b.errors[0]), /sync storage unavailable/);
});

test('manual product capture waits for persisted receiver settings', async () => {
  const b = bridge();
  let response;
  const pending = b.capture().then(value => { response = value; });
  await b.flush();
  assert.equal(response, undefined);
  assert.deepEqual(b.requests, []);
  b.loadSettings();
  await pending;
  assert.equal(response.success, true);
  assert.equal(response.storage, 'receiver');
  assert.equal(b.requests.length, 1);
});
