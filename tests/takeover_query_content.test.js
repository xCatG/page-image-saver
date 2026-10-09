const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('content capture binds the query-added document but publishes the queued product identity',async()=>{
  const queued='https://shop.example.test/product';
  const visited=queued+'?size=OS';
  let payload;
  const sandbox={URL,Map,Date,window:{location:{href:visited}},takeoverDocumentId:'doc',
    captureCanonicalUrl:()=>visited, loadCaptureSiteConfig:async()=>({colorVariantStrategy:'separate-url'}),
    capturePageProduct:()=>({name:'Brief'}),captureGallery:()=>['https://shop.example.test/image.jpg'],
    captureSwatchColor:()=>null,captureSelectedColor:()=>null,previousCaptureStates:new Map(),
    capturePageProductEvidence:()=>({facts:{name:'Brief'}}),capturePageHtml:()=>'<html></html>',
    PageImageSaverHelpers:{...require('../extension_helpers.js'),waitForCaptureState:async read=>read()},
    chrome:{runtime:{sendMessage:(message,callback)=>{payload=message.payload;callback({success:true,status:'published'});}}}};
  sandbox.globalThis=sandbox;
  const source=fs.readFileSync(path.join(__dirname,'..','content_script.js'),'utf8');
  vm.runInNewContext(source.slice(source.indexOf('function assertTakeoverBinding('),source.indexOf('function takeoverRequest(')),sandbox);
  const binding={documentId:'doc',expectedUrl:queued,documentUrl:visited};
  const result=await sandbox.captureCurrentProduct({manual:false,binding});
  assert.equal(payload.identity.product_url,queued);
  assert.equal(result.identity.product_url,queued);
  sandbox.window.location.href=queued+'?size=M';
  await assert.rejects(()=>sandbox.captureCurrentProduct({manual:false,binding}),/URL changed/);
});

test('real VS apostrophe URLs bind both spellings, while other documents and paths stay rejected', () => {
  const source=fs.readFileSync(path.join(__dirname,'..','content_script.js'),'utf8');
  const sandbox={URL,window:{location:{}},takeoverDocumentId:'doc',
    PageImageSaverHelpers:require('../extension_helpers.js')};
  sandbox.captureCanonicalUrl=()=>sandbox.window.location.href;
  sandbox.globalThis=sandbox;
  vm.runInNewContext(source.slice(source.indexOf('function assertTakeoverBinding('),source.indexOf('function rescanCaptureImages(')),sandbox);
  for (const queued of require('./fixtures/victoriassecret-apostrophe-urls.json')) {
    const encoded=queued.replaceAll("'",'%27');
    for (const [expected,actual] of [[queued,encoded],[encoded,queued]]) {
      sandbox.window.location.href=actual;
      assert.doesNotThrow(()=>sandbox.assertTakeoverBinding({documentId:'doc',expectedUrl:expected}));
      assert.throws(()=>sandbox.assertTakeoverBinding({documentId:'other-doc',expectedUrl:expected}),/changed/);
      sandbox.window.location.href=actual+'-other';
      assert.throws(()=>sandbox.assertTakeoverBinding({documentId:'doc',expectedUrl:expected}),/changed/);
    }
  }
});
