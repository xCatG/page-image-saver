const {test}=require('node:test');const assert=require('node:assert/strict');const h=require('../extension_helpers');
for(const code of ['fy563','fy564','fy565','pn305','pn306','lg402','lg403'])test(`Bravissimo ${code} selected public product`,()=>{const f=require(`./fixtures/bravissimo-${code}.json`);const r=h.bravissimoProduct(f.product,f.jsonld,f.canonical,f.canonical,f.color,'USD');assert.equal(r.facts.sku,f.product.styleColourCode);assert.equal(r.microdata.brand,f.product.brand);assert.equal(r.facts.offers.currency,'USD');assert.equal(r.images.length,f.product.images.length);assert.equal(r.images[0],'https:'+f.product.images[0].zoom);});
test('Bravissimo refuses stale color, foreign locale, missing brand and non USD',()=>{const f=require('./fixtures/bravissimo-fy563.json');for(const args of [[f.product,f.jsonld,f.canonical,f.canonical,'Beige/Black'],[{...f.product,brand:''},f.jsonld,f.canonical,f.canonical,f.color],[f.product,f.jsonld,f.canonical.replace('/us/','/'),f.canonical,f.color],[f.product,f.jsonld.map(x=>x.offers?{...x,offers:{...x.offers,priceCurrency:'GBP'}}:x),f.canonical,f.canonical,f.color]])assert.throws(()=>h.bravissimoProduct(...args,'USD'));});
const runner=require('../takeover_runner');
test('Bravissimo scope has narrow categories and hard exclusions',()=>{const c={domain:'www.bravissimo.com'};for(const category of ['Plunge Bra','Full Cup Bra','Balconette Bra','Brief','Thong','High Waisted Brief'])assert.equal(runner.classifyTakeoverScope({name:'Example',category},c).decision,'include');for(const category of ['Swimsuit','Nightdress','Sportswear','Accessories','Mens Bra'])assert.equal(runner.classifyTakeoverScope({name:'Example',category},c).decision,'exclude');assert.equal(runner.classifyTakeoverScope({name:'Mystery Bra',category:'Unknown'},c).decision,'review');});

for (const type of ['Product', 'ProductGroup']) test(`Bravissimo rejects present ${type} without current identity`, () => {
  const f = require('./fixtures/bravissimo-fy563.json');
  const stale = f.jsonld.map(node => node['@type'] !== type ? node :
    {...node, ...(type === 'Product' ? {sku:'OTHER'} : {'@id':'OTHER'})});
  assert.throws(() => h.bravissimoProduct(f.product, stale, f.canonical, f.canonical, f.color, 'USD'), /Bravissimo/);
});
test('Bravissimo permits absent JSON-LD with current datalayer and DOM evidence', () => {
  const f = require('./fixtures/bravissimo-fy563.json');
  assert.equal(h.bravissimoProduct(f.product, [], f.canonical, f.canonical, f.color, 'USD').facts.sku, 'FY563BFL');
});

test('Bravissimo binds shared or renamed gallery originals to current product images, not style filename', () => {
  const f = require('./fixtures/bravissimo-fy563.json');
  const shared = 'https://images.ctfassets.net/bz0fvtkbk5r1/shared/lifestyle.jpg';
  const product = {...f.product, images: [{zoom: shared}]};
  assert.deepEqual(h.bravissimoProduct(product, f.jsonld, f.canonical, f.canonical, f.color, 'USD').images, [shared]);
  for (const zoom of [shared.replace('images.ctfassets.net','evil.test'), shared.replace('/bz0fvtkbk5r1/','/other/'),
    shared.replace('https:','http:'), shared.replace('https://','https://user:secret@')])
    assert.throws(() => h.bravissimoProduct({...product, images:[{zoom}]}, f.jsonld, f.canonical, f.canonical, f.color, 'USD'),
      error => error.code === 'PRODUCT_EVIDENCE_INVALID' && /gallery/.test(error.message));
});

test('Bravissimo failures identify the invalid field without raw URL values', () => {
  const f = require('./fixtures/bravissimo-fy563.json');
  for (const [patch, reason] of [[{brand:''}, /missing brand/], [{styleCode:''}, /missing styleCode/],
    [{styleColourCode:''}, /missing styleColourCode/], [{colour:{}}, /rendered colour mismatch/],
    [{prices:null}, /prices.price/], [{images:null}, /images/], [{images:[{zoom:'http://['}]}, /images\[0\].zoom/]])
    assert.throws(() => h.bravissimoProduct({...f.product,...patch}, f.jsonld, f.canonical, f.canonical, f.color, 'USD'),
      error => error.code === 'PRODUCT_EVIDENCE_INVALID' && reason.test(error.message));
});

for (const row of require('./fixtures/bravissimo-name-expected.json')) {
  test(`Bravissimo ${row.code} trims archived trailing name whitespace for receiver facts`, () => {
    const f = require(`./fixtures/bravissimo-${row.code}.json`);
    assert.equal(f.product.styleName, row.name + ' ');
    const result = h.bravissimoProduct(f.product, f.jsonld, f.canonical, f.canonical, f.color, 'USD');
    assert.equal(result.facts.name, row.name);
    assert.equal(result.microdata.name, row.name);
    assert.equal(result.facts.product_id, row.product_id);
    assert.equal(result.microdata.brand, f.product.brand);
    assert.deepEqual(result.images, row.images);
  });
}
