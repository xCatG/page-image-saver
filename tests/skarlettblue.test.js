const {test} = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../extension_helpers.js');

test('Skarlett Blue uses the existing Shopify feed exporter on its own host', async () => {
  const config = require('../site_config/www.skarlettblue.com.json');
  assert.equal(helpers.canSaveShopifyFeed(config), true);
  const requested = [];
  const report = await helpers.collectShopifyFeed(config, 'https://www.skarlettblue.com/collections/bras', {
    fetch: async url => { requested.push(url); return new Response(JSON.stringify({products: []}), {headers: {'content-type': 'application/json'}}); }
  });
  assert.deepEqual(requested, ['https://www.skarlettblue.com/products.json?limit=250&page=1']);
  assert.equal(report.host, 'www.skarlettblue.com');
  assert.equal(config.colorVariantStrategy, 'separate-url');
  assert.equal(config.currency, 'USD');
  assert.equal(config.market, 'us');
  const allowed = new RegExp(config.product.imageUrlPattern);
  assert.ok(allowed.test('https://cdn.shopify.com/s/files/1/image.jpg'));
  assert.ok(allowed.test('https://www.skarlettblue.com/cdn/shop/files/image.jpg'));
  assert.ok(!allowed.test('https://unrelated.example/image.jpg'));
});
