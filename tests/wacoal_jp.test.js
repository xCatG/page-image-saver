const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const h = require('../extension_helpers');
const {classifyTakeoverScope,endCheckPasses} = require('../takeover_runner');
const rows = require('./fixtures/wacoal-jp-expected.json');
const config = require('../site_config/store.wacoal.jp.json');
const decode = s => s.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
function fixture(row) {
 const html=fs.readFileSync(`${__dirname}/fixtures/${row.fixture}`,'utf8');
 return {html, name:decode(html.match(/property="og:title" content="([^"]*)"/)[1]),
   brand:decode(html.match(/class="rn-products-name__brand">([^<]*)/)[1]),
   price:html.match(/id="slct-price">¥ (\d+)/)[1]};
}
for(const row of rows) test(`Wacoal JP ${row.fixture} binds saved brand, title and JPY`,()=>{
 const data=fixture(row), facts=h.wacoalJpProduct(data,row.url,row.url);
 assert.equal(facts.product_id,row.product_id);assert.equal(facts.color,null);
 assert.equal(facts.offers.currency,'JPY');assert.equal(data.brand,row.brand);
 assert.equal(data.price,row.price);assert.equal(data.name,row.name);
 assert.equal(h.wacoalJpGallery([row.og_image],row.product_id)[0].url,row.og_image);
 assert.equal(classifyTakeoverScope(facts,config).decision,row.product_id==='UDW420'?'exclude':'include');
});
test('all five carried brands have offline evidence',()=>assert.equal(new Set(rows.map(r=>r.brand)).size,5));
test('BTJ748 picking BE changes neither style capture nor gallery filenames',()=>{
 const [a,b]=rows.filter(r=>r.product_id==='BTJ748');
 assert.deepEqual(h.wacoalJpProduct(fixture(a),a.url,a.url),h.wacoalJpProduct(fixture(b),b.url,b.url));
 assert.deepEqual(a.gallery.map(u=>u.split('/').pop()),b.gallery.map(u=>u.split('/').pop()));
});
test('synthetic remote-gallery contracts reject recommendations, CHIP, JYO and local paths',()=>{
 const base=rows.find(r=>r.product_id==='BTJ748').og_image.split('/BTJ748BU_')[0]+'/';
 const urls=['BTJ748BU_ITM_B1.jpg?sw=1200','BTJ748BE_BAK_B1.jpg?sw=532','BTJ748BU_DET_B1_21.jpg?sw=532','BTJ748BU_REF_B1_21.jpg?sw=532','BTJ748BU_MOD_B1.jpg?sw=532'].map(f=>base+f);
 const result=h.wacoalJpGallery([...urls,urls[0].replace('1200','48'),base+'BTJ748BU_CHIP.jpg',base+'BTJ748DA_JYO_B1_01.jpg',rows.find(r=>r.product_id==='BXB412').og_image,'./BTJ748_files/BTJ748BU_ITM_B1.jpg'], 'BTJ748');
 assert.deepEqual(result.map(x=>x.url),urls);
 assert.deepEqual(result.map(x=>[x.color_code,x.shot_code]),[['BU','ITM'],['BE','BAK'],['BU','DET'],['BU','REF'],['BU','MOD']]);
 for(const bad of [urls[0].replace('store.wacoal.jp','evil.test'),urls[0].replace('BTJ748/','OTHER1/'),urls[0]+'&tracking=1'])assert.throws(()=>h.wacoalJpGallery([bad],'BTJ748'));
 assert.throws(()=>h.wacoalJpGallery(['./saved.jpg'],'BTJ748'));
});
test('saved listing discovers 40 canonical products and reads onclick start=40 without evaluation',()=>{
 const html=fs.readFileSync(`${__dirname}/fixtures/wacoal-jp-listing.html`,'utf8');
 const links=[...html.matchAll(/class="group" href="([^"]+)"/g)].map(m=>h.wacoalJpUrl(decode(m[1])));
 assert.equal(links.length,40);assert.equal(new Set(links).size,40);assert(links.every(u=>!u.includes('?')));
 const onclick=decode(html.match(/onclick="([^"]+)"/)[1]);
 assert.equal(h.wacoalJpNext(onclick,'https://store.wacoal.jp/disp/001300300110/'),'https://store.wacoal.jp/disp/001300300110/?start=40');
 for(const bad of [onclick.replace('start=40','start=80'),onclick.replace('store.wacoal.jp','evil.test'),onclick.replace('start=40','start=40&cgid=x'),'alert(1)'])assert.throws(()=>h.wacoalJpNext(bad,'https://store.wacoal.jp/disp/001300300110/'));
 assert.equal(h.wacoalJpNext(null,'https://store.wacoal.jp/disp/001300300110/?start=760'),null);
 assert.equal(endCheckPasses(config,{end:{type:'result-total',total:768}},[{end:{type:'result-total',total:768}}],40),false);
});
test('identity and scope guards fail closed',()=>{
 const row=rows[0], data=fixture(row);
 for(const changed of [{...data,name:'other'}, {...data,price:'-1'}, {...data,brand:''}])assert.throws(()=>h.wacoalJpProduct(changed,row.url,row.url));
 assert.throws(()=>h.wacoalJpProduct(data,row.url,row.url.replace('BTJ748','BXB412')));
 for(const name of ['メンズ ブラ','水着 ブラ','ソックス','パジャマ ランジェリー'])assert.equal(classifyTakeoverScope({name},config).decision,'exclude');
 const source=fs.readFileSync(require.resolve('../content_script.js'),'utf8');
 const sandbox={window:{location:{hostname:'store.wacoal.jp'}},document:{querySelector:()=>({getAttribute:()=> 'BE'}),getElementById:()=>({value:'Blue'})}};
 vm.runInNewContext(source.slice(source.indexOf('function captureSwatchColor('),source.indexOf('function captureCanonicalUrl(')),sandbox);
 assert.equal(sandbox.captureSelectedColor({color:null},config),null);
});

test('content adapter extracts bound microdata from the trimmed PDP fields',()=>{
 const row=rows[0],data=fixture(row);
 const nodes={'link[rel="canonical"]':{href:row.url},'meta[property="og:title"]':{content:data.name},
   'p.rn-products-name__brand':{textContent:data.brand},'#slct-price':{textContent:'¥ 13,750 (税込)'}};
 const sandbox={window:{location:{href:row.url}},document:{querySelector:s=>nodes[s],querySelectorAll:()=>[{getAttribute:()=> '48G'}]},PageImageSaverHelpers:h};
 sandbox.globalThis=sandbox;
 const source=fs.readFileSync(require.resolve('../content_script.js'),'utf8');
 sandbox.window.location.pathname=new URL(row.url).pathname;
 vm.runInNewContext(source.slice(source.indexOf('function capturePageProductEvidence('),source.indexOf('function captureProductSeen(')),sandbox);
 const evidence=sandbox.capturePageProductEvidence(config);
 assert.equal(evidence.fact_source,'microdata');assert.equal(evidence.microdata.brand,'サルート');
 assert.equal(evidence.microdata.salute_group,'48G');assert.equal(evidence.facts.product_id,'BTJ748');
 assert.equal(evidence.facts.offers.price,'13750');assert.equal(evidence.facts.offers.currency,'JPY');
});

test('Wacoal adapters are selected by config and preserve gallery evidence guards',()=>{
 const hooks=h.siteHooks[config.product.renditionResolver];
 assert.equal(hooks.listingUrl,h.wacoalJpUrl);
 assert.equal(hooks.next,h.wacoalJpNext);
 assert.equal(hooks.gallery,h.wacoalJpGallery);
 assert.equal(h.listingResultTotal('対象商品数 768 件 (1〜40件表示)',config.listing.endCheck.countPattern),768);
 assert.equal(h.listingResultTotal('表示なし',config.listing.endCheck.countPattern),null);
 assert.equal(h.listingResultTotal('対象商品数 1,2 件',config.listing.endCheck.countPattern),null);
 const row=rows[0], evidence={facts:{product_id:row.product_id},microdata:{}};
 assert.throws(()=>hooks.captureEvidence(evidence,[row.og_image],'color'),/URL identity/);
 hooks.captureEvidence(evidence,[row.og_image],'url');
 assert.deepEqual(evidence.microdata.gallery,h.wacoalJpGallery([row.og_image],row.product_id));
 const source=fs.readFileSync(require.resolve('../content_script.js'),'utf8');
 assert(!source.includes('store.wacoal.jp'));
 assert.equal(classifyTakeoverScope({name:'ブラ'}, {...config,domain:'fixture.example'}).decision,'include');
});

test('content listing inspector applies config URL, next-page and count hooks',async()=>{
 const row=rows[0], card={href:row.url+'?color=BU',textContent:'Saved bra',closest:()=>null,querySelector:()=>null};
 const nodes={
   [config.listing.pagination.nextSelector]:{getAttribute:()=>"location.href='https://store.wacoal.jp/disp/001300300110/?start=40';"},
   [config.listing.endCheck.selector]:{textContent:'対象商品数 768 件 (1〜40件表示)'}
 };
 const sandbox={URL,Date,window:{location:new URL('https://store.wacoal.jp/disp/001300300110/')},
   document:{title:'Bras',body:{innerText:'Bras'},documentElement:{lang:'ja-JP'},querySelector:s=>nodes[s],querySelectorAll:()=>[card]},
   capturePageProduct:()=>null,captureProductSeen:()=>false,takeoverDocumentId:'fixture',PageImageSaverHelpers:h};
 sandbox.globalThis=sandbox;
 const source=fs.readFileSync(require.resolve('../content_script.js'),'utf8');
 vm.runInNewContext(source.slice(source.indexOf('async function inspectTakeoverPage('),source.indexOf('// A site must be explicitly enabled')),sandbox);
 const result=await sandbox.inspectTakeoverPage({...config,domain:'fixture.example'},'discovery');
 assert.deepEqual(Array.from(result.products),[row.url]);
 assert.equal(result.next,'https://store.wacoal.jp/disp/001300300110/?start=40');
 assert.equal(result.end.total,768);
});
