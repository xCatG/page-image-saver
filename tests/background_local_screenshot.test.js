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
  const sandbox = {
    PageImageSaverHelpers: helpers,
    Blob,
    URL,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    decodeURIComponent,
    navigator: { userAgent: 'Chrome' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    chrome: {
      runtime: {
        onMessage: chromeEvent(listeners),
        onInstalled: chromeEvent(),
        lastError: null
      },
      webRequest: { onCompleted: chromeEvent() },
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
    .replace("import './extension_helpers.js';", '');
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

  for (const listener of listeners) {
    listener({ action: 'captureFailureNotice', reason: 'automatic product gallery readiness timeout' },
      { tab: { id: 1, windowId: 1 } }, () => {});
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /gallery readiness timeout/);
});
