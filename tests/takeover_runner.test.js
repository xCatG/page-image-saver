const assert = require('node:assert/strict');
const test = require('node:test');
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
    load: async url => { visits.push(url); return {...(pages[url] || {status: 404}),
      tabId: 7, documentId: `fixture:${url}`}; },
    capture: async (url, scope, binding) => {
      captureCalls.push({url, scope, binding});
      const reply = captures[url] || {storage: 'receiver', status: 'published'};
      if (reply instanceof Error) throw reply;
      if (failAfterCapture) { failAfterCapture = false; crashOnSave = true; }
      return {...reply, identity: reply.identity || {domain: 'shop.example.test', product_url: url,
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

test('preview stores observations but only explicit take over starts navigation', async () => {
  const r = rig({[first]: listing1});
  await r.runner().preview(site, listing1);
  assert.deepEqual(r.visits, []);
  assert.equal(r.memory.run.status, 'preview');
  assert.equal(r.memory.run.preview.endCheckConfigured, true);
  await assert.rejects(() => r.runner().start(), /preview a product page/);
  await r.runner().preview(site, {...braPage, imageCount: 2});
  assert.equal(r.memory.run.previews.find(p => p.kind === 'product').scope.decision, 'include');
  assert.equal(r.memory.run.previews.find(p => p.kind === 'product').imageCount, 2);
  await r.runner().start();
  assert.equal(r.memory.run.status, 'running');
  assert.deepEqual(r.visits, []);
  assert.ok(r.alarms.length > 0, 'a recovery alarm must exist before first navigation');
  await r.runner().tick();
  assert.deepEqual(r.visits, [first]);
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
  assert.deepEqual(summarizeTakeover(r.memory.run), {listingPagesVisited: 2,
    productsFound: 3, productsCaptured: 2, colorsCaptured: 2, sizeOptionsTraversed: 0,
    excluded: 1, failed: 0, pending: 0, exportedUnverified: 0});
  assert.deepEqual(r.captureCalls.map(call => call.url), [bra, red]);
  assert.equal(r.captureCalls[0].scope.decision, 'include');
});

test('missing next on known nonfinal page is discovery_incomplete', async () => {
  const r = rig({[first]: {...listing1, next: null}});
  await prepare(r); await r.runner().start(); await r.runner().tick();
  assert.equal(r.memory.run.status, 'discovery_incomplete');
  assert.equal(r.memory.run.products.length, 2);
  assert.equal(r.memory.run.reason.includes('end check'), true);
});

test('page-count end check rejects repeated page numbers even when final count matches', async () => {
  const r = rig({[first]: {...listing1, end: {type: 'page-count', current: 2, total: 2}},
    [second]: listing2});
  await prepare(r); await r.runner().start(); await r.runner().tick();
  r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'discovery_incomplete');
  assert.equal(r.memory.run.listings.visited.length, 2);
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
  assert.equal(classifyTakeoverScope({name: 'Women Briefs', category: ''}).decision, 'include');
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

test('same-site product redirect cannot satisfy a different queued URL', async () => {
  const config = structuredClone(site); config.listing.endCheck = {type: 'explicit', selector: '.end'};
  const r = rig({[first]: {...listing1, products: [bra], next: null,
    end: {type: 'explicit', present: true}}, [bra]: {...redPage, url: red}});
  await prepare(r, config); await r.runner().start();
  await r.runner().tick(); r.advance(10000); await r.runner().tick();
  assert.equal(r.memory.run.status, 'paused');
  assert.equal(r.memory.run.products[0].status, 'pending');
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
