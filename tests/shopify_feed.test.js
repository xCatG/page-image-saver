const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const helpers = require('../extension_helpers.js');
const config = {domain: 'www.sanscomplexe.com', platform: 'shopify', takeover: {intervalMs: 10000}};

test('Shopify feed preserves prefix, pages, response hashes and configured pacing', async () => {
  const requests = [], waits = [];
  const bodies = [JSON.stringify({products: Array.from({length: 250}, (_, id) => ({id}))}), '{"products":[{"id":250}]}'];
  const result = await helpers.collectShopifyFeed(config, 'https://www.sanscomplexe.com/en/collections/culottes', {
    fetch: async (url, options) => {
      requests.push(url);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      return new Response(bodies[requests.length - 1], {headers: {'content-type': 'application/json'}});
    }, sleep: async ms => waits.push(ms)
  });
  assert.deepEqual(requests, [1, 2].map(n => `https://www.sanscomplexe.com/en/products.json?limit=250&page=${n}`));
  assert.deepEqual(waits, [10000]);
  assert.equal(result.prefix, '/en');
  assert.equal(result.version, 1);
  assert.equal(result.host, config.domain);
  assert.equal(result.pages[1].products[0].id, 250);
  assert.deepEqual(result.fetched.map(p => p.product_count), [250, 1]);
  assert.equal(result.fetched[0].sha256, createHash('sha256').update(bodies[0]).digest('hex'));
  assert.equal(result.fetched[0].status, 200);
  assert.ok(Date.parse(result.fetched[0].fetched_at));
});

for (const status of [403, 429]) test(`HTTP ${status} stops immediately, without retry`, async () => {
  let calls = 0;
  await assert.rejects(() => helpers.collectShopifyFeed(config, 'https://www.sanscomplexe.com/en/', {
    fetch: async () => { calls++; return new Response('blocked', {status}); },
    sleep: async () => assert.fail('must not wait/retry')
  }), new RegExp(String(status)));
  assert.equal(calls, 1);
});

test('non-JSON/challenge or invalid feed stops rather than exporting a short page', async () => {
  for (const response of [new Response('<html>Verify you are human</html>', {headers: {'content-type':'text/html'}}),
    new Response('{"challenge":true}', {headers:{'content-type':'application/json'}})]) {
    await assert.rejects(() => helpers.collectShopifyFeed(config, 'https://www.sanscomplexe.com/en/', {
      fetch: async () => response
    }), /JSON|products|challenge/);
  }
});

test('feed action is unavailable for non-Shopify configs and other hosts', async () => {
  assert.equal(helpers.canSaveShopifyFeed(null), false);
  assert.equal(helpers.canSaveShopifyFeed({platform:'custom'}), false);
  assert.equal(helpers.canSaveShopifyFeed(config), true);
  await assert.rejects(() => helpers.collectShopifyFeed({...config, platform:'custom'}, 'https://www.sanscomplexe.com/en/'), /Shopify/);
  await assert.rejects(() => helpers.collectShopifyFeed(config, 'https://other.test/en/'), /host/);
});

test('feed uses at least three seconds even with a faster takeover interval', async () => {
  let calls = 0;
  const waits = [];
  await helpers.collectShopifyFeed({...config, takeover:{intervalMs:0}}, 'https://www.sanscomplexe.com/', {
    fetch: async url => {
      assert.ok(url.startsWith('https://www.sanscomplexe.com/products.json?'));
      return new Response(JSON.stringify({products: calls++ ? [] : Array(250).fill({id:1})}), {headers:{'content-type':'application/json'}});
    }, sleep: async ms => waits.push(ms)
  });
  assert.deepEqual(waits, [3000]);
});

test('repeated full page stops instead of looping forever', async () => {
  let calls = 0;
  await assert.rejects(() => helpers.collectShopifyFeed(config, 'https://www.sanscomplexe.com/en/', {
    fetch: async () => {
      if (++calls > 2) throw new Error('third request must not happen');
      return new Response(JSON.stringify({products: Array.from({length:250}, (_, id) => ({id}))}),
        {headers:{'content-type':'application/json'}});
    }, sleep: async () => {}
  }), /repeated.*page/i);
  assert.equal(calls, 2);
});
