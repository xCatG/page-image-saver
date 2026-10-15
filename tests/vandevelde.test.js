const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {vandeveldeProduct} = require('../extension_helpers');
const expected = require('./fixtures/vdv-expected.json');
const data = row => JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures',row.fixture),'utf8').match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)[1]);
for (const row of expected) test(`${row.brand} ${row.kind}: saved Next data yields exact colour identity, USD price and original gallery`, () => {
  const result = vandeveldeProduct(data(row), row.url);
  assert.deepEqual(result.facts, {name:row.name, sku:row.sku, product_id:row.product_id, color:row.color,
    offers:{price:String(row.price),currency:'USD'},category:`lingerie / ${row.kind==='other'?'body':row.kind==='brief'?'briefs':'bra'}`});
  assert.deepEqual(result.images,row.images);
});
test('VDV rejects stale Next data after a colour URL change, wrong market, currency and foreign media', () => {
  const row=expected[0];
  for (const mutate of [
    n => {n.props.pageProps.product.id='another-color';},
    n => {n.props.pageProps.locale='en-gb';},
    n => {n.props.pageProps.product.retailPrice.currency='EUR';},
    n => {n.props.pageProps.product.media[0].url='https://evil.test/image.jpg';},
    n => {n.props.pageProps.product.media=[];},
    n => {n.props.pageProps.slug='other-product';},
    n => {n.props.pageProps.product.retailPrice.discountedPrice=-1;}
  ]) {const n=data(row);mutate(n);assert.throws(()=>vandeveldeProduct(n,row.url),/VDV/);}
  assert.throws(()=>vandeveldeProduct(data(row),row.url.replace('/en-us/','/en-gb/')),/VDV/);
  assert.throws(()=>vandeveldeProduct(data(row),row.url.replace('www.primadonna.com','evil.test')),/VDV/);
});
test('VDV scope guard does not approve swim, nightwear or accessories via lingerie breadcrumbs', () => {
  const {classifyTakeoverScope}=require('../takeover_runner');
  for(const domain of ['www.primadonna.com','www.mariejo.com']) {
    for(const name of ['Swim bikini','Nightwear top','Accessories straps'])
      assert.notEqual(classifyTakeoverScope({name,category:'lingerie'},{domain}).decision,'include');
    assert.equal(classifyTakeoverScope({name:'Body',category:'lingerie / body'},{domain}).decision,'include');
  }
});
test('VDV validation reports the specific missing product field', () => {
  for (const field of ['name','commercialColor','styleCode']) {
    const row=expected[0], value=data(row); value.props.pageProps.product[field]='';
    assert.throws(()=>vandeveldeProduct(value,row.url), error=>error.code==='PRODUCT_EVIDENCE_INVALID' && error.message.includes(field));
  }
});
