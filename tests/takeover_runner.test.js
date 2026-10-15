const assert = require('node:assert/strict');
const test = require('node:test');
const liseConfig = require('../site_config/lisecharmel.com.json');
const {createTakeoverRunner, classifyTakeoverScope, summarizeTakeover,
  exportTakeoverReport} = require('../takeover_runner.js');

const site = {domain: 'shop.example.test', colorVariantStrategy: 'separate-url',
  listing: {productLinkSelector: 'a.product-item-link', pagination: {nextSelector: 'a.next'},
    endCheck: {type: 'page-count', selector: '.pager'}},
  product: {allImagesSelector: '.gallery img', colorLinkSelector: '.colors a'},
  takeover: {intervalMs: 10000}};
const first = 'https://shop.example.test/list/1';
const second = 'https://shop.example.test/list/2';
const bra = 'https://shop.example.test/bra-black';
const red = 'https://shop.example.test/bra-red';
const sleep = 'https://shop.example.test/pyjamas';

function rig(pages, captures = {}, opts = {}) {
  const memory = {run: null};
  const visits = [];
  const captureCalls = [];
  const verificationCalls = [];
  const alarms = [];
  const notices = [];
  let now = 100000;
  let failAfterCapture = false;
  let crashOnSave = false;
  const io = {
    now: () => now,
    random: () => 1 / 3,
    load: async url => { visits.push(url); return {...(pages[url] || {status: 404}),
      tabId: 7, documentId: `fixture:${url}`}; },
    capture: async (url, scope, binding) => {
      captureCalls.push({url, scope, binding});
      const reply = captures[url] || {storage: 'receiver', status: 'published'};
      if (reply instanceof Error) throw reply;
      if (failAfterCapture) { failAfterCapture = false; crashOnSave = true; }
      return {...reply, identity: reply.identity || {domain: new URL(url).hostname, product_url: url,
        selected_color: null, color_key: 'url'}};
    },
    verify: async identity => {
      verificationCalls.push(identity);
      if (opts.verifyError) throw opts.verifyError;
      return opts.verifyResult || {storage: 'receiver', status: 'already'};
    },
    save: async run => {
      if (crashOnSave) { crashOnSave = false; throw Error('worker terminated'); }
      memory.run = structuredClone(run);
    },
    read: async () => structuredClone(memory.run),
    alarm: async when => { alarms.push(when); },
    notify: async reason => { notices.push(reason); }
  };
  return {memory, visits, captureCalls, verificationCalls, alarms, notices, io,
    runner: () => createTakeoverRunner(io),
    advance: ms => { now += ms; },
    terminateAfterCapture: () => { failAfterCapture = true; }};
}

const listing1 = {kind: 'listing', url: first, products: [bra, sleep], next: second,
  end: {type: 'page-count', current: 1, total: 2}};
const listing2 = {kind: 'listing', url: second, products: [red, bra], next: null,
  end: {type: 'page-count', current: 2, total: 2}};
const braPage = {kind: 'product', url: bra, product: {name: 'Lace Bra', category: 'Bras'}, colorLinks: [red]};
const redPage = {kind: 'product', url: red, product: {name: 'Lace Bra', category: 'Bras'}, colorLinks: [bra]};
const sleepPage = {kind: 'product', url: sleep, product: {name: 'Silk Pyjamas', category: 'Sleepwear'}, colorLinks: []};

async function prepare(r, config = site, listing = listing1) {
  await r.runner().preview(config, {...braPage, imageCount: 2});
  await r.runner().preview(config, listing);
}

test('discovery requires only a listing preview, never visits PDPs, and exports listing evidence', async () => {
  const r = rig({[first]: {...listing1, cards: [{url: bra, card_text: 'Lace Bra $42'}]}, [second]: listing2});
  await r.runner().preview({...site, colorVariantStrategy: undefined}, {...listing1, locale: 'en-US'}, 'discovery');
  await r.runner().start();
  for (let i = 0; i < 4; i++) { await r.runner().tick(); r.advance(10000); }
  assert.deepEqual(r.visits, [first, second]);
  assert.equal(r.captureCalls.length, 0);
  const report = exportTakeoverReport(r.memory.run);
  assert.equal(report.mode, 'discovery');
  assert.equal(report.locale, 'en-US');
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.totals, {listing_pages: 2, product_urls: 3});
  assert.deepEqual(report.listings[0].products, [{url: bra, card_text: 'Lace Bra $42'}, {url: sleep, card_text: ''}]);
  assert.equal(report.listings[0].final_url, first);
  assert.equal(report.listings[0].next_url, second);
  assert.deepEqual(report.listings[1].end_check, {observed: listing2.end, passed: true});
  assert.equal(report.site, site.domain);
  assert.equal(report.config, undefined);
  assert.equal(report.products, undefined);
});

test('discovery without positive end evidence finishes with gaps and can pause/resume', async () => {
  const listing = {...listing1, next: null, end: null};
  const r = rig({[first]: listing});
  await r.runner().preview({...site, listing: {...site.listing, endCheck: null}}, listing, 'discovery');
  await r.runner().start();
  await r.runner().pause();
  await r.runner().tick();
  assert.deepEqual(r.visits, []);
  await r.runner().resume();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  const report = exportTakeoverReport(r.memory.run);
  assert.equal(report.status, 'finished_with_gaps');
  assert.match(report.stop_reason, /without passing end check/);
  assert.equal(report.listings[0].end_check.passed, false);
  assert.equal(r.captureCalls.length, 0);
});

test('discovery rejects product previews and does not inherit capture previews', async () => {
  const r = rig({});
  await prepare(r);
  await assert.rejects(r.runner().preview(site, braPage, 'discovery'), /listing/);
  await r.runner().preview(site, listing1, 'discovery');
  assert.equal(r.memory.run.previews.length, 1);
});

test('discovery export carries supplied provenance and an unstarted preview has no invented start', async () => {
  const r = rig({});
  await r.runner().preview(site, listing1, 'discovery');
  const context = {exportedUtc: '2026-10-03T19:00:00.000Z', extensionVersion: '2.3.4'};
  const preview = exportTakeoverReport(r.memory.run, context);
  assert.equal(preview.started_utc, null);
  assert.equal(preview.exported_utc, '2026-10-03T19:00:00.000Z');
  assert.equal(preview.extension_version, '2.3.4');
  await r.runner().start();
  const started = exportTakeoverReport(r.memory.run, context);
  assert.equal(started.started_utc, '1970-01-01T00:01:40.000Z');
  const capture = exportTakeoverReport({...r.memory.run, mode: 'capture'}, context);
  assert.equal(capture.format, 'page-image-saver-takeover-run/v1');
  assert.equal(capture.started_utc, undefined);
  assert.equal(capture.extension_version, undefined);
});

test('preview stores observations but only explicit take over starts navigation', async () => {
  const r = rig({[first]: listing1});
  await r.runner().preview(site, listing1);
  assert.deepEqual(r.visits, []);
  assert.equal(r.memory.run.status, 'preview');
  assert.equal(r.memory.run.preview.endCheckConfigured, true);
  await r.runner().preview(site, {...braPage, imageCount: 2});
  assert.equal(r.memory.run.previews.find(p => p.kind === 'product').scope.decision, 'include');
  assert.equal(r.memory.run.previews.find(p => p.kind === 'product').imageCount, 2);
  assert.equal(r.memory.run.seedUrl, null);
  await assert.rejects(() => r.runner().start(), /preview a listing/);
  await r.runner().preview(site, listing1);
  assert.equal(r.memory.run.previews.length, 1);
  await r.runner().start();
  assert.equal(r.memory.run.status, 'running');
  assert.deepEqual(r.visits, []);
  assert.ok(r.alarms.length > 0, 'a recovery alarm must exist before first navigation');
  await r.runner().tick();
  assert.deepEqual(r.visits, [first]);
});

test('each listing preview replaces the prior list and starts at the latest explicit URL', async () => {
  const r = rig({[second]: listing2});
  await r.runner().preview(site, listing1);
  await r.runner().preview(site, listing2);
  assert.deepEqual(r.memory.run.previews.map(row => row.url), [second]);
  assert.equal(r.memory.run.seedUrl, second);
  await r.runner().start();
  await r.runner().tick();
  assert.deepEqual(r.visits, [second]);
});

function discoverySource(urls = [bra], sha256 = 'a'.repeat(64), listingUrl = first) {
  return {sha256, report: {format: 'page-image-saver-discovery/v1', schema_version: 1,
    mode: 'discovery', site: site.domain, started_utc: '2026-10-03T10:00:00.000Z',
    listings: [{url: listingUrl, final_url: listingUrl,
      products: urls.map(url => ({url, card_text: 'Recorded card'})), next_url: null,
      end_check: {observed: null, passed: false}}]}};
}

test('imported discovery captures only normalized targets, all origins, and never drops excluded scope', async () => {
  const r = rig({[bra]: braPage, [sleep]: sleepPage}, {}, {verifyResult: {storage:'receiver', status:'missing'}});
  const runner = r.runner();
  assert.equal(typeof runner.importDiscovery, 'function');
  await runner.importDiscovery(site, [discoverySource([bra + '#color', sleep]),
    discoverySource([bra], 'b'.repeat(64), second)]);
  assert.equal(r.memory.run.mode, 'capture-discovery');
  assert.equal(r.memory.run.seedUrl, bra);
  assert.deepEqual(r.memory.run.products.map(row => row.url), [bra, sleep]);
  assert.deepEqual(r.memory.run.products[0].origins, [
    {file_sha256: 'a'.repeat(64), listing_url: first},
    {file_sha256: 'b'.repeat(64), listing_url: second}]);
  await runner.start();
  for (let i = 0; i < 4; i++) { await runner.tick(); r.advance(10000); }
  assert.deepEqual(r.visits, [bra, sleep]);
  assert.deepEqual(r.captureCalls.map(row => row.url), [bra, sleep]);
  assert.equal(r.memory.run.products[1].scope.decision, 'exclude');
  assert.equal(r.memory.run.products[1].status, 'captured');
  assert.equal(r.memory.run.status, 'complete');
  assert.deepEqual(exportTakeoverReport(r.memory.run).products[0].origins,
    r.memory.run.products[0].origins);
});

test('invalid discovery imports leave saved run untouched and active/paused runs reject overwrite', async () => {
  const r = rig({});
  assert.equal(typeof r.runner().importDiscovery, 'function');
  await r.runner().preview(site, listing1, 'discovery');
  const before = structuredClone(r.memory.run);
  const invalid = [[], [discoverySource([])], [{...discoverySource(), sha256:'bad'}],
    [discoverySource(['https://other.test/bra'])], [discoverySource(['javascript:alert(1)'])],
    [{...discoverySource(), report: {...discoverySource().report, format:'other'}}],
    [discoverySource([bra]), discoverySource([sleep], 'b'.repeat(64), 'https://other.test/list')],
    [{...discoverySource(), report:{...discoverySource().report, listings:null}}],
    [discoverySource(Array.from({length:10001}, (_, i) => `https://${site.domain}/p/${i}`))]];
  for (const sources of invalid) {
    await assert.rejects(r.runner().importDiscovery(site, sources));
    assert.deepEqual(r.memory.run, before);
  }
  for (const status of ['running','paused']) {
    r.memory.run.status = status;
    await assert.rejects(r.runner().importDiscovery(site, [discoverySource()]), /stop or finish/);
    assert.equal(r.memory.run.status, status);
  }
});

test('current discovery reuse preserves start and each listing origin before replacing saved run', async () => {
  const r = rig({[first]: listing1, [second]: listing2});
  const runner = r.runner();
  assert.equal(typeof runner.importDiscovery, 'function');
  await runner.preview(site, listing1, 'discovery');
  await runner.start();
  for (let i=0; i<3; i++) { await runner.tick(); r.advance(10000); }
  await runner.importDiscovery(site);
  assert.deepEqual(r.memory.run.products.find(row => row.url===bra).origins, [
    {run_started_utc:'1970-01-01T00:01:40.000Z', listing_url:first},
    {run_started_utc:'1970-01-01T00:01:40.000Z', listing_url:second}]);
  assert.deepEqual(r.memory.run.listings.queue, []);
});

test('verified identities skip navigation and remain verified across restart; Downloads never skip', async () => {
  const r = rig({[sleep]: sleepPage}, {[sleep]: {storage:'downloads'}});
  assert.equal(typeof r.runner().importDiscovery, 'function');
  r.io.verify = async identity => ({storage:'receiver', status: identity.product_url===bra ? 'already' : 'missing'});
  await r.runner().importDiscovery(site, [discoverySource([bra,sleep])]);
  await r.runner().start();
  await r.runner().tick();
  assert.equal(r.memory.run.products[0].status, 'skipped');
  assert.deepEqual(r.visits, []);
  r.advance(10000);
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.deepEqual(r.visits, [sleep]);
  assert.equal(r.memory.run.status,'finished_with_gaps');
  assert.equal(summarizeTakeover(r.memory.run).skipped,1);
  assert.equal(summarizeTakeover(r.memory.run).exportedUnverified,1);
});

test('fixed queue pause/restart never expands and challenge immediately pauses', async () => {
  const r = rig({[bra]: {status:429}}, {}, {verifyResult:{storage:'receiver', status:'missing'}});
  assert.equal(typeof r.runner().importDiscovery, 'function');
  await r.runner().importDiscovery(site,[discoverySource()]);
  await r.runner().start(); await r.runner().pause();
  await r.runner().tick(); assert.deepEqual(r.visits,[]);
  await r.runner().resume(); await r.runner().tick();
  assert.equal(r.memory.run.status,'paused');
  assert.match(r.memory.run.reason,/429/);
  assert.equal(r.captureCalls.length,0);
  assert.equal(r.memory.run.products.length,1);
});

test('new preview cannot inherit a completed run listing seed', async () => {
  const r = rig({});
  r.memory.run = {status: 'complete', domain: site.domain, generation: 1, seedUrl: first};
  await r.runner().preview(site, {...braPage, imageCount: 2});
  await assert.rejects(() => r.runner().start(), /preview a listing/);
});

test('page-count evidence, unique URLs and exclusion accounting complete a run', async () => {
  const r = rig({[first]: listing1, [second]: listing2, [bra]: braPage,
    [red]: redPage, [sleep]: sleepPage});
  await prepare(r);
  await r.runner().start();
  for (let i = 0; i < 10 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'complete');
  assert.deepEqual(summarizeTakeover(r.memory.run), {pacing:{minMs:9000,maxMs:12000}, listingPagesVisited: 2,
    productsFound: 3, productsCaptured: 2, colorsCaptured: 2, sizeOptionsTraversed: 0,
    excluded: 1, gone: 0, failed: 0, pending: 0, exportedUnverified: 0});
  assert.deepEqual(r.captureCalls.map(call => call.url), [bra, red]);
  assert.equal(r.captureCalls[0].scope.decision, 'include');
});

test('missing next on known nonfinal page drains products with a discovery gap', async () => {
  const r = rig({[first]: {...listing1, next: null}, [bra]: {...braPage, colorLinks: []},
    [sleep]: sleepPage});
  await prepare(r); await r.runner().start();
  for (let i = 0; i < 4 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(r.memory.run.listings.discoveryComplete, false);
  assert.match(r.memory.run.listings.discoveryReason, /end check/);
  assert.deepEqual(r.captureCalls.map(call => call.url), [bra]);
});

test('Lise Charmel without endCheck captures discovered products then records a discovery gap', async () => {
  const listingUrl = 'https://lisecharmel.com/lingerie/bras';
  const firstProduct = 'https://lisecharmel.com/bra-black';
  const secondProduct = 'https://lisecharmel.com/bra-red';
  const listing = {kind: 'listing', url: listingUrl,
    products: [firstProduct, secondProduct], next: null, end: null};
  const products = {[firstProduct]: {kind: 'product', url: firstProduct,
    product: {name: 'Lace Bra', category: 'Bras'}, colorLinks: []},
  [secondProduct]: {kind: 'product', url: secondProduct,
    product: {name: 'Lace Bra', category: 'Bras'}, colorLinks: []}};
  const r = rig({[listingUrl]: listing, ...products});
  await r.runner().preview(liseConfig, {...products[firstProduct], imageCount: 2});
  await r.runner().preview(liseConfig, listing);
  await r.runner().start();
  for (let i = 0; i < 4 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(r.memory.run.listings.discoveryComplete, false);
  assert.match(r.memory.run.listings.discoveryReason, /missing next page.*end check/);
  assert.deepEqual(r.captureCalls.map(call => call.url), [firstProduct, secondProduct]);
  assert.equal(summarizeTakeover(r.memory.run).productsCaptured, 2);
});

test('page-count end check records repeated page numbers as a gap after capture', async () => {
  const r = rig({[first]: {...listing1, end: {type: 'page-count', current: 2, total: 2}},
    [second]: listing2, [bra]: braPage, [red]: redPage, [sleep]: sleepPage});
  await prepare(r); await r.runner().start();
  for (let i = 0; i < 6 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(r.memory.run.listings.visited.length, 2);
  assert.equal(r.memory.run.listings.discoveryComplete, false);
  assert.match(r.memory.run.listings.discoveryReason, /end check/);
  assert.deepEqual(r.captureCalls.map(call => call.url), [bra, red]);
});

test('first listing with zero products stops and a pagination cycle cannot finish', async () => {
  const empty = rig({[first]: {...listing1, products: []}});
  await prepare(empty); await empty.runner().start(); await empty.runner().tick();
  assert.equal(empty.memory.run.status, 'paused');
  assert.match(empty.memory.run.reason, /product-link selector/);
  const cycle = rig({[first]: {...listing1, next: first}});
  await prepare(cycle); await cycle.runner().start(); await cycle.runner().tick();
  assert.equal(cycle.memory.run.status, 'discovery_incomplete');
});

test('restart recaptures interrupted product but skips persisted completed product', async () => {
  const r = rig({[first]: {...listing1, products: [bra, red], next: null,
    end: {type: 'explicit', present: true}}, [bra]: braPage, [red]: redPage});
  const explicitSite = structuredClone(site);
  explicitSite.listing.endCheck = {type: 'explicit', selector: '.end'};
  await prepare(r, explicitSite);
  await r.runner().start(); await r.runner().tick(); r.advance(10000);
  await r.runner().tick(); r.advance(10000);
  r.terminateAfterCapture();
  await assert.rejects(() => r.runner().tick(), /worker terminated/);
  assert.equal(r.memory.run.products[0].status, 'captured');
  assert.equal(r.memory.run.products[1].status, 'pending');
  r.advance(10000);
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.deepEqual(r.captureCalls.map(call => call.url), [bra, red, red]);
  assert.equal(r.memory.run.status, 'complete');
});

test('persisted pacing and pause survive a new runner instance', async () => {
  const r = rig({[first]: listing1, [second]: listing2});
  await prepare(r); await r.runner().start(); await r.runner().tick();
  await r.runner().tick();
  assert.deepEqual(r.visits, [first]);
  assert.equal(r.alarms.at(-1), 110000);
  await r.runner().pause(); r.advance(10000); await r.runner().tick();
  assert.deepEqual(r.visits, [first]);
  assert.equal(r.memory.run.status, 'paused');
});

test('pause while navigation is in flight cannot be overwritten by its late result', async () => {
  const r = rig({[first]: listing1});
  let release;
  r.io.load = async () => new Promise(resolve => { release = () => resolve(listing1); });
  await prepare(r); await r.runner().start();
  const step = r.runner().tick();
  while (!release) await Promise.resolve();
  await r.runner().pause();
  release(); await step;
  assert.equal(r.memory.run.status, 'paused');
  assert.deepEqual(r.memory.run.listings.visited, []);
  await r.runner().tick();
  assert.equal(r.memory.run.status, 'paused');
});

test('duplicate start and reentrant tick dispatch one navigation', async () => {
  const r = rig({[first]: listing1});
  await prepare(r);
  await Promise.allSettled([r.runner().start(), r.runner().start()]);
  await Promise.all([r.runner().tick(), r.runner().tick()]);
  assert.deepEqual(r.visits, [first]);
  assert.deepEqual(r.memory.run.listings.visited.map(row => row.url), [first]);
});

test('challenge and 403/429 stop immediately; transient load failures are bounded', async () => {
  for (const page of [{status: 403}, {status: 429}, {kind: 'challenge', status: 200}]) {
    const r = rig({[first]: page});
    await prepare(r); await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.status, 'paused');
    assert.equal(r.notices.length, 1);
    await r.runner().tick(); assert.equal(r.visits.length, 1);
  }
  const r = rig({[first]: {status: 500}});
  await prepare(r); await r.runner().start();
  for (let i = 0; i < 3; i++) { await r.runner().tick(); r.advance(10000); }
  assert.equal(r.memory.run.status, 'paused');
  assert.equal(r.visits.length, 3);
});

test('dead product 404 skips that item and still captures the next product', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra, red], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {status: 404},
  [red]: {...redPage, colorLinks: []}});
  await prepare(r, config); await r.runner().start();
  for (let i = 0; i < 4 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'complete');
  assert.equal(r.memory.run.products[0].status, 'skipped');
  assert.match(r.memory.run.products[0].reason, /HTTP 404/);
  assert.deepEqual(r.captureCalls.map(call => call.url), [red]);
  assert.deepEqual(r.visits, [first, bra, red]);
});

test('same-site product redirect to listing fails that item and continues', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra, red], next: null,
    end: {type: 'explicit', present: true}},
  [bra]: {kind: 'listing', url: first, products: [bra, red], next: null},
  [red]: {...redPage, colorLinks: []}});
  await prepare(r, config); await r.runner().start();
  for (let i = 0; i < 4 && r.memory.run.status === 'running'; i++) {
    await r.runner().tick(); r.advance(10000);
  }
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(r.memory.run.products[0].status, 'failed');
  assert.match(r.memory.run.products[0].reason, /product structure mismatch/);
  assert.deepEqual(r.captureCalls.map(call => call.url), [red]);
});

test('listing redirect cannot overwrite a pause racing the load ownership read', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}},
  [bra]: {kind: 'listing', url: first, products: [bra], next: null}});
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000);
  const originalRead = r.io.read;
  let reads = 0;
  r.io.read = async () => {
    const snapshot = await originalRead();
    if (++reads === 2) r.memory.run.status = 'paused';
    return snapshot;
  };
  await r.runner().tick();
  assert.equal(r.memory.run.status, 'paused');
  assert.equal(r.memory.run.products[0].status, 'pending');
});

test('download fallback is counted unverified and never grants a complete catalog', async () => {
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...braPage, colorLinks: []}},
    {[bra]: {storage: 'downloads', status: 'fallback'}});
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(summarizeTakeover(r.memory.run).exportedUnverified, 1);
  assert.equal(summarizeTakeover(r.memory.run).failed, 1);
});

test('receiver evidence conflict is an explicit failure, never a verified skip', async () => {
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...braPage, colorLinks: []}},
    {[bra]: new Error('receiver HTTP 409: referenced image hash mismatch')});
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'finished_with_gaps');
  assert.equal(r.memory.run.products[0].status, 'failed');
  assert.match(r.memory.run.products[0].reason, /409/);
});

test('explicit stop survives a new runner and clearing a challenge page does not resume', async () => {
  const r = rig({[first]: {kind: 'challenge', status: 200}});
  await prepare(r); await r.runner().start(); await r.runner().tick();
  assert.equal(r.memory.run.status, 'paused');
  r.io.load = async url => { r.visits.push(url); return listing1; };
  await r.runner().tick();
  assert.equal(r.visits.length, 1);
  await r.runner().stop();
  await r.runner().tick();
  assert.equal(r.memory.run.status, 'stopped');
  assert.equal(r.visits.length, 1);
});

test('scope uses product evidence and leaves uncertain mixed use as review', () => {
  assert.equal(classifyTakeoverScope({name: 'Sports Bra', category: 'Bras'}).decision, 'include');
  assert.equal(classifyTakeoverScope({name: 'Women Pyjamas', category: 'Sleepwear'}).decision, 'exclude');
  assert.equal(classifyTakeoverScope({name: 'Swim Bra', category: 'Swimwear / Bras'}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Women Bra', category: ''}).decision, 'include');
  assert.equal(classifyTakeoverScope({name: 'Mystery Set', category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Swimwear Bikini Bra', category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: "Men's Briefs", category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Men Briefs', category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Men Bra', category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Mens Briefs', category: ''}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Lace Bra', category: 'Men'}).decision, 'review');
  assert.equal(classifyTakeoverScope({name: 'Women Briefs', category: ''}).decision, 'include');
  for (const name of ['Swim Bra', 'Swimsuit Bodysuit', 'Nightdress with Bra Support']) {
    assert.equal(classifyTakeoverScope({name, category: ''}).decision, 'review', name);
    assert.equal(classifyTakeoverScope({name: 'Lace Bra', category: name}).decision, 'review', `category: ${name}`);
  }
  for (const name of ['Swim', 'Swimsuit', 'Nightdress']) {
    assert.equal(classifyTakeoverScope({name, category: ''}).decision, 'exclude', name);
    assert.equal(classifyTakeoverScope({name: 'Unknown', category: name}).decision, 'exclude', `category: ${name}`);
  }
});

test('restarted worker revalidates a saved captured identity before catalog completion', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...braPage, colorLinks: []}}, {},
    {verifyResult: {storage: 'receiver', status: 'missing'}});
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.products[0].status, 'captured');
  r.advance(10000); await r.runner().tick();
  assert.equal(r.verificationCalls.length, 1);
  assert.equal(r.memory.run.products[0].status, 'failed');
  assert.equal(r.memory.run.status, 'finished_with_gaps');
});

test('pause during saved completion verification cannot be overwritten by late receiver reply', async () => {
  const r = rig({});
  let release;
  r.memory.run = {version: 1, generation: 5, status: 'running', domain: site.domain,
    config: site, listings: {queue: [], visited: [], discoveryComplete: true},
    products: [{url: bra, status: 'captured', identity: {domain: site.domain,
      product_url: bra, selected_color: null, color_key: 'url'}}],
    current: null, lastNavigationStarted: null, loadFailures: {}, reason: null};
  r.io.verify = async () => new Promise(resolve => { release = () => resolve({storage: 'receiver', status: 'already'}); });
  const step = r.runner().tick();
  while (!release) await Promise.resolve();
  await r.runner().pause();
  release(); await step;
  assert.equal(r.memory.run.status, 'paused');
});

test('fixed queue accepts added query parameters but preserves queued identity and inspected binding', async () => {
  const r = rig({[bra]: {...braPage, url:bra+'?size=OS'}}, {},
    {verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource([bra])]);
  await r.runner().start(); await r.runner().tick();
  assert.equal(r.memory.run.products[0].status,'captured');
  assert.equal(r.memory.run.products[0].identity.product_url,bra);
  assert.equal(r.captureCalls[0].binding.documentUrl,bra+'?size=OS');
});

test('fixed queue rejects changed or removed existing query parameters', async () => {
  for (const final of [bra, bra+'?color=red', bra+'?color=black&color=red']) {
    const queued=bra+'?color=black';
    const r=rig({[queued]:{...braPage,url:final}}, {}, {verifyResult:{storage:'receiver',status:'missing'}});
    await r.runner().importDiscovery(site,[discoverySource([queued])]);
    await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.products[0].status,'failed');
    assert.equal(r.captureCalls.length,0);
  }
});

test('five consecutive fixed queue failures pause across worker restarts', async () => {
  const urls=Array.from({length:6},(_,i)=>bra+'/'+i);
  const pages=Object.fromEntries(urls.map(url=>[url,{kind:'listing',url}]));
  const r=rig(pages,{}, {verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource(urls)]);
  await r.runner().start();
  for(let i=0;i<5;i++){await r.runner().tick();r.advance(10000);}
  assert.equal(r.memory.run.status,'paused');
  assert.match(r.memory.run.reason,/5 consecutive/);
  assert.equal(r.memory.run.products[5].status,'pending');
  assert.equal(r.visits.length,5);
});

test('capture errors trigger the five-failure guard and verified skips reset it', async () => {
  const urls=Array.from({length:6},(_,i)=>bra+'/'+i);
  const pages=Object.fromEntries(urls.map(url=>[url,{...braPage,url}]));
  const failures=Object.fromEntries(urls.map(url=>[url,new Error('image decode failed')]));
  const r=rig(pages,failures,{verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource(urls)]);
  await r.runner().start();
  for(let i=0;i<4;i++){await r.runner().tick();r.advance(10000);}
  r.io.verify=async identity=>({storage:'receiver',status:identity.product_url===urls[4]?'already':'missing'});
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status,'running');
  assert.equal(r.memory.run.consecutiveFailures,1);
  assert.equal(r.memory.run.products[4].status,'skipped');
  const s=rig(pages,failures,{verifyResult:{storage:'receiver',status:'missing'}});
  await s.runner().importDiscovery(site,[discoverySource(urls)]);
  await s.runner().start();
  for(let i=0;i<5;i++){await s.runner().tick();s.advance(10000);}
  assert.equal(s.memory.run.status,'paused');
  assert.match(s.memory.run.reason,/5 consecutive.*image decode failed/);
});

test('fixed queue redirects skip gone sources or fail invalid URLs; capture only the destination once at its own turn', async () => {
  for (const destination of [red, 'https://other.test/product', 'not a URL']) {
    const r = rig({[bra]: {...redPage, url: destination}, [red]: redPage}, {},
      {verifyResult: {storage:'receiver', status:'missing'}});
    await r.runner().importDiscovery(site, [discoverySource([bra, red])]);
    await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.status, 'running');
    assert.equal(r.memory.run.products[0].status, destination === red ? 'skipped' : 'failed');
    assert.match(r.memory.run.products[0].reason, /gone: redirected to |invalid inspected page URL/);
    assert.equal(r.captureCalls.length, 0);
    r.advance(10000); await r.runner().tick();
    assert.deepEqual(r.captureCalls.map(row => row.url), [red]);
    assert.equal(r.memory.run.products[1].status, 'captured');
    assert.deepEqual(r.visits, [bra, red]);
  }
});

test('fixed queue redirect with challenge or HTTP block still pauses without failing the product', async () => {
  for (const page of [{status:403}, {status:429}, {status:200, kind:'challenge'}]) {
    const r = rig({[bra]: {...redPage, ...page}}, {},
      {verifyResult:{storage:'receiver', status:'missing'}});
    await r.runner().importDiscovery(site, [discoverySource([bra, red])]);
    await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.status, 'paused');
    assert.equal(r.memory.run.products[0].status, 'pending');
    assert.equal(r.captureCalls.length, 0);
  }
});

test('same-site product redirect cannot satisfy a different queued URL', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...redPage, url: red}});
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'running');
  assert.equal(r.memory.run.products[0].status, 'skipped');
  assert.equal(r.memory.run.products[0].reason, 'gone: redirected to ' + red);
  assert.equal(r.captureCalls.length, 0);
});

test('exported run carries the saved accounting and reasons for a gap', async () => {
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...braPage, colorLinks: []}},
    {[bra]: {storage: 'downloads', status: 'fallback'}});
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  r.advance(10000); await r.runner().tick();
  const exported = exportTakeoverReport(r.memory.run);
  assert.equal(exported.format, 'page-image-saver-takeover-run/v1');
  assert.equal(exported.accounting.productsFound, 1);
  assert.equal(exported.accounting.failed, 1);
  assert.equal(exported.products[0].reason, 'exported_unverified');
  assert.equal(exported.status, 'finished_with_gaps');
});
test('fixed queue captures review scope and preserves named URL errors in its export', async () => {
  const page = {...braPage, product: {name: 'Essie', category: ''}};
  const r = rig({[bra]: page}, {}, {verifyResult: {storage: 'receiver', status: 'missing'}});
  await r.runner().importDiscovery(site, [discoverySource()]);
  await r.runner().start();
  await r.runner().tick();
  assert.equal(r.captureCalls[0].scope.decision, 'review');
  assert.equal(r.memory.run.products[0].status, 'captured');
  const {resolveGalleryOriginal} = require('../extension_helpers.js');
  let reason;
  try { resolveGalleryOriginal('https://[bad/', '.', bra); } catch (error) { reason = error.message; }
  const failure = rig({[bra]: page}, {[bra]: new Error(reason)},
    {verifyResult: {storage: 'receiver', status: 'missing'}});
  await failure.runner().importDiscovery(site, [discoverySource()]);
  await failure.runner().start();
  await failure.runner().tick();
  const exported = exportTakeoverReport(failure.memory.run);
  assert.match(exported.products[0].reason, /gallery original.*https:\/\/\[bad/);
});


test('gone HTTP products preserve failure streak across restarts and export separately from verified skips', async () => {
  const urls=Array.from({length:10},(_,i)=>bra+'/'+i);
  const statuses=[500,404,410,500,404,404,500,500,500,200];
  const pages=Object.fromEntries(urls.map((url,i)=>[url,{...braPage,url,status:statuses[i]}]));
  const r=rig(pages,{}, {verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource(urls)]);
  await r.runner().start();
  for(let i=0;i<9;i++){await r.runner().tick();r.advance(10000);}
  assert.equal(r.memory.run.status,'paused');
  assert.equal(r.memory.run.consecutiveFailures,5);
  assert.equal(r.memory.run.products[9].status,'pending');
  assert.deepEqual(r.visits,urls.slice(0,9));
  assert.equal(r.captureCalls.length,0);
  const report=exportTakeoverReport(r.memory.run);
  assert.equal(report.accounting.gone,4);
  assert.equal(report.accounting.skipped,0);
  assert.equal(report.accounting.failed,5);
  assert.equal(report.products[1].reason,'gone: HTTP 404');
  assert.equal(report.products[2].reason,'gone: HTTP 410');
  assert.equal(report.products[1].status,'skipped');
});

test('five gone products do not pause and reimport revisits gone but receiver-skips captures', async () => {
  const urls=[...Array.from({length:5},(_,i)=>bra+'/'+i),red];
  const pages=Object.fromEntries(urls.map(url=>[url,url===red?redPage:{url,status:404}]));
  const r=rig(pages,{}, {verifyResult:{storage:'receiver',status:'missing'}});
  const source=discoverySource(urls);
  await r.runner().importDiscovery(site,[source]); await r.runner().start();
  const runner=r.runner();
  for(let i=0;i<7;i++){await runner.tick();r.advance(10000);}
  assert.equal(r.memory.run.status,'complete');
  assert.equal(summarizeTakeover(r.memory.run).gone,5);
  assert.deepEqual(r.captureCalls.map(x=>x.url),[red]);
  r.io.verify=async identity=>({storage:'receiver',status:identity.product_url===red?'already':'missing'});
  await r.runner().importDiscovery(site,[source]); await r.runner().start();
  for(let i=0;i<7;i++){await r.runner().tick();r.advance(10000);}
  assert.equal(r.memory.run.status,'complete');
  assert.equal(summarizeTakeover(r.memory.run).gone,5);
  assert.equal(summarizeTakeover(r.memory.run).skipped,1);
  assert.deepEqual(r.visits,[...urls,...urls.slice(0,5)]);
});


test('same-product locale and canonical redirects keep their existing failure handling', async () => {
  const queued='https://shop.example.test/us_en/bra-239';
  for (const url of [queued+'/', queued.replace('/us_en/','/uk_en/')]) {
    const r=rig({[queued]:{...braPage,url}}, {}, {verifyResult:{storage:'receiver',status:'missing'}});
    await r.runner().importDiscovery(site,[discoverySource([queued])]);
    await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.products[0].status,'failed');
    assert.equal(summarizeTakeover(r.memory.run).gone,0);
    assert.equal(r.captureCalls.length,0);
  }
});


for (const [sample, delay] of [[0,9000],[0.5,10500],[1-Number.EPSILON,12000]]) {
  test(`navigation jitter persists ${delay}ms before load and survives restart`, async () => {
    const r=rig({[bra]:braPage,[red]:redPage},{}, {verifyResult:{storage:'receiver',status:'missing'}});
    r.io.verify=async identity=>({storage:'receiver',status:r.captureCalls.some(call=>call.url===identity.product_url)?'already':'missing'});
    let rolls=0;
    r.io.random=()=>{rolls++;return sample;};
    const load=r.io.load;
    r.io.load=async url=>{
      assert.equal(r.memory.run.nextNavigationAt,r.memory.run.lastNavigationStarted+delay);
      return load(url);
    };
    await r.runner().importDiscovery(site,[discoverySource([bra,red])]);
    await r.runner().start(); await r.runner().tick();
    assert.equal(r.memory.run.nextNavigationAt,100000+delay);
    assert.equal(rolls,1);
    r.advance(delay-1);
    await r.runner().tick();
    assert.deepEqual(r.visits,[bra]);
    assert.equal(r.alarms.at(-1),100000+delay);
    assert.equal(rolls,1,'restart/wait must not reroll');
    r.advance(1); await r.runner().tick();
    assert.deepEqual(r.visits,[bra,red]);
    assert.equal(rolls,2,'one roll per navigation');
    const exported=exportTakeoverReport(r.memory.run);
    assert.deepEqual(exported.pacing,{minMs:9000,maxMs:12000});
    assert.equal(exported.nextNavigationAt,100000+2*delay);
  });
}

test('legacy run preserves its outstanding 10-second wait then adopts jitter',async()=>{
  const r=rig({[bra]:braPage,[red]:redPage},{},{verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource([bra,red])]); await r.runner().start();
  r.memory.run.lastNavigationStarted=100000;
  delete r.memory.run.nextNavigationAt;
  r.io.random=()=>0;
  r.advance(9999); await r.runner().tick();
  assert.equal(r.visits.length,0);
  assert.equal(r.memory.run.nextNavigationAt,110000);
  r.advance(1); await r.runner().tick();
  assert.deepEqual(r.visits,[bra]);
  assert.equal(r.memory.run.nextNavigationAt,119000);
});


test('shipped site configurations use the shared 9–12 second pacing range',()=>{
  for (const config of [{}, require('../site_config/www.agentprovocateur.com.json'),
      liseConfig, require('../site_config/www.sanscomplexe.com.json')]) {
    assert.deepEqual(summarizeTakeover({config,products:[]}).pacing,{minMs:9000,maxMs:12000});
  }
});

test('fixed VS queue captures encoded document while retaining saved literal identity',async()=>{
  const url=require('./fixtures/victoriassecret-apostrophe-urls.json')[0];
  const r=rig({[url]:{kind:'product',url:url.replaceAll("'",'%27'),product:{name:'Lace Bra'}}},{},
    {verifyResult:{storage:'receiver',status:'missing'}});
  const config={...site,domain:'www.victoriassecret.com'};
  const source=discoverySource([url]); source.report.site=config.domain;
  source.report.listings[0].url=source.report.listings[0].final_url='https://www.victoriassecret.com/list';
  await r.runner().importDiscovery(config,[source]);await r.runner().start();await r.runner().tick();
  assert.equal(r.memory.run.products[0].status,'captured');
  assert.equal(r.memory.run.products[0].identity.product_url,url);
});

test('three plain readiness failures fail one product and continue with the next',async()=>{
  const r=rig({[bra]:{status:0,error:'automatic product gallery readiness timeout'},[red]:redPage},{},
    {verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource([bra,red])]);await r.runner().start();
  for(let i=0;i<3;i++){await r.runner().tick();r.advance(10000);}
  assert.equal(r.memory.run.status,'running');
  assert.equal(r.memory.run.products[0].status,'failed');
  assert.match(r.memory.run.products[0].reason,/3.*automatic product gallery readiness timeout/);
  await r.runner().tick();
  assert.equal(r.memory.run.products[1].status,'captured');
});

test('real page load failures pause after three attempts; challenge errors pause immediately',async()=>{
  const urls=Array.from({length:6},(_,i)=>`https://shop.example.test/bra-${i}`);
  const r=rig(Object.fromEntries(urls.map(url=>[url,{status:0,error:'page load timeout'}])),{},
    {verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource(urls)]);await r.runner().start();
  for(let i=0;i<15;i++){await r.runner().tick();r.advance(10000);}
  assert.equal(r.memory.run.products.filter(p=>p.status==='failed').length,0);
  assert.equal(r.visits.length,3);
  assert.equal(r.memory.run.status,'paused');
  assert.match(r.memory.run.reason,/repeated page load failure.*page load timeout/);
  for(const error of ['HTTP 403','HTTP 429','captcha challenge']) {
    const b=rig({[bra]:{status:0,error}},{},{verifyResult:{storage:'receiver',status:'missing'}});
    await b.runner().importDiscovery(site,[discoverySource([bra])]);await b.runner().start();await b.runner().tick();
    assert.equal(b.memory.run.status,'paused');assert.equal(b.visits.length,1);
  }
});

test('equivalent percent-encoded path letters capture but unknown inspection failures retain a clear pause', async()=>{
  const encoded=bra.replace('bra','%62ra');
  const r=rig({[bra]:{...braPage,url:encoded}},{},{verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource([bra])]);await r.runner().start();await r.runner().tick();
  assert.equal(r.memory.run.products[0].status,'captured');
  const b=rig({[bra]:{status:0,error:'page inspection failed'}},{},{verifyResult:{storage:'receiver',status:'missing'}});
  await b.runner().importDiscovery(site,[discoverySource([bra])]);await b.runner().start();
  for(let i=0;i<3;i++){await b.runner().tick();b.advance(10000);}
  assert.equal(b.memory.run.status,'paused');
  assert.match(b.memory.run.reason,/page inspection failed/);
  assert.equal(b.memory.run.products[0].status,'pending');
});

for (const phase of ['inspection', 'capture']) test(`unavailable choices at ${phase} export gone without capture or failure pauses`, async () => {
  const urls = Array.from({length: 6}, (_, i) => bra + '/' + i);
  const reason = 'choice unavailable in region: 7OWG → 7WZZ';
  const pages = Object.fromEntries(urls.map(url => [url, {...braPage, url, colorLinks: [], ...(phase === 'inspection' ? {goneReason: reason} : {})}]));
  const r = rig(pages, {}, {verifyResult: {storage:'receiver',status:'missing'}});
  if (phase === 'capture') r.io.capture = async () => {throw new Error(reason);};
  await r.runner().importDiscovery(site, [discoverySource(urls)]); await r.runner().start();
  for (let i=0;i<7;i++) {await r.runner().tick(); r.advance(10000);}
  assert.equal(r.memory.run.status, 'complete');
  assert.equal(summarizeTakeover(r.memory.run).gone, 6);
  assert.equal(summarizeTakeover(r.memory.run).failed, 0);
  assert.ok(r.memory.run.products.every(p => p.reason === reason));
  assert.equal(r.captureCalls.length, 0);
});

test('PDP-only VDV config previews products but refuses unevidenced listing discovery', async () => {
  const config = require('../site_config/www.primadonna.com.json');
  const url = 'https://www.primadonna.com/en-us/p/primadonna-bra-0163490WBL';
  const r=rig({});
  const run=await r.runner().preview(config,{kind:'product',url,product:{name:'Bra'},colorLinks:[],imageCount:3});
  assert.equal(run.previews[0].imageCount,3);
  await assert.rejects(r.runner().preview(config,{kind:'listing',url,products:[]},'discovery'),/saved listing evidence/i);
});

function seedSource(urls) {
  return {sha256: 'a'.repeat(64), report: {format: 'page-image-saver-listing-seeds/v1',
    schema_version: 1, site: site.domain, seeds: urls}};
}
const resultSite = {...site, listing: {...site.listing, endCheck: {type: 'result-total'}}};
const seedPage = (url, products, total, next = null) => ({kind: 'listing', url, products, next,
  end: {type: 'result-total', total}});

test('import listing seeds traverses each category, checks independent totals, deduplicates capture queue after restart', async () => {
  const third = first + '?page=2';
  const r = rig({[first]: seedPage(first, [bra], 2, third),
    [third]: seedPage(third, [red], 2), [second]: seedPage(second, [bra, sleep], 2)});
  const writes = [];
  const save = r.io.save;
  r.io.save = async run => {writes.push(structuredClone(run)); return save(run);};
  await r.runner().importDiscovery(resultSite, [seedSource([first, second])]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].listingSeeds, [first, second]);
  assert.equal(r.memory.run.mode, 'discovery');
  assert.equal(r.memory.run.status, 'preview');
  assert.deepEqual(r.visits, []);
  await r.runner().start();
  for (let i=0;i<4;i++) {await r.runner().tick(); r.advance(12000);}
  assert.equal(r.memory.run.status, 'complete');
  assert.deepEqual(r.visits, [first, third, second]);
  const report = exportTakeoverReport(r.memory.run);
  assert.equal(report.totals.product_urls, 3);
  assert.deepEqual(report.listings.map(row => row.end_check.passed), [false,true,true]);
  await r.runner().importDiscovery(resultSite);
  assert.equal(r.memory.run.mode, 'capture-discovery');
  assert.equal(r.memory.run.products.length, 3);
});

test('listing seed terminal shortfall stops before another category or product capture', async () => {
  const r = rig({[first]: seedPage(first, [bra], 2), [second]: seedPage(second, [red], 1)});
  await r.runner().importDiscovery(resultSite, [seedSource([first, second])]);
  await r.runner().start(); await r.runner().tick();
  assert.equal(r.memory.run.status, 'discovery_incomplete');
  assert.deepEqual(r.visits, [first]);
  assert.deepEqual(r.captureCalls, []);
});

test('invalid listing seeds never replace an existing run', async () => {
  for (const urls of [[], [first,first], [first,'https://evil.test/list'], ['https://user@shop.example.test/list']]) {
    const r = rig({});
    await r.runner().preview(site, listing1);
    const before = structuredClone(r.memory.run);
    await assert.rejects(r.runner().importDiscovery(resultSite, [seedSource(urls)]));
    assert.deepEqual(r.memory.run, before);
  }
});

test('seed discovery pauses on denial and retains remaining seeds across resume', async () => {
  const pages = {[first]: seedPage(first, [bra], 1), [second]: {status: 429}};
  const r = rig(pages);
  await r.runner().importDiscovery(resultSite, [seedSource([first,second])]);
  await r.runner().start(); await r.runner().tick(); r.advance(12000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'paused');
  assert.deepEqual(r.memory.run.listings.queue, [second]);
  assert.equal(r.memory.run.listings.discoveryComplete, false);
  pages[second] = seedPage(second, [bra,red], 2);
  await r.runner().resume(); r.advance(12000);
  await r.runner().tick(); r.advance(12000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'complete');
  assert.equal(r.memory.run.products.length, 2);
});

test('seed discovery rejects changing totals even when final unique count matches', async () => {
  const r = rig({[first]: seedPage(first, [bra], 3, second), [second]: seedPage(second, [red], 2)});
  await r.runner().importDiscovery(resultSite, [seedSource([first])]);
  await r.runner().start(); await r.runner().tick(); r.advance(12000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'discovery_incomplete');
  assert.equal(r.memory.run.listings.discoveryComplete, false);
});

for (const [start, total, status] of [[3000,9000,'complete'],[4000,10000,'complete'],[4001,6000,'discovery_incomplete']]) {
  test(`seed discovery applies product safety limit to unique union (${start})`, async () => {
    const urls = offset => Array.from({length:6000},(_,i)=>`https://${site.domain}/product/${offset+i}`);
    const r = rig({[first]:seedPage(first,urls(0),6000),[second]:seedPage(second,urls(start),6000)});
    await r.runner().importDiscovery(resultSite,[seedSource([first,second])]);
    await r.runner().start();
    for(let i=0;i<3;i++){await r.runner().tick();r.advance(12000);}
    assert.equal(r.memory.run.status,status);
    assert.equal(r.memory.run.products.length,total);
  });
}

test('Bravissimo imported queue captures selected colors, survives restart and completes',async()=>{
  const config=require('../site_config/www.bravissimo.com.json');
  const urls=['fy563','pn305','lg402'].map(code=>require(`./fixtures/bravissimo-${code}.json`).canonical);
  const colors=['Blue Floral','White','Black'];
  const pages=Object.fromEntries(urls.map((url,i)=>[url,{kind:'product',url,product:{name:'Example Bra',category:'Plunge Bra',color:colors[i]},colorLinks:[]}]));
  const captures=Object.fromEntries(urls.map((url,i)=>[url,{storage:'receiver',status:'published',identity:{domain:config.domain,product_url:url,color_key:'color',selected_color:colors[i]}}]));
  const r=rig(pages,captures);
  r.io.verify=async identity=>{r.verificationCalls.push(identity);assert.equal(identity.color_key,'color');return {storage:'receiver',status:'already'};};
  const source=discoverySource(urls);source.report.site=config.domain;source.report.listings.forEach(x=>{x.url=x.final_url="https://www.bravissimo.com/us/collections/all-bras/";});
  await r.runner().importDiscovery(config,[source]);await r.runner().start();
  for(let i=0;i<4;i++){await r.runner().tick();r.advance(12000);}
  assert.equal(r.memory.run.status,'complete');assert.equal(r.captureCalls.length,3);
  assert.deepEqual(r.memory.run.products.map(p=>p.identity.selected_color),colors);
  assert.equal(r.verificationCalls.length,6); // Restart checks saved selected-color identities, no URL-only preflight.
  Object.values(captures).forEach((reply,i)=>{reply.status=i===1?'already':'reused';});
  await r.runner().importDiscovery(config,[source]);await r.runner().start();
  for(let i=0;i<4;i++){await r.runner().tick();r.advance(12000);}
  assert.equal(r.memory.run.status,'complete');
  assert.deepEqual(r.memory.run.products.map(p=>p.captureStatus),['reused','already','reused']);
  assert.equal(r.captureCalls.length,6); // Default color cannot safely be skipped without inspecting current page.
  assert.deepEqual(r.memory.run.products.map(p=>p.status),['captured','skipped','captured']);

});

test('Bravissimo queue rejects wrong completion color and unsupported capture policy',async()=>{
  const config=require('../site_config/www.bravissimo.com.json');const f=require('./fixtures/bravissimo-fy563.json');
  await assert.rejects(()=>rig({}).runner().importDiscovery({...config,captureColorPolicy:'unknown'},[]),/unsupported capture color policy/);
  await assert.rejects(()=>rig({}).runner().importDiscovery({...config,domain:'shop.example.test'},[]),/unsupported capture color policy/);

  for(const identity of [{color_key:'url',selected_color:null},{color_key:'color',selected_color:'Wrong'},{color_key:'color',selected_color:''}]){
    const r=rig({[f.canonical]:{kind:'product',url:f.canonical,product:{name:'Entwined Bra',category:'Plunge Bra',color:f.color},colorLinks:[]}}, {[f.canonical]:{storage:'receiver',status:'published',identity:{domain:config.domain,product_url:f.canonical,...identity}}});
    const source=discoverySource([f.canonical]);source.report.site=config.domain;source.report.listings.forEach(x=>{x.url=x.final_url="https://www.bravissimo.com/us/collections/all-bras/";});
    await r.runner().importDiscovery(config,[source]);await r.runner().start();await r.runner().tick();
    assert.equal(r.memory.run.status,'paused');assert.match(r.memory.run.reason,/capture identity/);
  }
});

test('structured validation advances once, survives resume and breaks at five failures', async()=>{
 const urls=Array.from({length:7},(_,i)=>bra+'/'+i);
 const pages=Object.fromEntries(urls.map(url=>[url,{status:0,error:'missing brand',errorCode:'PRODUCT_EVIDENCE_INVALID'}]));
 const r=rig(pages,{}, {verifyResult:{storage:'receiver',status:'missing'}});
 await r.runner().importDiscovery(site,[discoverySource(urls)]); await r.runner().start();
 r.memory.run.loadFailures[urls[0]]=3;
 await r.runner().pause(); await r.runner().resume();
 for(let i=0;i<5;i++){await r.runner().tick();r.advance(10000);}
 assert.equal(r.memory.run.status,'paused');
 assert.match(r.memory.run.reason,/5 consecutive.*missing brand/);
 assert.equal(r.memory.run.products.filter(p=>p.status==='failed').length,5);
 assert.equal(r.visits.length,5);
 assert.equal(r.memory.run.products[5].status,'pending');
});

test('reloaded paused 5366-product queue preserves 23 captured rows and resets validation streak on success',async()=>{
 const urls=Array.from({length:5366},(_,i)=>bra+'/'+i);
 const r=rig({[urls[23]]:{status:0,error:'missing brand',errorCode:'PRODUCT_EVIDENCE_INVALID'},[urls[24]]:{...braPage,url:urls[24],colorLinks:[]}}, {},{verifyResult:{storage:'receiver',status:'missing'}});
 await r.runner().importDiscovery(site,[discoverySource(urls)]);await r.runner().start();await r.runner().pause();
 for(let i=0;i<23;i++)Object.assign(r.memory.run.products[i],{status:'captured',identity:{domain:site.domain,product_url:urls[i],selected_color:null,color_key:'url'}});
 const before=structuredClone(r.memory.run.products.slice(0,23));
 r.memory.run.loadFailures[urls[23]]=3;
 // Receiver confirmation preserves completed rows after an MV3 restart.
 r.io.verify=async identity=>({storage:'receiver',status:urls.indexOf(identity.product_url)<23?'already':'missing'});
 await r.runner().resume();await r.runner().tick();r.advance(10000);await r.runner().tick();
 assert.deepEqual(r.memory.run.products.slice(0,23),before);
 assert.equal(r.memory.run.products.length,5366);
 assert.equal(r.memory.run.products[23].status,'failed');
 assert.equal(r.memory.run.products[24].status,'captured');
 assert.equal(r.memory.run.consecutiveFailures,0);
 assert.deepEqual(r.visits,[urls[23],urls[24]]);
});

test('non-Shirohato structured validation is classified explicitly and challenge text wins',async()=>{
 const helpers=require('../extension_helpers');
 let error;try{helpers.vandeveldeProduct({},'https://www.mariejo.com/en-us/p/example');}catch(e){error=e;}
 assert.equal(error.code,'PRODUCT_EVIDENCE_INVALID');
 for(const challenge of [false,true]){
  const r=rig({[bra]:{status:0,error:challenge?'captcha challenge':error.message,errorCode:error.code}},{},{verifyResult:{storage:'receiver',status:'missing'}});
  await r.runner().importDiscovery(site,[discoverySource([bra])]);await r.runner().start();await r.runner().tick();
  assert.equal(r.memory.run.products[0].status,challenge?'pending':'failed');
  assert.equal(r.memory.run.status,challenge?'paused':'running');
 }
});

test('reimported Shirohato discovery cheaply skips 23 receiver captures before failing bad PDP and continuing',async()=>{
 const config=require('../site_config/www.wakudoki.ne.jp.json');
 const urls=Array.from({length:5366},(_,i)=>`https://${config.domain}/productdetail/fixture${i}/1/`);
 urls[23]=`https://${config.domain}/productdetail/202792b/1/`;
 const next=urls[24];
 const source=discoverySource(urls,'c'.repeat(64),`https://${config.domain}/c/000010001/?dpt=pro&udns=1`);
 source.report.site=config.domain;
 const r=rig({[urls[23]]:{status:0,error:'Shirohato product: missing brand',errorCode:'PRODUCT_EVIDENCE_INVALID'},
   [next]:{...braPage,url:next,colorLinks:[]}}, {},{verifyResult:{storage:'receiver',status:'missing'}});
 const already=new Set(urls.slice(0,23));
 r.io.verify=async identity=>{
  r.verificationCalls.push(identity);
  return {storage:'receiver',status:already.has(identity.product_url)?'already':'missing'};
 };
 const runner=r.runner();
 await runner.importDiscovery(config,[source]);await runner.start();
 assert.equal(r.memory.run.products.length,5366);
 for(let i=0;i<23;i++){await runner.tick();r.advance(10000);}
 assert.deepEqual(r.memory.run.products.slice(0,23).map(p=>[p.status,p.captureStatus]),Array.from({length:23},()=>['skipped','already']));
 assert.deepEqual(r.verificationCalls.map(identity=>identity.product_url),urls.slice(0,23));
 // No page navigation or capture boundary means no product/image acquisition for receiver hits.
 assert.deepEqual(r.visits,[]);assert.deepEqual(r.captureCalls,[]);
 await runner.tick();r.advance(10000);await runner.tick();
 assert.equal(r.memory.run.products[23].status,'failed');
 assert.equal(r.memory.run.products[23].reason,'Shirohato product: missing brand');
 assert.equal(r.memory.run.products[24].status,'captured');
 assert.equal(r.memory.run.products[25].status,'pending');
 assert.deepEqual(r.visits,[urls[23],next]);
 assert.deepEqual(r.captureCalls.map(call=>call.url),[next]);
 assert.equal(r.memory.run.status,'running');assert.equal(r.memory.run.consecutiveFailures,0);
});
