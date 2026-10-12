const test = require('node:test');
const assert = require('node:assert/strict');
const {liseCharmelGallery, listingResultTotal} = require('../extension_helpers');
const page = 'https://www.lisecharmel.com/lc_us_en/fancy-brief.html';
const original = 'https://www.lisecharmel.com/media/catalog/product/a/c/brief.jpg?optimize=medium&fit=bounds&height=&width=';
const init = data => JSON.stringify({'[data-gallery-role=gallery-placeholder]': {'mage/gallery/gallery': {data}}});
test('primary Magento gallery keeps evidenced full URL, not thumbnails or recommendation galleries', () => {
  const recommendations = JSON.stringify({'.recommendations': {'mage/gallery/gallery': {data:[{full:'https://evil.test/recommendation.jpg'}]}}});
  assert.deepEqual(liseCharmelGallery([recommendations, init([{type:'image',img:original+'&width=1170',full:original}, {type:'image',full:original}])], page), [original]);
});
test('missing, ambiguous and malformed primary galleries fail closed', () => {
  for (const scripts of [[], [init([])], [init([{type:'image',img:original}])], [init([{full:original}]),init([{full:original}])], ['{"mage/gallery/gallery":']]) {
    assert.throws(() => liseCharmelGallery(scripts,page), /LC gallery/);
  }
});
test('gallery does not allow foreign media, credentials, insecure URLs or unrelated paths', () => {
  for (const full of ['https://evil.test/media/catalog/product/a.jpg','https://user@www.lisecharmel.com/media/catalog/product/a.jpg','http://www.lisecharmel.com/media/catalog/product/a.jpg','https://www.lisecharmel.com/tracking.gif']) {
    assert.throws(() => liseCharmelGallery([init([{type:'image',full}])],page), /LC gallery/);
  }
});
test('Magento listing totals preserve the total, not range endpoints; legacy totals remain supported', () => {
  assert.equal(listingResultTotal(' Items 1 - 24 of 537 '),537);
  assert.equal(listingResultTotal('Items 529-537 of 537'),537);
  assert.equal(listingResultTotal('27 products'),27);
  assert.equal(listingResultTotal('Items 1-24'),null);
  assert.equal(listingResultTotal('Items 25-48 of 23'),null);
});
test('US Magento category aliases produce the colour-specific candidate URL without weakening capture binding', () => {
  const normalize = require('../extension_helpers').liseCharmelProductUrl;
  assert.equal(normalize('https://www.lisecharmel.com/lc_us_en/catalog/product/view/id/41637/s/3-parts-full-cup-soir-de-venise-noir-diamant-aca6103-8049/category/19/'),
    'https://www.lisecharmel.com/lc_us_en/3-parts-full-cup-soir-de-venise-noir-diamant-aca6103-8049.html');
  assert.equal(normalize(page), page);
  const foreign = 'https://evil.test/lc_us_en/catalog/product/view/id/1/s/bra-aca6103-8049/category/19/';
  assert.equal(normalize(foreign), foreign);
});
test('LC accessory breadcrumbs cannot turn an out-of-scope item into approved lingerie', () => {
  const {classifyTakeoverScope} = require('../takeover_runner');
  const config = {domain:'www.lisecharmel.com'};
  for (const name of ['Jewelry mask', 'Stockings', 'Silk nightdress', 'Swimwear bikini']) {
    assert.notEqual(classifyTakeoverScope({name, category:'Home Lingerie Accessories'}, config).decision, 'include');
  }
  assert.equal(classifyTakeoverScope({name:'Bodysuit', category:'Home Lingerie Basques and bodysuits'}, config).decision, 'include');
});
