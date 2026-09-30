const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helpers = require('../extension_helpers.js');

test('JSON-LD product extraction keeps recorded color, price, and currency', () => {
  const value = helpers.captureProductFromJsonLd([
    JSON.stringify({'@graph': [{'@type': 'BreadcrumbList'}, {'@type': 'Product', name: 'Fixture bra',
      sku: 'BRA-1', color: 'Black', offers: {price: '42.00', priceCurrency: 'USD'}}]})
  ]);
  assert.deepEqual(value, {name: 'Fixture bra', sku: 'BRA-1', product_id: null,
    color: 'Black', offers: {price: '42.00', currency: 'USD'}});
});

test('unknown product facts remain explicit and per-URL identity keeps unknown color', () => {
  assert.deepEqual(helpers.captureProductFromJsonLd([]), {name: null, sku: null,
    product_id: null, color: null, offers: {price: null, currency: null}});
  assert.deepEqual(helpers.captureIdentity('https://shop.example.test/bra-red#details', 'url', null),
    {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra-red',
      selected_color: null, color_key: 'url'});
  assert.throws(() => helpers.captureIdentity('https://shop.example.test/bra', 'color', null), /selected color/);
});

test('URL-only identity key ignores recorded color while in-place colors stay distinct', () => {
  const unknown = helpers.captureIdentity('https://shop.example.test/bra-red', 'url', null);
  const known = helpers.captureIdentity('https://shop.example.test/bra-red', 'url', 'Red');
  assert.notDeepEqual(unknown, known);
  assert.deepEqual(helpers.captureIdentityKey(unknown), {
    color_key: 'url', domain: 'shop.example.test', product_url: 'https://shop.example.test/bra-red'
  });
  assert.deepEqual(helpers.captureIdentityKey(unknown), helpers.captureIdentityKey(known));
  const black = helpers.captureIdentity('https://shop.example.test/bra', 'color', 'Black');
  const red = helpers.captureIdentity('https://shop.example.test/bra', 'color', 'Red');
  assert.deepEqual(helpers.captureIdentityKey(black), {
    color_key: 'color', domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
    selected_color: 'Black'
  });
  assert.notDeepEqual(helpers.captureIdentityKey(black), helpers.captureIdentityKey(red));
});

test('high-resolution transform preserves the exact original URL', () => {
  assert.deepEqual(helpers.captureImageUrls('https://cdn.example.test/bra/w=1024',
    {find: '/w=1024', replace: '/w=2048'}),
    {original_url: 'https://cdn.example.test/bra/w=1024',
      fetched_url: 'https://cdn.example.test/bra/w=2048'});
});

test('packaged Aubade transform sets width query without changing original URL', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site_config', 'int.aubade.com.json')));
  const original = 'https://int.aubade.com/cdn/shop/files/BRA_BLACK_1.jpg?width=800&crop=center';
  assert.deepEqual(helpers.captureImageUrls(original, config.product.highResTransform), {
    original_url: original,
    fetched_url: 'https://int.aubade.com/cdn/shop/files/BRA_BLACK_1.jpg?width=2400&crop=center'
  });
});

test('in-place color waits for both changed color and changed stable gallery', async () => {
  const states = [
    {color: 'Red', gallery: ['black.png']},
    {color: 'Red', gallery: ['red.png']},
    {color: 'Red', gallery: ['red.png']}
  ];
  const result = await helpers.waitForCaptureState(() => states.shift() || {color: 'Red', gallery: ['red.png']},
    {color: 'Black', gallery: ['black.png']}, {timeoutMs: 100, pollMs: 0, delay: async () => {}});
  assert.deepEqual(result, {color: 'Red', gallery: ['red.png']});
});

test('gallery-first swatch transition waits for the new color before capture', async () => {
  let now = 0;
  const result = await helpers.waitForCaptureState(
    () => now < 600 ? {color: 'Black', gallery: ['red.png']} : {color: 'Red', gallery: ['red.png']},
    {color: 'Black', gallery: ['black.png']},
    {timeoutMs: 1200, pollMs: 200, now: () => now, delay: async ms => { now += ms; }});
  assert.deepEqual(result, {color: 'Red', gallery: ['red.png']});
  assert.ok(now >= 600);
});

test('mismatched in-place color/gallery state times out without a completion', async () => {
  let now = 0;
  await assert.rejects(() => helpers.waitForCaptureState(
    () => ({color: 'Red', gallery: ['black.png']}),
    {color: 'Black', gallery: ['black.png']},
    {timeoutMs: 5, pollMs: 1, now: () => ++now, delay: async () => {}}), /timeout/);
});

test('same-color changed selection requires explicit manual recapture intent', async () => {
  let now = 0;
  await assert.rejects(() => helpers.waitForCaptureState(
    () => ({color: 'Black', gallery: ['black-detail.png']}),
    {color: 'Black', gallery: ['black-front.png']},
    {timeoutMs: 5, pollMs: 1, now: () => now, delay: async ms => { now += ms; }}), /timeout/);
  const result = await helpers.waitForCaptureState(
    () => ({color: 'Black', gallery: ['black-detail.png']}),
    {color: 'Black', gallery: ['black-front.png']},
    {timeoutMs: 100, pollMs: 0, delay: async () => {}, allowSameColorGalleryChange: true});
  assert.deepEqual(result.gallery, ['black-detail.png']);
});

test('manual same-color opt-in cannot override a selected-swatch color contradiction', async () => {
  let now = 0;
  await assert.rejects(() => helpers.waitForCaptureState(
    () => ({color: 'Black', gallery: ['red.png'], colorConflict: true}),
    {color: 'Black', gallery: ['black.png']},
    {timeoutMs: 5, pollMs: 1, now: () => now, delay: async ms => { now += ms; },
      allowSameColorGalleryChange: true}), /timeout/);
});

test('auto capture waits for a delayed gallery on a recognized product', async () => {
  let now = 0;
  const ready = await helpers.waitForAutoCaptureReady(
    () => ({productSeen: true, gallery: now < 600 ? [] : ['https://example.test/red.png']}),
    {timeoutMs: 1200, pollMs: 200, now: () => now, delay: async ms => { now += ms; }});
  assert.equal(ready, true);
  assert.ok(now >= 600);
});

test('auto capture reports bounded timeout for recognized product without gallery', async () => {
  let now = 0;
  await assert.rejects(() => helpers.waitForAutoCaptureReady(
    () => ({productSeen: true, gallery: []}),
    {timeoutMs: 5, pollMs: 1, now: () => now, delay: async ms => { now += ms; }}), /gallery readiness timeout/);
});

test('auto capture leaves non-product page alone after readiness window', async () => {
  let now = 0;
  const ready = await helpers.waitForAutoCaptureReady(
    () => ({productSeen: false, gallery: []}),
    {timeoutMs: 5, pollMs: 1, now: () => now, delay: async ms => { now += ms; }});
  assert.equal(ready, false);
});

test('auto capture does not mistake a matching gallery alone for a product', async () => {
  let now = 0;
  const ready = await helpers.waitForAutoCaptureReady(
    () => ({productSeen: false, gallery: ['https://example.test/promo.png']}),
    {timeoutMs: 5, pollMs: 1, now: () => now, delay: async ms => { now += ms; }});
  assert.equal(ready, false);
});

test('capture timeout is stored locally and sent to the visible failure notice', async () => {
  let stored = {captureFailures: []};
  const messages = [];
  const chrome = {
    runtime: {lastError: null, sendMessage(message, callback) { messages.push(message); callback({success: true}); }},
    storage: {local: {
      get(_defaults, callback) { callback(stored); },
      set(value, callback) { stored = value; callback(); }
    }}
  };
  await helpers.recordCaptureFailure(chrome, 'https://shop.example.test/bra',
    new Error('automatic product gallery readiness timeout'), '2026-09-29T12:00:00Z');
  assert.deepEqual(stored.captureFailures, [{url: 'https://shop.example.test/bra',
    at: '2026-09-29T12:00:00Z', reason: 'automatic product gallery readiness timeout'}]);
  assert.deepEqual(messages, [{action: 'captureFailureNotice',
    reason: 'automatic product gallery readiness timeout'}]);
});

test('completion record has strict versioned evidence and scope fields', () => {
  const record = helpers.buildCaptureCompletion({
    identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
      selected_color: 'Black', color_key: 'color'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'unclassified'},
    product: {name: 'Fixture bra', sku: 'BRA-1', product_id: null,
      color: 'Black', offers: {price: '42.00', currency: 'USD'}},
    html: {path: 'page.html', sha256: 'a'.repeat(64), bytes: 4},
    jsonld: {path: 'product.json', sha256: 'b'.repeat(64), bytes: 5},
    images: [{path: 'images/0.png', sha256: 'c'.repeat(64), bytes: 6,
      original_url: 'https://cdn.example.test/1024.png', fetched_url: 'https://cdn.example.test/2048.png'}]
  });
  assert.equal(record.format, 'page-image-saver-capture/v1');
  assert.equal(record.schema_version, 1);
  assert.equal(record.scope.decision, 'review');
  assert.equal(record.evidence.images[0].original_url, 'https://cdn.example.test/1024.png');
});

test('local export saves all evidence before publishing completion, with no cloud action', async () => {
  const saved = [];
  const payload = {
    identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
      selected_color: 'Black', color_key: 'color'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'manual'},
    product: {name: 'Fixture bra', sku: 'BRA-1', product_id: null,
      color: 'Black', offers: {price: '42.00', currency: 'USD'}},
    html: '<!doctype html><title>Fixture bra</title>',
    jsonld: [{'@type': 'Product', name: 'Fixture bra', color: 'Black'}],
    images: [{original_url: 'https://cdn.example.test/1024.png', fetched_url: 'https://cdn.example.test/2048.png'}]
  };
  const record = await helpers.exportProductCapture(payload, {
    attemptId: '1111111111111111',
    fetchImage: async () => ({bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      fetched_url: 'https://cdn.example.test/2048.png'}),
    saveBytes: async (path, bytes) => saved.push({path, bytes})
  });
  assert.equal(saved.length, 4);
  assert.equal(saved[0].path.endsWith('/page.html'), true);
  assert.equal(saved[1].path.endsWith('/product.json'), true);
  assert.equal(saved[2].path.endsWith('/images/0.png'), true);
  assert.equal(saved[3].path.endsWith('/complete.json'), true);
  assert.equal(JSON.parse(new TextDecoder().decode(saved[3].bytes)).evidence.images[0].sha256,
    record.evidence.images[0].sha256);
});

test('capture export uses short transport paths without domain or digest filenames', async () => {
  const domain = `${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}.example.com`;
  const saved = [];
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0]);
  const record = await helpers.exportProductCapture({
    identity: {domain, product_url: `https://${domain}/bra`, selected_color: null,
      color_key: 'url'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'fixture'},
    product: {name: 'Fixture bra'}, html: '<html></html>', jsonld: [],
    images: [{original_url: 'https://cdn.example.test/bra.jpg',
      fetched_url: 'https://cdn.example.test/bra.jpg'}]
  }, {attemptId: '0123456789abcdef',
    fetchImage: async () => ({bytes, contentType: 'image/jpeg'}),
    saveBytes: async path => saved.push(path)});
  assert.deepEqual(saved.map(path => path.slice(path.lastIndexOf('/') + 1)),
    ['page.html', 'product.json', '0.jpg', 'complete.json']);
  assert.ok(saved.every(path => /^PageImageSaver\/captures\/[a-f0-9]{32}\/0123456789abcdef\//.test(path)));
  assert.ok(saved.every(path => path.length < 120));
  assert.equal(record.evidence.images[0].path, 'images/0.jpg');
  assert.equal(record.evidence.images[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('local export accepts a valid JPEG above the old 25 MiB cap', async () => {
  const bytes = new Uint8Array(25 * 1024 * 1024 + 1);
  bytes.set([0xff, 0xd8, 0xff]);
  const saved = [];
  const record = await helpers.exportProductCapture({
    identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
      selected_color: null, color_key: 'url'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'include', reason: 'Bra'},
    product: {name: 'Fixture bra'}, html: '<html></html>', jsonld: [],
    images: [{original_url: 'https://cdn.example.test/bra.jpg',
      fetched_url: 'https://cdn.example.test/bra.jpg'}]
  }, {attemptId: '2222222222222222',
    fetchImage: async () => ({bytes, contentType: 'image/jpeg'}),
    saveBytes: async filename => saved.push(filename)});
  assert.equal(record.evidence.images[0].bytes, bytes.byteLength);
  assert.equal(saved.length, 4);
  assert.equal(saved[3].endsWith('/complete.json'), true);
});

async function exportImageFixture(fetchedUrl, bytes, contentType) {
  const saved = [];
  const originalUrl = 'https://cdn.example.test/original/w=1024';
  const record = await helpers.exportProductCapture({
    identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
      selected_color: 'Black', color_key: 'color'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'fixture'},
    product: {name: 'Fixture bra'}, html: '<html></html>', jsonld: [],
    images: [{original_url: originalUrl, fetched_url: fetchedUrl}]
  }, {attemptId: '3333333333333333',
    fetchImage: async () => ({bytes, contentType, fetched_url: fetchedUrl}),
    saveBytes: async (filename, data) => saved.push({filename, data})});
  return {record, saved, originalUrl};
}

test('extensionless JPEG image keeps its actual format in saved filename and manifest', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0]);
  const url = 'https://cdn.example.test/bra/w=2048';
  const {record, saved, originalUrl} = await exportImageFixture(url, bytes, 'image/jpeg');
  const image = record.evidence.images[0];
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(image.path, 'images/0.jpg');
  assert.equal(image.original_url, originalUrl);
  assert.equal(image.fetched_url, url);
  assert.equal(image.sha256, digest);
  assert.equal(image.bytes, bytes.byteLength);
  assert.equal(saved[2].filename.endsWith('/' + image.path), true);
  assert.deepEqual(saved[2].data, bytes);
  assert.equal(JSON.parse(new TextDecoder().decode(saved[3].data)).evidence.images[0].path, image.path);
});

test('misleading PNG URL and MIME cannot rename WebP bytes as PNG', async () => {
  const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);
  const {record, saved} = await exportImageFixture(
    'https://cdn.example.test/bra.png', bytes, 'image/png');
  assert.equal(record.evidence.images[0].path, 'images/0.webp');
  assert.equal(saved[2].filename.endsWith('/' + record.evidence.images[0].path), true);
});

test('failed image fetch leaves an uncompleted export', async () => {
  const saved = [];
  await assert.rejects(() => helpers.exportProductCapture({
    identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
      selected_color: 'Black', color_key: 'color'},
    captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'manual'},
    product: {name: null, sku: null, product_id: null, color: 'Black',
      offers: {price: null, currency: null}}, html: '<html></html>', jsonld: [],
    images: [{original_url: 'https://cdn.example.test/a.png', fetched_url: 'https://cdn.example.test/a.png'}]
  }, {attemptId: '4444444444444444', fetchImage: async () => { throw new Error('HTTP 429'); },
    saveBytes: async path => saved.push(path)}), /HTTP 429/);
  assert.equal(saved.some(path => path.endsWith('complete.json')), false);
});

test('Chrome download callback alone never marks capture evidence saved', async () => {
  let onChanged;
  const calls = [];
  const chrome = {
    runtime: {lastError: null},
    downloads: {
      onChanged: {addListener(fn) { onChanged = fn; }, removeListener() {}},
      download(request, callback) { calls.push(request); callback(7); },
      search(query, callback) { callback([{id: query.id, filename: '/tmp/Downloads/' + calls[0].filename}]); }
    }
  };
  let completed = false;
  const promise = helpers.saveCaptureDownload(chrome, 'data:text/plain;base64,YQ==',
    'PageImageSaver/captures/shop.example.test/one/page.html', 1000).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(calls[0].conflictAction, 'uniquify');
  onChanged({id: 7, state: {current: 'complete'}});
  await promise;
  assert.equal(completed, true);
});
