const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const config = require('../site_config/www.barenecessities.com.json');
const source = fs.readFileSync(require.resolve('../content_script.js'), 'utf8');
const origin = 'https://www.barenecessities.com';

function listing({page = 1, readyAt = 600, current = page, initialCurrent = null, next = true, total = 580} = {}) {
  let now = 0;
  const document = {
    title: 'Bras', body: {innerText: 'Bras'}, documentElement: {lang: 'en-US'},
    querySelector(selector) {
      if (selector === '.br-collection .br-pagination__item--current')
        return (now >= readyAt ? current : initialCurrent) !== null
          ? {textContent: String(now >= readyAt ? current : initialCurrent)} : null;
      if (selector === config.listing.pagination.nextSelector)
        return now >= readyAt && next ? {} : null;
      if (selector === config.listing.endCheck.selector) return {textContent: `${total}products`};
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, config.listing.productLinkSelector);
      // Existing cards can belong to the previous page until pagination hydrates.
      const slug = now >= readyAt ? 'current-bra' : 'stale-bra';
      const card = {textContent: slug, querySelector: () => null};
      return [{href: `${origin}/products/${slug}?variant=123`, closest: () => card}];
    }
  };
  const sandbox = {document, URL, window: {location: new URL(`${origin}/collections/bras${page === 1 ? '' : '?page='+page}`)},
    Date: {now: () => now}, setTimeout: callback => {now += 200; callback();},
    capturePageProduct: () => null, captureProductSeen: () => false,
    takeoverDocumentId: 'document', PageImageSaverHelpers: require('../extension_helpers')};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source.slice(source.indexOf('async function inspectTakeoverPage('),
    source.indexOf('// A site must be explicitly enabled')), sandbox);
  return {inspect: () => sandbox.inspectTakeoverPage(config, 'discovery'), elapsed: () => now};
}

test('BN waits for delayed pagination with cards already present, then rereads cards and next', async () => {
  const harness = listing({page: 2, readyAt: 8000});
  const result = await harness.inspect();
  assert.deepEqual(Array.from(result.products), [`${origin}/products/current-bra`]);
  assert.equal(result.cards[0].card_text, 'current-bra');
  assert.equal(result.next, `${origin}/collections/bras?page=3`);
  assert.equal(harness.elapsed(), 8000);
});

test('BN default first page and terminal page inspect immediately when pagination is ready', async () => {
  const harness = listing({readyAt: 0, next: false});
  const result = await harness.inspect();
  assert.equal(result.next, null);
  assert.equal(harness.elapsed(), 0);
});

for (const current of [null, 1, 0, 'invalid']) {
  test(`BN rejects missing or mismatched pagination after bounded wait: ${current}`, async () => {
    const harness = listing({page: 2, readyAt: 0, current, next: false});
    await assert.rejects(harness.inspect, /Bare Necessities listing: pagination does not match URL/);
    assert.equal(harness.elapsed(), 10000);
  });
}

test('BN accepts a previously mismatched page once it changes to the URL page', async () => {
  const harness = listing({page: 3, readyAt: 600, initialCurrent: 2});
  assert.equal((await harness.inspect()).next, `${origin}/collections/bras?page=4`);
});


test('BN keeps unproven single-page markup fail-closed even when total fits one page', async () => {
  const harness = listing({readyAt: 0, current: null, next: false, total: 1});
  await assert.rejects(harness.inspect, /Bare Necessities listing: pagination does not match URL/);
  assert.equal(harness.elapsed(), 10000);
});

test('BN accepts pagination appearing at the wait deadline', async () => {
  const harness = listing({readyAt: 10000});
  assert.equal((await harness.inspect()).products[0], `${origin}/products/current-bra`);
  assert.equal(harness.elapsed(), 10000);
});
