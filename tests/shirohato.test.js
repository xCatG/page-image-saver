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
