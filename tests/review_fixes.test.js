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

test('getElementsForFixedCheck reaches nested descendants once across overlapping added nodes', () => {
  const grandchild = { nodeType: 1, children: [] };
  const child = { nodeType: 1, children: [grandchild] };
  const node = { nodeType: 1, children: [child] };
  const seen = new WeakSet();

  assert.deepEqual([...helpers.getElementsForFixedCheck(node, seen)], [node, child, grandchild]);
  assert.deepEqual([...helpers.getElementsForFixedCheck(child, seen)], []);
});

test('getSafeCanvasSize accepts a complete page within both edge and area limits', () => {
  assert.deepEqual(helpers.getSafeCanvasSize(1000, 3000, 2), {
    width: 2000, height: 6000
  });
  assert.deepEqual(helpers.getSafeCanvasSize(8192, 8192, 1), {
    width: 8192, height: 8192
  });
});

test('getSafeCanvasSize rejects pages requiring truncation with a visible-area alternative', () => {
  assert.throws(() => helpers.getSafeCanvasSize(20000, 100, 2), /canvas width.*visible-area/i);
  assert.throws(() => helpers.getSafeCanvasSize(1000, 100000, 2), /canvas height.*visible-area/i);
  assert.throws(() => helpers.getSafeCanvasSize(9000, 9000, 1), /pixel area.*visible-area/i);
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

function loadFullPageScreenshot({ width = 100, height = 300, viewportWidth = 100,
  dpr = 1, context = { drawImage() {} }, onStyleCheck = () => {},
  scheduleTimeout = callback => callback() } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'screenshot.js'), 'utf8');
  const container = { style: { display: 'block' } };
  let observer;
  const window = {
    devicePixelRatio: dpr, innerWidth: viewportWidth, innerHeight: 100,
    scrollX: 0, scrollY: 25, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; }
  };
  const sandbox = {
    window,
    console: { log() {}, error() {} },
    setTimeout: scheduleTimeout,
    document: {
      getElementById: id => id === 'image-selector-container' ? container : null,
      querySelectorAll: () => [],
      createElement: () => ({
        getContext: () => context,
        toDataURL: () => 'data:image/jpeg;base64,ok'
      }),
      documentElement: { scrollWidth: width, scrollHeight: height },
      body: {}
    },
    MutationObserver: class {
      constructor(callback) { observer = this; this.callback = callback; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    Image: class {
      set src(value) { this.onload(); }
    },
    getComputedStyle: el => { onStyleCheck(); return { position: el.position || 'static' }; },
    PageImageSaverHelpers: helpers
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'screenshot.js' });
  return { screenshot: window.PageScreenshot, container, window, getObserver: () => observer };
}

test('full-page capture hides late fixed grandchildren before the next strip and restores them', async () => {
  const page = loadFullPageScreenshot();
  const fixed = { nodeType: 1, children: [], position: 'fixed', style: { visibility: 'visible' }, dataset: {} };
  const child = { nodeType: 1, children: [fixed], style: {}, dataset: {} };
  const root = { nodeType: 1, children: [child], style: {}, dataset: {} };
  let strips = 0;
  page.screenshot.captureVisiblePart = async () => {
    strips += 1;
    if (strips === 1) {
      page.getObserver().callback([{ type: 'childList', addedNodes: [root, child] }]);
    }
    if (strips === 2) assert.equal(fixed.style.visibility, 'hidden');
    return 'data:image/png;base64,ok';
  };

  await page.screenshot.captureFullPage();

  assert.equal(strips, 3);
  assert.equal(fixed.style.visibility, 'visible');
  assert.equal(page.getObserver().disconnected, true);
  assert.equal(page.container.style.display, '');
  assert.equal(page.window.scrollY, 25);
});

test('full-page mutation callback schedules large descendant scans in bounded batches', async () => {
  let styleChecks = 0;
  const page = loadFullPageScreenshot({ onStyleCheck: () => { styleChecks++; } });
  const root = { nodeType: 1, children: [], style: {}, dataset: {} };
  let current = root;
  for (let i = 0; i < 250; i++) {
    const child = { nodeType: 1, children: [], style: {}, dataset: {} };
    current.children.push(child);
    current = child;
  }
  let captures = 0;
  page.screenshot.captureVisiblePart = async () => {
    if (++captures === 1) {
      page.getObserver().callback([{ type: 'childList', addedNodes: [root] }]);
      assert.ok(styleChecks <= 100, `mutation callback scanned ${styleChecks} nodes`);
    }
    return 'data:image/png;base64,ok';
  };

  await page.screenshot.captureFullPage();
  assert.equal(styleChecks, 251);
});

test('aborted full-page capture does not hide nodes from a pending scan after cleanup', async () => {
  const pendingScanTimers = [];
  const page = loadFullPageScreenshot({
    scheduleTimeout: (callback, delay) => {
      if (delay === 0) pendingScanTimers.push(callback);
      else callback();
    }
  });
  const fixed = { nodeType: 1, children: [], position: 'fixed', style: { visibility: 'visible' }, dataset: {} };
  let root = fixed;
  for (let i = 0; i < 101; i++) {
    root = { nodeType: 1, children: [root], style: {}, dataset: {} };
  }
  page.screenshot.captureVisiblePart = async () => {
    page.getObserver().callback([{ type: 'childList', addedNodes: [root] }]);
    throw new Error('capture failed');
  };

  await assert.rejects(page.screenshot.captureFullPage(), /capture failed/);
  assert.equal(fixed.style.visibility, 'visible');
  for (const callback of pendingScanTimers) callback();
  await Promise.resolve();
  assert.equal(fixed.style.visibility, 'visible');
});

test('full-page capture rejects an overwide canvas before capture and restores page state', async () => {
  const page = loadFullPageScreenshot({ width: 20000, viewportWidth: 20000 });
  let captures = 0;
  page.screenshot.captureVisiblePart = async () => { captures++; return 'data:image/png;base64,ok'; };

  await assert.rejects(page.screenshot.captureFullPage(), /canvas width/i);

  assert.equal(captures, 0);
  assert.equal(page.getObserver().disconnected, true);
  assert.equal(page.container.style.display, '');
  assert.equal(page.window.scrollY, 25);
});

test('full-page capture rejects horizontal overflow before saving a blank right edge', async () => {
  const page = loadFullPageScreenshot({width: 200, viewportWidth: 100});
  let captures = 0;
  page.screenshot.captureVisiblePart = async () => { captures++; return 'data:image/png;base64,ok'; };

  await assert.rejects(page.screenshot.captureFullPage(), /horizontal.*visible-area/i);

  assert.equal(captures, 0);
  assert.equal(page.getObserver().disconnected, true);
  assert.equal(page.container.style.display, '');
  assert.equal(page.window.scrollX, 0);
  assert.equal(page.window.scrollY, 25);
});

test('full-page capture rejects a wide long page before capturing a partial image', async () => {
  const page = loadFullPageScreenshot({ width: 3840, height: 10000, dpr: 2 });
  let captures = 0;
  page.screenshot.captureVisiblePart = async () => { captures++; return 'data:image/png;base64,ok'; };

  await assert.rejects(page.screenshot.captureFullPage(), /visible-area/i);

  assert.equal(captures, 0);
  assert.equal(page.getObserver().disconnected, true);
  assert.equal(page.container.style.display, '');
  assert.equal(page.window.scrollY, 25);
});

test('full-page capture reports unavailable 2D context and restores page state', async () => {
  const page = loadFullPageScreenshot({ context: null });
  let captures = 0;
  page.screenshot.captureVisiblePart = async () => { captures++; return 'data:image/png;base64,ok'; };

  await assert.rejects(page.screenshot.captureFullPage(), /2D canvas context/i);

  assert.equal(captures, 0);
  assert.equal(page.getObserver().disconnected, true);
  assert.equal(page.container.style.display, '');
  assert.equal(page.window.scrollY, 25);
});
