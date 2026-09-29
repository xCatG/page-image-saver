const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helpers = require('../extension_helpers.js');

test('folder paths preserve safe tag subfolders and Unicode', () => {
  assert.equal(helpers.sanitizeFolderPath('x.com/下着売ります'), 'x.com/下着売ります');
  assert.equal(helpers.sanitizeFolderPath('x.com\\制服売ります'), 'x.com/制服売ります');
});

test('folder paths reject traversal and invalid Windows names', () => {
  assert.equal(helpers.sanitizeFolderPath('../x.com/制服売ります'), 'x.com/制服売ります');
  assert.equal(helpers.sanitizeFolderPath('x.com/../../CON/hi:there'), 'x.com/_CON/hi_there');
});

test('page shortcut only matches outside editable controls', () => {
  const event = { key: 'I', altKey: true, shiftKey: true, ctrlKey: true, metaKey: false, target: { tagName: 'DIV', isContentEditable: false } };
  assert.equal(helpers.isFindImagesPageShortcut(event), true);
  assert.equal(helpers.isFindImagesPageShortcut({ ...event, target: { tagName: 'INPUT', isContentEditable: false } }), false);
  assert.equal(helpers.isFindImagesPageShortcut({ ...event, ctrlKey: false }), false);
});

test('filenameFromUrl returns fallback for missing or non-string URLs', () => {
  assert.equal(helpers.filenameFromUrl(null, 'fallback.jpg'), 'fallback.jpg');
  assert.equal(helpers.filenameFromUrl(undefined, 'fallback.jpg'), 'fallback.jpg');
  assert.equal(helpers.filenameFromUrl({ url: 'https://example.test/a.jpg' }, 'fallback.jpg'), 'fallback.jpg');
});

test('filenameFromUrl extracts a clean filename from valid URLs', () => {
  assert.equal(
    helpers.filenameFromUrl('https://example.test/images/product%201.jpg?width=1200#hero'),
    'product 1.jpg'
  );
});

test('getScrollStep falls back when viewport height is unavailable', () => {
  assert.equal(helpers.getScrollStep(0), 500);
  assert.equal(helpers.getScrollStep(undefined), 500);
  assert.equal(helpers.getScrollStep(720), 720);
});

test('getSafeCanvasHeight caps full-page screenshots to browser-safe dimensions', () => {
  assert.equal(helpers.getSafeCanvasHeight(100000, 1), 16384);
  assert.equal(helpers.getSafeCanvasHeight(100000, 2), 8192);
  assert.equal(helpers.getSafeCanvasHeight(900, 2), 900);
});

test('getElementsForFixedCheck inspects added nodes and immediate children only', () => {
  const grandchild = { nodeType: 1, children: [] };
  const child = { nodeType: 1, children: [grandchild] };
  const node = { nodeType: 1, children: [child] };

  assert.deepEqual(helpers.getElementsForFixedCheck(node), [node, child]);
});

test('buildCaptureVisibleTabResponse propagates background capture errors', () => {
  assert.deepEqual(
    helpers.buildCaptureVisibleTabResponse({ message: 'quota exceeded' }, undefined),
    { error: 'quota exceeded' }
  );
  assert.deepEqual(
    helpers.buildCaptureVisibleTabResponse(null, 'data:image/png;base64,abc'),
    { dataUrl: 'data:image/png;base64,abc' }
  );
});

test('buildGoldCaptureSettings enables local sidecar evidence under the configured base folder', () => {
  const settings = {
    useS3: true,
    s3: {
      region: 'us-west-2',
      bucketName: 'private-bucket',
      folderPath: 'existing/',
      accessKeyId: 's3-key',
      secretAccessKey: 's3-secret',
      makePublic: true
    },
    r2: {
      accountId: 'account-id',
      bucketName: 'r2-bucket',
      folderPath: 'existing/',
      useApiToken: true,
      accessKeyId: 'r2-key',
      secretAccessKey: 'r2-secret',
      apiToken: 'r2-token',
      makePublic: true
    },
    local: {
      enabled: false,
      subfolderPerDomain: false,
      saveJson: false,
      baseFolder: 'Gold Evidence'
    },
    preserveFilenames: false,
    minFileSize: 1234
  };

  const result = helpers.buildGoldCaptureSettings(settings);

  assert.deepEqual(result.local, {
    enabled: true,
    subfolderPerDomain: true,
    saveJson: true,
    baseFolder: 'Gold Evidence'
  });
  assert.equal(result.preserveFilenames, false);
  assert.equal(result.minFileSize, 1234);
});

test('buildGoldCaptureSettings removes cloud destinations, credentials, and public access', () => {
  const result = helpers.buildGoldCaptureSettings({
    useS3: false,
    s3: {
      region: 'us-west-2',
      bucketName: 'private-bucket',
      folderPath: 'existing/',
      accessKeyId: 's3-key',
      secretAccessKey: 's3-secret',
      makePublic: true
    },
    r2: {
      accountId: 'account-id',
      bucketName: 'r2-bucket',
      folderPath: 'existing/',
      useApiToken: true,
      accessKeyId: 'r2-key',
      secretAccessKey: 'r2-secret',
      apiToken: 'r2-token',
      makePublic: true
    },
    local: { baseFolder: 'PageImageSaver' }
  });

  assert.deepEqual(result.s3, {
    region: '',
    bucketName: '',
    folderPath: '',
    accessKeyId: '',
    secretAccessKey: '',
    makePublic: false
  });
  assert.deepEqual(result.r2, {
    accountId: '',
    bucketName: '',
    folderPath: '',
    useApiToken: false,
    accessKeyId: '',
    secretAccessKey: '',
    apiToken: '',
    makePublic: false
  });
});

test('captureVisiblePart retries quota errors returned by the background script', async () => {
  const screenshotPath = path.join(__dirname, '..', 'screenshot.js');
  const source = fs.readFileSync(screenshotPath, 'utf8');
  let attempts = 0;

  const sandbox = {
    console,
    setTimeout: (fn) => fn(),
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, getContext: () => ({}) }),
      documentElement: { scrollWidth: 100, scrollHeight: 100 },
      body: {}
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (_message, callback) => {
          attempts += 1;
          if (attempts === 1) {
            callback({ error: 'quota exceeded' });
          } else {
            callback({ dataUrl: 'data:image/png;base64,ok' });
          }
        }
      }
    },
    Image: function Image() {},
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    getComputedStyle: () => ({ position: 'static' })
  };
  sandbox.PageImageSaverHelpers = helpers;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: screenshotPath });

  const dataUrl = await sandbox.window.PageScreenshot.captureVisiblePart();
  assert.equal(dataUrl, 'data:image/png;base64,ok');
  assert.equal(attempts, 2);
});
