const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const helpers = require('../extension_helpers');
const rows = require('./fixtures/bare-necessities-expected.json').filter(r => r.product_id);
const origin = 'https://www.barenecessities.com';
for (const row of rows) {
  const html = fs.readFileSync(`${__dirname}/fixtures/${row.fixture}`, 'utf8');
  const script = html.match(/<script id="swym-snippet">([\s\S]*?)<\/script>/)[1];
  const evidence = JSON.parse(html.match(/<script[^>]*id="elevar-product-view"[^>]*>([\s\S]*?)<\/script>/)[1]);
  test(`BN binds real Shopify identity and original gallery ${row.product_id}`, () => {
    const result = helpers.bareNecessitiesProduct(script,row.url+'?variant=123',row.url,'USD',evidence.defaultVariant);
    assert.equal(result.facts.product_id,row.product_id);
    assert.equal(result.facts.offers.price,row.price);
    assert.deepEqual(helpers.bareNecessitiesGallery(result.images,row.images),row.images);
    for (const [page,canonical,currency] of [
      [row.url, row.url.replace(origin,'https://evil.test'),'USD'],
      [row.url+'/other',row.url,'USD'],[row.url,row.url,'CAD']]) {
      assert.throws(() => helpers.bareNecessitiesProduct(script,page,canonical,currency,evidence.defaultVariant),/Bare Necessities product/);
    }
    assert.throws(()=>helpers.bareNecessitiesGallery(result.images,['https://evil.test/cdn/shop/files/other.jpg']),/not bound/);
    assert.throws(()=>helpers.bareNecessitiesGallery(result.images,[origin+'/cdn/shop/files/recommendation.jpg']),/not bound/);
    assert.throws(()=>helpers.bareNecessitiesGallery(result.images,[]),/no rendered images/);
    for (const changed of [{...evidence.defaultVariant,productId:'1'},
      {...evidence.defaultVariant,variantId:'1'},{...evidence.defaultVariant,price:'0.01'}])
      assert.throws(()=>helpers.bareNecessitiesProduct(script,row.url,row.url,'USD',changed),/page variant price not bound/);
  });
}
test('BN packaged configuration exposes scope, pagination and current-gallery selectors', () => {
  const config = require('../site_config/www.barenecessities.com.json');
  assert.equal(config.currency,'USD');
  assert.equal(config.colorVariantStrategy,'separate-url');
  assert.equal(config.product.allImagesSelector,'.br-gallery-carousel__main img');
  assert.equal(helpers.listingResultTotal('580products'),580);
});
const {classifyTakeoverScope} = require('../takeover_runner');
test('BN smoke scope includes validated retailer categories and garter; bikini panties stay intimate', () => {
  const config={domain:'www.barenecessities.com'};
  for (const [name,category] of [['Fascinate Garter Belt','Sexy Lingerie, Accessories'],['Rive Gauche Bikini','Panties']])
    assert.equal(classifyTakeoverScope({name,category},config).decision,'include');
  assert.equal(classifyTakeoverScope({name:'Bikini Top',category:'Swimwear'},config).decision,'exclude');
});
test('BN explicit excluded evidence wins over intimate categories', () => {
  const config={domain:'www.barenecessities.com'};
  for (const name of ['Swim Bra','Swimwear Brief','Swimsuit Brief','Sleepwear Bra','Nightwear Bra',
    'Nightdress Bra','Nightdresses Brief','Pyjama Brief','Pajama Brief','Menswear Bra',"Men’s Brief",'Men Brief','Kids Bra'])
    assert.equal(classifyTakeoverScope({name,category:'Panties'},config).decision,'exclude',name);
  for (const category of ['Kids','Nightwear','Menswear','Swimwear','Nightdresses'])
    assert.equal(classifyTakeoverScope({name:'Full Brief',category},config).decision,'exclude',category);
  assert.equal(classifyTakeoverScope({name:'Rive Gauche Bikini',category:'Panties'},config).decision,'include');
});

test('BN childrenswear evidence excludes in either title or category', () => {
  const config={domain:'www.barenecessities.com'};
  for (const term of ['Child', "Child's", 'Children', "Children's", 'Children’s', 'Childrens', 'Childrenswear', 'Children’s Wear']) {
    for (const product of [{name:term+' Bra', category:'Bras'}, {name:'Collection Essential', category:term}])
      assert.equal(classifyTakeoverScope(product,config).decision,'exclude',JSON.stringify(product));
  }
});
test('BN womens lingerie titles remain included', () => {
  const config={domain:'www.barenecessities.com'};
  for (const name of ['Womens Support Bra', "Women's Support Bra", 'Women’s Support Bra'])
    assert.equal(classifyTakeoverScope({name,category:'Bras'},config).decision,'include',name);
});
test('BN validation names the missing identity field', () => {
  const row=rows[0], html=fs.readFileSync(`${__dirname}/fixtures/${row.fixture}`,'utf8');
  const script=html.match(/<script id="swym-snippet">([\s\S]*?)<\/script>/)[1];
  const evidence=JSON.parse(html.match(/<script[^>]*id="elevar-product-view"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const match=script.match(/window.SwymProductInfo.product = (\{.*?\});/s);
  for(const field of ['id','title','vendor']) {
    const product=JSON.parse(match[1]);product[field]=null;
    assert.throws(()=>helpers.bareNecessitiesProduct(script.replace(match[1],JSON.stringify(product)),row.url,row.url,'USD',evidence.defaultVariant),
      error=>error.code==='PRODUCT_EVIDENCE_INVALID' && error.message.includes(field));
  }
});
