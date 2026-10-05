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
