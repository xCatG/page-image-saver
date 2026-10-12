const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const h = require('../extension_helpers.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
function filenames() {
  const scope = {URL, CONFIG: {preserveFilenames:true}, debugLog() {}};
  vm.runInNewContext(source.slice(source.indexOf('function getFilename('), source.indexOf('// Convert a Blob')), scope);
  return scope;
}
test('manual AP filename follows PNG bytes while preserving the original basename', () => {
  const f=filenames();
  assert.equal(f.getFilename('https://www.agentprovocateur.com/tco-images/unsafe/1730x2206/format(png)/https://www.agentprovocateur.com/static/media/catalog/product/a/p/ap12654600600_ecom_01.jpg', 'image/png'), 'ap12654600600_ecom_01.png');
  assert.equal(f.getFilename('https://shop.test/photo.png','image/jpeg; charset=binary'), 'photo.jpg');
  assert.equal(f.getFilename('https://shop.test/photo.webp','application/octet-stream'), 'photo.webp');
});
test('manual AP candidates keep the largest evidenced rendition per original', () => {
  const original='https://www.agentprovocateur.com/static/media/catalog/product/a/p/photo.jpg';
  const proxy=size=>'https://www.agentprovocateur.com/tco-images/unsafe/'+size+'/filters:format(png)/'+original;
  const images=[{url:proxy('0x0')},{url:proxy('400x500'),width:400,height:500},
    {url:proxy('1730x2206'),width:1730,height:2206},{url:original},
    {url:original.replace('photo.jpg','other.jpg')}, {url:'https://foreign.test/photo.jpg'}];
  const selected=h.dedupeManualImages(images,'https://www.agentprovocateur.com/us_en/bra');
  assert.deepEqual(selected.map(x=>x.url),[proxy('1730x2206'),original.replace('photo.jpg','other.jpg'),'https://foreign.test/photo.jpg']);
  assert.equal(h.dedupeManualImages(images,'https://other.test/').length,images.length);
});
test('manual downloads overwrite repeat names and still reject wrong basename or folder',async()=>{
  for(const actual of ['PageImageSaver/photo.png','PageImageSaver/other.png','Elsewhere/photo.png']) {
    let listener,request;
    const chrome={runtime:{lastError:null},downloads:{
      onChanged:{addListener(fn){listener=fn;},removeListener(){}},
      download(options,cb){request=options;cb(5);queueMicrotask(()=>listener({id:5,state:{current:'complete'}}));},
      search(_q,cb){cb([{filename:'C:/Users/fixture/Downloads/'+actual}]);}}};
    const scope={chrome,CONFIG:{local:{baseFolder:'PageImageSaver'}},PageImageSaverHelpers:h,
      blobToDataUrl:async()=> 'data:image/png;base64,YQ=='};
    vm.runInNewContext(source.slice(source.indexOf('async function saveToDownloads('),source.indexOf('// Build the full storage path')),scope);
    const pending=scope.saveToDownloads(new Blob(['a'],{type:'image/png'}),'photo.png','');
    if(actual==='PageImageSaver/photo.png') assert.equal((await pending).fullPath,actual);
    else await assert.rejects(pending,/filename mismatch/);
    assert.equal(request.conflictAction,'overwrite');
  }
});

test('manual batch processes one AP rendition, not both proxies', async()=>{
  const original='https://www.agentprovocateur.com/static/media/catalog/product/a/p/photo.jpg';
  const small='https://www.agentprovocateur.com/tco-images/unsafe/0x0/'+original;
  const large='https://www.agentprovocateur.com/tco-images/unsafe/1730x2206/'+original;
  const processed=[];
  const scope={CONFIG:{maxConcurrentUploads:5},console:{log(){},error(){}},PageImageSaverHelpers:h,
    processImage:async image=>{processed.push(image.url);return {success:true};}};
  vm.runInNewContext(source.slice(source.indexOf('async function processImagesInBatches('),source.indexOf('// Process a single image')),scope);
  await scope.processImagesInBatches([{url:small},{url:large}],{url:'https://www.agentprovocateur.com/us_en/bra'},null);
  assert.deepEqual(processed,[large]);
});
test('unsupported manual candidate cannot abort otherwise valid AP saves',()=>{
  const images=[{url:'https://[invalid'},{url:'https://www.agentprovocateur.com/static/media/catalog/product/a/p/valid.jpg'}];
  assert.deepEqual(h.dedupeManualImages(images,'https://www.agentprovocateur.com/us_en/bra'),images);
});
test('unloaded AP thumbnail layout size does not beat its explicit proxy resolution',()=>{
  const original='https://www.agentprovocateur.com/static/media/catalog/product/a/p/photo.jpg';
  const small={url:'https://www.agentprovocateur.com/tco-images/unsafe/400x500/'+original,width:400,height:500,isLoaded:true};
  const large={url:'https://www.agentprovocateur.com/tco-images/unsafe/1730x2206/'+original,width:100,height:128,isLoaded:false};
  assert.deepEqual(h.dedupeManualImages([small,large],'https://www.agentprovocateur.com/us_en/bra'),[large]);
});
