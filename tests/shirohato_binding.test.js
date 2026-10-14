const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('../extension_helpers');
const evidence = require('./fixtures/shirohato-expected.json');
const product = evidence.find(r => r.product_id === '40btj448df');
const listingUrl = evidence.find(r => r.fixture === 'shirohato-listing-bra.html').products.find(u => u.includes('/40btj448df/'));
const source = fs.readFileSync(require.resolve('../content_script.js'), 'utf8');
function boundPage(queued, canonical=product.url) {
 const state = {payload:null};
 const sandbox = {URL,Map,Date,window:{location:{href:queued,hostname:'www.wakudoki.ne.jp'}},
  document:{querySelector:()=>({href:canonical})}, takeoverDocumentId:'doc',
  loadCaptureSiteConfig:async()=>({colorVariantStrategy:'separate-url'}),
  capturePageProduct:()=>({name:product.name}),captureGallery:()=>product.images,
  captureSwatchColor:()=>null,captureSelectedColor:()=>null,previousCaptureStates:new Map(),
  capturePageProductEvidence:()=>({facts:{name:product.name}}),
  PageImageSaverHelpers:{...helpers,waitForCaptureState:async read=>read()},
  chrome:{runtime:{sendMessage:(message,reply)=>{state.payload=message.payload;reply({success:true});}}}};
 sandbox.globalThis=sandbox;
 vm.runInNewContext(source.slice(source.indexOf('function captureCanonicalUrl('),source.indexOf('function takeoverRequest(')),sandbox);
 sandbox.capturePageHtml=()=>'<html></html>';
 return {sandbox,state,binding:{documentId:'doc',documentUrl:queued,expectedUrl:queued}};
}
test('saved Shirohato listing bid link becomes bound canonical capture identity', async()=>{
 assert.equal(listingUrl,product.url+'?bid=3');
 const queued=helpers.shirohatoListingUrl(listingUrl);
 assert.equal(queued,product.url);
 const {sandbox,state,binding}=boundPage(queued);
 const result=await sandbox.captureCurrentProduct({manual:false,binding});
 assert.equal(result.identity.product_url,product.url);
 assert.equal(state.payload.identity.product_url,product.url);
});
test('Shirohato listing normalization does not erase unknown or variant queries',async()=>{
 for(const query of ['?vname1=BLUE','?bid=3&choice=BLUE','?bid=3&bid=4','?bid=other']) {
  const url=product.url+query;
  assert.equal(helpers.shirohatoListingUrl(url),url);
  const {sandbox,state,binding}=boundPage(url);
  await assert.rejects(sandbox.captureCurrentProduct({manual:false,binding}),/canonical/);
  assert.equal(state.payload,null);
 }
});
test('normalized Shirohato queues still reject changed product, host, document and location',()=>{
 const queued=helpers.shirohatoListingUrl(listingUrl);
 for(const canonical of [product.url.replace('/40btj448df/','/other/'),product.url.replace('www.wakudoki.ne.jp','evil.test')]) {
  const {sandbox,binding}=boundPage(queued,canonical);
  assert.throws(()=>sandbox.assertTakeoverBinding(binding),/canonical/);
 }
 const {sandbox,binding}=boundPage(queued);
 assert.throws(()=>sandbox.assertTakeoverBinding({...binding,documentId:'old'}),/document id/);
 sandbox.window.location.href=queued+'?bid=3';
 assert.throws(()=>sandbox.assertTakeoverBinding(binding),/location/);
 for(const url of [listingUrl.replace('www.wakudoki.ne.jp','evil.test'),listingUrl.replace('/1/','/2/')])
  assert.equal(helpers.shirohatoListingUrl(url),url);
});
