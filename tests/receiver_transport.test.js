const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const helpers = require('../extension_helpers.js');

const payload = {
  identity: {domain: 'shop.example.test', product_url: 'https://shop.example.test/bra',
    selected_color: 'Black', color_key: 'color'},
  captured_at: '2026-09-29T12:00:00Z', scope: {decision: 'review', reason: 'fixture'},
  product: {name: 'Fixture bra', sku: 'BRA-1', product_id: null,
    color: 'Black', offers: {price: '42.00', currency: 'USD'}},
  html: '<html><title>Fixture bra</title></html>',
  jsonld: [{'@type': 'Product', name: 'Fixture bra', color: 'Black'}],
  images: [{original_url: 'https://cdn.example.test/1.png', fetched_url: 'https://cdn.example.test/1.png'}]
};
const settings = {enabled: true, url: 'http://127.0.0.1:8765', token: 'local-test-token'};
const ok = (body, status = 200) => ({ok: status >= 200 && status < 300, status,
  json: async () => body});

test('receiver sends authenticated evidence before completion and returns verified result', async () => {
  const calls = [];
  const result = await helpers.captureWithReceiver(payload, settings, {
    fetch: async (url, options) => {
      calls.push({url, options});
      if (url.endsWith('/already')) return ok({complete: false});
      if (url.endsWith('/evidence')) return ok({sha256: options.headers['X-Content-SHA256'],
        bytes: options.body.byteLength, status: 'stored'}, 201);
      return ok({status: 'published', captured_at: payload.captured_at}, 201);
    },
    fetchImage: async () => ({bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])}),
    download: async () => { throw new Error('unexpected fallback'); },
    delay: async () => {}
  });
  assert.deepEqual(result, {storage: 'receiver', status: 'published', captured_at: payload.captured_at});
  assert.equal(calls.length, 5);
  assert.equal(calls[0].options.headers['X-Capture-Token'], settings.token);
  assert.equal(calls.at(-1).url, settings.url + '/v1/completion');
  assert.equal(JSON.parse(calls.at(-1).options.body).record.scope.decision, 'review');
  const evidence = calls.filter(call => call.url.endsWith('/evidence'));
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every(call => call.options.headers['X-Capture-Domain'] === payload.identity.domain));
  assert.ok(evidence.every(call => /^PageImageSaver\/captures\/[a-f0-9]{32}\/[a-f0-9]{16}\//
    .test(call.options.headers['X-Capture-Path'])));
});

test('transient receiver error retries a bounded number and then succeeds', async () => {
  let attempts = 0;
  const result = await helpers.captureWithReceiver(payload, settings, {
    fetch: async url => {
      attempts++;
      if (attempts < 3) return ok({error: 'busy'}, 503);
      return ok({complete: true, captured_at: '2026-09-28T00:00:00Z'});
    },
    delay: async () => {}, download: async () => { throw new Error('unexpected fallback'); }
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result, {storage: 'receiver', status: 'already', captured_at: '2026-09-28T00:00:00Z'});
});

test('verify-only receiver check never acquires media or exports on a missing identity', async () => {
  let images = 0;
  let downloads = 0;
  const result = await helpers.captureWithReceiver({identity: payload.identity}, settings, {
    verifyOnly: true,
    fetch: async () => ok({complete: false}),
    fetchImage: async () => { images++; throw Error('unexpected image fetch'); },
    download: async () => { downloads++; throw Error('unexpected download'); }
  });
  assert.deepEqual(result, {storage: 'receiver', status: 'missing'});
  assert.equal(images, 0);
  assert.equal(downloads, 0);
});

test('unreachable receiver uses Downloads fallback and never calls cloud', async () => {
  let attempts = 0;
  let downloaded = 0;
  const result = await helpers.captureWithReceiver(payload, settings, {
    fetch: async () => { attempts++; throw new TypeError('Failed to fetch'); },
    download: async () => { downloaded++; return {captured_at: payload.captured_at}; },
    delay: async () => {}
  });
  assert.equal(attempts, 3);
  assert.equal(downloaded, 1);
  assert.equal(result.storage, 'downloads');
  assert.equal(result.status, 'fallback');
});

test('receiver request timeout is bounded and falls back to Downloads', async () => {
  let attempts = 0;
  const result = await helpers.captureWithReceiver(payload, settings, {
    timeoutMs: 5,
    fetch: async (_url, options) => {
      attempts++;
      assert.ok(options.signal, 'receiver request needs an abort signal');
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }));
    },
    download: async () => ({captured_at: payload.captured_at}), delay: async () => {}
  });
  assert.equal(attempts, 3);
  assert.equal(result.storage, 'downloads');
});

test('response body stall is covered by the receiver deadline', async () => {
  let attempts = 0;
  const started = Date.now();
  const result = await helpers.captureWithReceiver(payload, settings, {
    timeoutMs: 5,
    fetch: async () => { attempts++; return {ok: true, status: 200,
      json: () => new Promise(resolve => setTimeout(() => resolve({complete: true,
        captured_at: payload.captured_at}), 40))}; },
    download: async () => ({captured_at: payload.captured_at}), delay: async () => {}
  });
  assert.equal(attempts, 3);
  assert.equal(result.storage, 'downloads');
  assert.ok(Date.now() - started < 1000);
});

test('known HTTP rejection headers stay explicit when the error body stalls', async () => {
  for (const status of [401, 409]) {
    let attempts = 0;
    let downloads = 0;
    await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
      timeoutMs: 5,
      fetch: async () => { attempts++; return {ok: false, status,
        json: () => new Promise(() => {})}; },
      download: async () => { downloads++; return {}; }, delay: async () => {}
    }), new RegExp(`receiver HTTP ${status}`));
    assert.equal(attempts, 1);
    assert.equal(downloads, 0);
  }
});

test('known retryable HTTP headers exhaust explicitly when the error body stalls', async () => {
  let attempts = 0;
  let downloads = 0;
  await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
    timeoutMs: 5,
    fetch: async () => { attempts++; return {ok: false, status: 503,
      json: () => new Promise(() => {})}; },
    download: async () => { downloads++; return {}; }, delay: async () => {}
  }), /receiver HTTP 503/);
  assert.equal(attempts, 3);
  assert.equal(downloads, 0);
});

test('syntactically valid but invalid receiver replies never announce success', async () => {
  for (const body of [{}, {complete: true}, {complete: 'false'}]) {
    await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
      fetch: async () => ok(body), download: async () => { throw new Error('unexpected fallback'); },
      delay: async () => {}
    }), /invalid receiver .*response/);
  }
  for (const badEvidence of [() => ({}), () => ({sha256: '0'.repeat(64), bytes: 1, status: 'stored'}),
    options => ({sha256: options.headers['X-Content-SHA256'], bytes: 999, status: 'stored'})]) {
    await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
      fetch: async (url, options) => url.endsWith('/already') ? ok({complete: false}) :
        url.endsWith('/evidence') ? ok(badEvidence(options), 201) : ok({status: 'published', captured_at: payload.captured_at}, 201),
      fetchImage: async () => ({bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])}),
      download: async () => { throw new Error('unexpected fallback'); }, delay: async () => {}
    }), /invalid receiver evidence response/);
  }
  await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
    fetch: async (url, options) => url.endsWith('/already') ? ok({complete: false}) :
      url.endsWith('/evidence') ? ok({sha256: options.headers['X-Content-SHA256'],
        bytes: options.body.byteLength, status: 'stored'}, 201) : ok({}),
    fetchImage: async () => ({bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])}),
    download: async () => { throw new Error('unexpected fallback'); }, delay: async () => {}
  }), /invalid receiver completion response/);
});

test('receiver redirect never forwards token or capture bytes', async () => {
  const target = {requests: 0, bytes: 0};
  const destination = http.createServer((req, res) => {
    target.requests++;
    req.on('data', chunk => { target.bytes += chunk.length; });
    req.on('end', () => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"complete":true}'); });
  });
  const first = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(307, {Location: `http://127.0.0.1:${destination.address().port}/v1/already`}); res.end(); });
  });
  await Promise.all([new Promise(resolve => destination.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => first.listen(0, '127.0.0.1', resolve))]);
  try {
    const result = await helpers.captureWithReceiver(payload,
      {...settings, url: `http://127.0.0.1:${first.address().port}`},
      {fetch: globalThis.fetch, delay: async () => {}, download: async () => ({})});
    assert.equal(result.storage, 'downloads');
    assert.equal(target.requests, 0);
    assert.equal(target.bytes, 0);
  } finally {
    await Promise.all([new Promise(resolve => first.close(resolve)),
      new Promise(resolve => destination.close(resolve))]);
  }
});

test('auth and conflict errors remain explicit and do not fall through to Downloads', async () => {
  for (const status of [400, 401, 403, 409]) {
    let attempts = 0;
    await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
      fetch: async () => { attempts++; return ok({error: 'rejected'}, status); },
      download: async () => { throw new Error('unexpected fallback'); }, delay: async () => {}
    }), new RegExp(`receiver HTTP ${status}`));
    assert.equal(attempts, 1);
  }
});

test('malformed receiver reply is an explicit protocol failure', async () => {
  let downloaded = 0;
  await assert.rejects(() => helpers.captureWithReceiver(payload, settings, {
    fetch: async () => ({ok: false, status: 409, json: async () => { throw new TypeError('bad JSON'); }}),
    download: async () => { downloaded++; }, delay: async () => {}
  }), /invalid receiver JSON/);
  assert.equal(downloaded, 0);
});

test('capture result message points receiver and Downloads results to the right index command', () => {
  assert.match(helpers.captureResultMessage({storage: 'receiver', status: 'published'}), /capture-index/);
  assert.match(helpers.captureResultMessage({storage: 'receiver', status: 'already'}), /already captured/i);
  assert.match(helpers.captureResultMessage({storage: 'downloads', status: 'fallback'}), /capture-import/);
});

test('background capture message selects receiver without using cloud settings', async () => {
  const listeners = [];
  const event = () => ({addListener(listener) { listeners.push(listener); }});
  const passive = () => ({addListener() {}});
  const responses = [];
  const calls = [];
  const sandbox = {
    PageImageSaverHelpers: helpers, PageImageSaverTakeover: require('../takeover_runner.js'),
    Blob, URL, Uint8Array, ArrayBuffer, atob, btoa,
    navigator: {userAgent: 'Chrome'}, console: {log() {}, warn() {}, error() {}},
    setTimeout: () => 1, clearTimeout() {},
    fetch: async url => { calls.push(url); return ok({complete: true, captured_at: payload.captured_at}); },
    chrome: {
      runtime: {onMessage: event(), onInstalled: passive(), onStartup: passive(), lastError: null},
      webRequest: {onCompleted: passive()},
      alarms: {onAlarm: passive(), create() {}},
      storage: {sync: {get: (_key, callback) => callback({imageUploaderSettings: {
        receiver: settings, useS3: true, s3: {bucketName: 'old-cloud', accessKeyId: 'old', secretAccessKey: 'old'},
        r2: {}, local: {enabled: false}
      }})}, local: {get: (_key, callback) => callback({failedUploads: []}),
        set: (_value, callback) => callback?.()}, onChanged: passive()},
      contextMenus: {removeAll: callback => callback(), create() {}, onClicked: passive()},
      notifications: {create() {}}, action: {onClicked: passive()}, commands: {onCommand: passive()},
      scripting: {executeScript: async () => []},
      tabs: {onRemoved: passive(), onUpdated: passive(), create() {}, sendMessage() {}, query() {}, captureVisibleTab() {}},
      downloads: {search: (_query, callback) => callback([]), download() {throw new Error('cloud/download called');}}
    }
  };
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    .replace("import './extension_helpers.js';", '')
    .replace("import './takeover_runner.js';", '');
  vm.runInNewContext(source, sandbox, {filename: 'background.js'});
  for (const listener of listeners) {
    listener({action: 'captureProductLocal', payload}, {tab: {id: 1}}, response => responses.push(response));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, JSON.stringify(responses));
  assert.equal(calls[0], settings.url + '/v1/already');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].success, true);
  assert.equal(responses[0].storage, 'receiver');
});
