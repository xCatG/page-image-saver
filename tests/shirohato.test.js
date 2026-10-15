const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {shirohatoProduct, shirohatoGallery, listingResultTotal} = require('../extension_helpers');
const {classifyTakeoverScope} = require('../takeover_runner');
const rows = require('./fixtures/shirohato-expected.json').filter(r => r.product_id);
function data(row) { return JSON.parse(fs.readFileSync(`${__dirname}/fixtures/${row.fixture}`, 'utf8').match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]); }
for (const row of rows) test(`Shirohato ${row.product_id}: canonical JP facts and original gallery`, () => {
  const facts = shirohatoProduct([data(row)], row.url + '?bid=3', row.url);
  assert.deepEqual(facts, {name:row.name,sku:row.product_id,product_id:row.product_id,color:null,offers:{price:row.price,currency:'JPY'}});
  assert.deepEqual(shirohatoGallery([...row.images,row.images[0]],row.product_id),row.images);
  assert.equal(classifyTakeoverScope({name:row.name,category:row.category},{domain:'www.wakudoki.ne.jp'}).decision,'include');
});
test('Shirohato rejects stale product data, wrong origin/market/price and ambiguous products', () => {
 const row=rows[0];
 for (const mutate of [d=>d.productID='other',d=>d.url=row.url.replace('/1/','/2/'),d=>d.offers.priceCurrency='USD',d=>d.offers.price='-1',d=>d.sku='other']) {
  const d=data(row);mutate(d);assert.throws(()=>shirohatoProduct([d],row.url,row.url),/Shirohato/);
 }
 assert.throws(()=>shirohatoProduct([data(row),data(row)],row.url,row.url),/Shirohato/);
 assert.throws(()=>shirohatoProduct([data(row)],row.url,row.url.replace('www.wakudoki.ne.jp','evil.test')),/Shirohato/);
 assert.throws(()=>shirohatoProduct([data(row)],row.url.replace('/1/','/2/'),row.url),/Shirohato/);
});
test('Shirohato gallery never guesses originals or captures unrelated assets', () => {
 for (const url of ['https://evil.test/Contents/ProductImages/0/p_LL.jpg','https://img.wakudoki.ne.jp/Contents/ProductImages/0/other_LL.jpg','https://img.wakudoki.ne.jp/Contents/ProductImages/0/p_L.jpg','./saved_files/p_LL.jpg','http://img.wakudoki.ne.jp/Contents/ProductImages/0/p_LL.jpg'])
  assert.throws(()=>shirohatoGallery([url],'p'),/Shirohato/);
 assert.throws(()=>shirohatoGallery([],'p'),/Shirohato/);
});
test('Japanese listing totals are exact and reject malformed/range-only text', () => {
 assert.equal(listingResultTotal(' 1,993 件 '),1993);
 assert.equal(listingResultTotal('776件'),776);
 for (const text of ['1件～60件','1,99件','1993件 次へ']) assert.equal(listingResultTotal(text),null);
});
test('Shirohato Japanese exclusions take precedence over lingerie names and navigation', () => {
 for (const name of ['メンズ ブラジャー','キッズ ショーツ','水着 ビキニ','パジャマ ランジェリー','ストッキング','靴下','インナーシャツ','ルームウェア ブラジャー','Mens bra','Kids panties','Swimwear bra','Nightwear lingerie'])
  assert.notEqual(classifyTakeoverScope({name,category:'ワイヤーブラ'},{domain:'www.wakudoki.ne.jp'}).decision,'include');
 assert.equal(classifyTakeoverScope({name:'unknown',category:'unknown'},{domain:'www.wakudoki.ne.jp'}).decision,'review');
});
test('Shirohato discovery cannot claim completion from two saved pages or changing totals', () => {
 const {endCheckPasses} = require('../takeover_runner');
 const config = require('../site_config/www.wakudoki.ne.jp.json');
 const page = {end:{type:'result-total',total:1993}};
 const visited = [{end:page.end},{end:page.end}];
 assert.equal(endCheckPasses(config,page,visited,120),false);
 assert.equal(endCheckPasses(config,page,visited,1993),true);
 assert.equal(endCheckPasses(config,page,[{end:{type:'result-total',total:1992}}],1993),false);
 assert.equal(endCheckPasses(config,{end:null},visited,1993),false);
});

test('gallery diagnostics identify the rejecting condition without disclosing URL values', () => {
  const id = 'c6510226179ef';
  const cases = [
    [[], 'no matching gallery images'],
    [['//img.wakudoki.ne.jp/Contents/ProductImages/0/c6510226179ef_LL.jpg'], 'image 1 is not an absolute URL'],
    [['https://evil.test/private?secret=value'], 'image 1 has an unapproved origin'],
    [['https://img.wakudoki.ne.jp/Contents/ProductImages/0/c6510226179ef_LL.jpg?secret=value'], 'image 1 has a query or fragment'],
    [['https://img.wakudoki.ne.jp/Contents/ProductImages/0/unrelated_LL.jpg'], 'image 1 is not a current-product original'],
  ];
  for (const [urls, reason] of cases) {
    assert.throws(() => shirohatoGallery(urls, id), error => error.message === `Shirohato gallery: ${reason}`);
  }
});

test('owner-probed Triumph gallery preserves both original image directories', () => {
  const row = rows.find(r => r.product_id === 'c6510226179ef');
  assert.equal(row.images.filter(u => u.includes('/ProductImages/')).length, 3);
  assert.equal(row.images.filter(u => u.includes('/ProductSubImages/')).length, 11);
  assert.deepEqual(shirohatoGallery(row.images, row.product_id), row.images);
});

test('subimage acceptance requires this product, exact directory and numbered original filename', () => {
  for (const id of ['c6510226179ef', '40pxb178ml', 'c2226hm038gb']) {
    const base = 'https://img.wakudoki.ne.jp/Contents/ProductSubImages/0/';
    const good = base + id + '_sub01_LL.jpg';
    assert.deepEqual(shirohatoGallery([good, good], id), [good]);
    for (const bad of [
      base + 'other_sub01_LL.jpg', base + id + '_LL.jpg', base + id + '-cf01_LL.jpg',
      base + id + '_sub_LL.jpg', base + id + '_subx_LL.jpg', base + id + '_sub01_L.jpg',
      base + id + '_sub01_extra_LL.jpg', base.replace('/0/', '/1/') + id + '_sub01_LL.jpg',
      good + '?v=1', good + '#x', good.replace('https:', 'http:'),
      good.replace('img.wakudoki.ne.jp', 'evil.test'), good.replace('https:', ''),
      good.replace('https://', 'https://user@'), good.replace('.jp/', '.jp:444/'),
    ]) assert.throws(() => shirohatoGallery([good, bad], id), /Shirohato gallery/);
  }
});

test('Shirohato diagnostic reasons identify each failed structured check',()=>{
 const row=rows[0];
 for(const [change,reason] of [[d=>delete d.brand,'missing brand'],[d=>delete d.name,'missing name'],[d=>delete d.category,'missing category'],[d=>delete d.offers,'no JPY offer'],[d=>d.offers.price='1.5','price is not a positive integer'],[d=>d.sku='wrong','sku mismatch'],[d=>d.productID='wrong','productID mismatch']]){
  const p=data(row);change(p);
  assert.throws(()=>shirohatoProduct([p],row.url,row.url),error=>error.code==='PRODUCT_EVIDENCE_INVALID'&&error.message===`Shirohato product: ${reason}`);
 }
 assert.throws(()=>shirohatoProduct([],row.url,row.url),/0 Product nodes/);
 assert.throws(()=>shirohatoProduct([data(row),data(row)],row.url,row.url),/2 Product nodes/);
});
