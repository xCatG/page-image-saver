const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function injectionBridge() {
  const action = [];
  const commands = [];
  const injected = [];
  const code = background.slice(background.indexOf('// Initialize the extension'),
    background.indexOf('// Handle image save requests'));
  const tab = {id: 4, url: 'https://shop.example.test/product'};
  const event = listeners => ({addListener(fn) { listeners.push(fn); }});
  const sandbox = {
    console: {error() {}}, setTimeout() {},
    chrome: {
      runtime: {lastError: null},
      action: {onClicked: event(action)},
      commands: {onCommand: event(commands)},
      scripting: {executeScript(request) {
        if (request.files) {
          injected.push(request.files);
          return Promise.resolve([]);
        }
        return Promise.resolve([{result: false}]);
      }},
      tabs: {query(_query, callback) { callback([tab]); }, sendMessage() {}, create() {}}
    }
  };
  vm.runInNewContext(code, sandbox, {filename: 'background-injection.js'});
  return {action, commands, injected, tab};
}

for (const route of ['toolbar', 'keyboard']) {
  test(`${route} fallback injects shared helpers before screenshot and content scripts`, async () => {
    const bridge = injectionBridge();
    if (route === 'toolbar') bridge.action[0](bridge.tab);
    else bridge.commands[0]('find_images');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.injected)), [
      ['extension_helpers.js', 'html2canvas.min.js', 'screenshot.js', 'content_script.js']
    ]);
  });
}

test('parsed packaged image patterns match their configured image URL shapes', () => {
  const cases = [
    ['int.aubade.com', 'https://int.aubade.com/cdn/shop/files/ABC123_BLACK_1.jpg'],
    ['us.chantelle.com', 'https://imagedelivery.net/abc/prod/production/slot/ABC-123/DEF-456/w=1024'],
    ['www.empreinte.eu', 'https://www.empreinte.eu/in/12345-large_default/cassiopee.jpg']
  ];
  for (const [domain, url] of cases) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site_config', `${domain}.json`)));
    for (const [scope, pattern] of [['site', config.imageUrlPattern],
      ['product', config.product.imageUrlPattern]]) {
      assert.equal(new RegExp(pattern).test(url), true, `${domain} ${scope}: ${pattern}`);
    }
  }
});

function legacyDownloadBridge(savedFilename = null) {
  const events = [];
  let request;
  const chrome = {
    runtime: {lastError: null},
    downloads: {
      onChanged: {addListener(fn) { events.push(fn); }, removeListener(fn) {
        events.splice(events.indexOf(fn), 1);
      }},
      download(options, callback) { request = options; callback(7); },
      search(_query, callback) { callback([{filename: '/tmp/Downloads/' +
        (savedFilename || request.filename)}]); }
    }
  };
  const start = background.indexOf('async function saveToDownloads(');
  const end = background.indexOf('// Build the full storage path', start);
  const sandbox = {chrome, CONFIG: {local: {baseFolder: 'Gold Evidence'}},
    blobToDataUrl: async () => 'data:image/jpeg;base64,YQ==',
    PageImageSaverHelpers: require('../extension_helpers.js')};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(background.slice(start, end), sandbox, {filename: 'legacy-download.js'});
  return {chrome, events, getRequest: () => request,
    save: () => sandbox.saveToDownloads(new Blob(['image'], {type: 'image/jpeg'}), 'one.jpg', 'shop.example.test')};
}

test('legacy image save waits for terminal completion before reporting success', async () => {
  const bridge = legacyDownloadBridge();
  let settled = false;
  const pending = bridge.save().then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(bridge.getRequest().filename, 'Gold Evidence/shop.example.test/one.jpg');
  bridge.events[0]({id: 7, state: {current: 'complete'}});
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.fullPath, 'Gold Evidence/shop.example.test/one.jpg');
});

test('legacy image save rejects an interrupted download after its ID callback', async () => {
  const bridge = legacyDownloadBridge();
  const pending = bridge.save();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  bridge.events[0]({id: 7, state: {current: 'interrupted'},
    error: {current: 'FILE_FAILED'}});
  await assert.rejects(pending, /FILE_FAILED/);
});

test('manual overwrite rejects an unexpected uniquified terminal filename', async () => {
  const bridge = legacyDownloadBridge('Gold Evidence/shop.example.test/one (1).jpg');
  const pending = bridge.save();
  const rejected = assert.rejects(pending, /filename mismatch/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.events.length, 1);
  bridge.events[0]({id: 7, state: {current: 'complete'}});
  await rejected;
});

test('renamed image and sidecar with different stems are reported as incomplete', async () => {
  const start = background.indexOf('async function processImage(');
  const end = background.indexOf('// Normalize Shopify CDN URLs', start);
  const saved = [];
  const sandbox = {
    Blob, URL, Date,
    console: {log() {}, warn() {}, error() {}},
    CONFIG: {minFileSize: 0, useDomainFolders: true,
      local: {enabled: true, saveJson: true, subfolderPerDomain: true}},
    downloadImage: async () => new Blob(['image'], {type: 'image/jpeg'}),
    getFilename: () => 'one.jpg',
    createImageBitmap: async () => ({width: 100, height: 200, close() {}}),
    isConfigValid: () => false, debugLog() {},
    saveToDownloads: async (_blob, filename) => {
      saved.push(filename);
      return {success: true, type: 'local', fullPath: 'Gold Evidence/shop.example.test/' +
        (filename.endsWith('.jpg') ? 'one (1).jpg' : 'one.json')};
    }
  };
  vm.runInNewContext(background.slice(start, end), sandbox, {filename: 'process-image.js'});
  const result = await sandbox.processImage({url: 'https://cdn.example.test/one.jpg'},
    {url: 'https://shop.example.test/product'});
  assert.deepEqual(saved, ['one.jpg', 'one.json']);
  assert.equal(result.success, false);
  assert.equal(result.nonRetryable, true);
  assert.equal(result.savedImagePath, 'Gold Evidence/shop.example.test/one (1).jpg');
  assert.match(result.error, /sidecar.*filename/i);
});
