const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helpers = require('../extension_helpers.js');

function chromeEvent(listeners = []) {
  return {
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

test('processScreenshot saves locally when cloud storage is invalid', async () => {
  const listeners = [];
  const downloads = [];
  const openedTabs = [];
  const responses = [];
  const notices = [];
  const logs = [];
  const settings = {
    useS3: true,
    s3: {
      region: '', bucketName: '', folderPath: '', accessKeyId: '',
      secretAccessKey: '', makePublic: false
    },
    r2: {
      accountId: '', bucketName: '', folderPath: '', useApiToken: false,
      accessKeyId: '', secretAccessKey: '', apiToken: '', makePublic: false
    },
    local: {
      enabled: true,
      subfolderPerDomain: true,
      saveJson: true,
      baseFolder: 'Gold Evidence'
    },
    retry: { enabled: true, maxRetries: 3, showNotification: true },
    preserveFilenames: true,
    addMetadata: true,
    maxConcurrentUploads: 3,
    minFileSize: 0,
    useDomainFolders: true,
    progressUpdateInterval: 5
  };
  settings.receiver = {enabled: true, url: 'http://127.0.0.1:8765', token: 'must-not-log-receiver-token'};
  const sandbox = {
    PageImageSaverHelpers: helpers,
    PageImageSaverTakeover: require('../takeover_runner.js'),
    Blob,
    URL,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    decodeURIComponent,
    navigator: { userAgent: 'Chrome' },
    console: { log(...items) { logs.push(items); }, warn() {}, error() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    chrome: {
      runtime: {
        onMessage: chromeEvent(listeners),
        onInstalled: chromeEvent(),
        onStartup: chromeEvent(),
        lastError: null
      },
      webRequest: { onCompleted: chromeEvent() },
      alarms: {onAlarm: chromeEvent(), create() {}},
      storage: {
        sync: { get: (_key, callback) => callback({ imageUploaderSettings: settings }) },
        local: {
          get: (_key, callback) => callback({ failedUploads: [] }),
          set: (_value, callback) => { if (callback) callback(); }
        },
        onChanged: chromeEvent()
      },
      contextMenus: {
        removeAll: callback => callback(),
        create() {},
        onClicked: chromeEvent()
      },
      notifications: { create: notice => notices.push(notice) },
      action: { onClicked: chromeEvent() },
      commands: { onCommand: chromeEvent() },
      scripting: { executeScript: () => Promise.resolve([]) },
      tabs: {
        create: tab => openedTabs.push(tab),
        sendMessage() {},
        query() {},
        captureVisibleTab() {}
      },
      downloads: {
        search: (_query, callback) => callback([]),
        download: (request, callback) => {
          downloads.push(request);
          callback(1);
        }
      }
    }
  };
  sandbox.globalThis = sandbox;

  const backgroundPath = path.join(__dirname, '..', 'background.js');
  const source = fs.readFileSync(backgroundPath, 'utf8')
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  vm.runInNewContext(source, sandbox, { filename: backgroundPath });

  const message = {
    action: 'processScreenshot',
    screenshot: 'data:image/png;base64,YQ==',
    filename: 'product.png',
    metadata: { url: 'https://shop.example.com/products/one' }
  };
  for (const listener of listeners) {
    listener(message, { tab: { id: 1, windowId: 1 } }, response => responses.push(response));
  }

  await new Promise(resolve => setImmediate(resolve));

  assert.equal(openedTabs.length, 0);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'Gold Evidence/shop.example.com/product.png');
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [
    { success: true, url: 'File saved' }
  ]);
  sandbox.downloadImage = async () => new Blob(['image'], {type: 'image/png'});
  const imageResult = await sandbox.processImage({url: 'https://shop.example.com/product.png'},
    {url: 'https://shop.example.com/products/one'});
  assert.equal(imageResult.success, true);
  assert.ok(logs.some(items => items[0] === 'Processing image with current config:'));
  assert.ok(!JSON.stringify(logs).includes(settings.receiver.token));

  for (const listener of listeners) {
    listener({ action: 'captureFailureNotice', reason: 'automatic product gallery readiness timeout' },
      { tab: { id: 1, windowId: 1 } }, () => {});
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /gallery readiness timeout/);
});

test('selected image reports incomplete evidence when its JSON sidecar download fails', async () => {
  const downloads = [];
  const listeners = [];
  const completionMessages = [];
  const settings = {
    useS3: true,
    s3: { region: '', bucketName: '', folderPath: '', accessKeyId: '', secretAccessKey: '', makePublic: false },
    r2: { accountId: '', bucketName: '', folderPath: '', useApiToken: false, accessKeyId: '', secretAccessKey: '', apiToken: '', makePublic: false },
    local: { enabled: true, subfolderPerDomain: true, saveJson: true, baseFolder: 'Gold Evidence' },
    retry: { enabled: true, maxRetries: 3, showNotification: true },
    preserveFilenames: true, addMetadata: true, maxConcurrentUploads: 3,
    minFileSize: 0, useDomainFolders: true, progressUpdateInterval: 5
  };
  const sandbox = {
    PageImageSaverHelpers: helpers, PageImageSaverTakeover: require('../takeover_runner.js'),
    Blob, URL, Uint8Array, ArrayBuffer, atob, btoa, decodeURIComponent,
    navigator: { userAgent: 'Chrome' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) }),
    createImageBitmap: async () => ({ width: 100, height: 200, close() {} }),
    chrome: {
      runtime: { onMessage: chromeEvent(listeners), onInstalled: chromeEvent(),
        onStartup: chromeEvent(), lastError: null },
      webRequest: { onCompleted: chromeEvent() },
      alarms: {onAlarm: chromeEvent(), create() {}},
      storage: {
        sync: { get: (_key, callback) => callback({ imageUploaderSettings: settings }) },
        local: { get: (_key, callback) => callback({ failedUploads: [] }), set: (_value, callback) => { if (callback) callback(); } },
        onChanged: chromeEvent()
      },
      contextMenus: { removeAll: callback => callback(), create() {}, onClicked: chromeEvent() },
      notifications: { create() {} },
      action: { onClicked: chromeEvent() },
      commands: { onCommand: chromeEvent() },
      scripting: { executeScript: () => Promise.resolve([]) },
      tabs: {
        create() {}, query() {}, captureVisibleTab() {},
        sendMessage: (_tabId, message, callback) => {
          if (message.action === 'uploadComplete') completionMessages.push(message);
          if (callback) callback({ received: true });
        }
      },
      downloads: {
        search: (_query, callback) => callback([]),
        download: (request, callback) => {
          downloads.push(request.filename);
          if (request.filename.endsWith('.json')) {
            sandbox.chrome.runtime.lastError = { message: 'disk write failed' };
            callback(undefined);
            sandbox.chrome.runtime.lastError = null;
          } else {
            callback(1);
          }
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  const backgroundPath = path.join(__dirname, '..', 'background.js');
  const source = fs.readFileSync(backgroundPath, 'utf8')
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: backgroundPath });

  const result = await vm.runInContext(
    "processImage({ url: 'https://shop.example.com/one.jpg' }, { url: 'https://shop.example.com/products/one', title: 'One' })",
    context
  );

  assert.deepEqual(downloads, [
    'Gold Evidence/shop.example.com/one.jpg',
    'Gold Evidence/shop.example.com/one.json'
  ]);
  assert.equal(result.success, false);
  assert.match(result.error, /JSON sidecar.*disk write failed/i);
  assert.match(result.error, /image.*saved/i);
  assert.equal(result.results[0].fullPath, 'Gold Evidence/shop.example.com/one.jpg');

  const request = {
    action: 'saveImages',
    images: [{ url: 'https://shop.example.com/one.jpg' }],
    sourceUrl: 'https://shop.example.com/products/one',
    pageTitle: 'One'
  };
  for (const listener of listeners) listener(request, { tab: { id: 1 } }, () => {});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(completionMessages.length, 1);
  assert.equal(completionMessages[0].success, false);
  assert.equal(completionMessages[0].count, 0);
  assert.equal(completionMessages[0].failures, 1);
  assert.match(completionMessages[0].error, /JSON sidecar/i);
});
