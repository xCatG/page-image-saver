"""Owner-saved DOM regressions. All browser requests fulfilled locally; no network."""
import json
import os
import tempfile
import unittest
from pathlib import Path
import saved_page_fixtures as harness
from saved_page_fixtures import source, FIXTURES

ROWS = json.loads((FIXTURES / 'bravissimo-expected.json').read_text())
CONFIG = json.loads(source('site_config/www.bravissimo.com.json'))

class BravissimoBrowser(unittest.TestCase):
    setUpClass = classmethod(harness.SavedPageFixtures.setUpClass.__func__)
    tearDownClass = classmethod(harness.SavedPageFixtures.tearDownClass.__func__)
    open_fixture = harness.SavedPageFixtures.open_fixture

    def open(self,row):
        page=self.open_fixture(CONFIG['domain'],row['fixture'])
        page.evaluate('url => history.replaceState({}, "", url)',row['url'])
        content=source('content_script.js')
        page.add_script_tag(content='const takeoverDocumentId="fixture"; function rescanCaptureImages() {}'+content[content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')])
        return page

    def test_saved_products(self):
        for row in ROWS:
            if 'product_id' not in row: continue
            page=self.open(row)
            try:
                self.assertEqual(page.evaluate('capturePageProduct()'),dict(name=row['name'],sku=row['sku'],product_id=row['product_id'],color=row['color'],offers=dict(price=row['price'],currency='USD')))
                self.assertEqual(page.evaluate("c => captureGallery(c,'site')",CONFIG),row['images'])
                result=page.evaluate('c => inspectTakeoverPage(c)',CONFIG)
                self.assertEqual(result['imageCount'],len(row['images']))
                self.assertEqual(result['product']['category'],row['type'])
            finally:page.close()

    def test_saved_listings(self):
        for row in ROWS:
            if 'products' not in row: continue
            page=self.open(row)
            try:
                result=page.evaluate("c => inspectTakeoverPage(c,'discovery')",CONFIG)
                self.assertEqual(result['products'],row['products'])
                self.assertEqual(result['next'],row['next'])
                self.assertEqual(result['end'],dict(type='result-total',total=row['total']))
            finally:page.close()

    def test_real_export_three_smoke_candidates(self):
        handles=['fy563','pn305','lg402']
        for handle in handles:
            row=next(r for r in ROWS if r.get('code') == handle); page=self.open(row)
            try:
                content=source('content_script.js')
                page.add_script_tag(content=source('takeover_runner.js'))
                page.add_script_tag(content=content[content.index('function captureSwatchColor()'):content.index('function captureCanonicalUrl(')]+content[content.index('function capturePageHtml()'):content.index('async function recordCaptureFailure(')]+content[content.index('async function captureCurrentProduct('):content.index('function takeoverRequest(')])
                result=page.evaluate("""async config => {
                  globalThis.previousCaptureStates=new Map(); globalThis.loadCaptureSiteConfig=async()=>config;
                  globalThis.assertTakeoverBinding=()=>{}; const files={};
                  globalThis.chrome={runtime:{sendMessage:async(message,reply)=>{
                    const completion=await PageImageSaverHelpers.exportProductCapture(message.payload,{
                      attemptId:'0123456789abcdef',
                      fetchImage:async()=>({bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),contentType:'image/png'}),
                      saveBytes:async(path,bytes)=>{files[path]=Array.from(bytes);}});
                    reply({success:true,storage:'downloads',completion});}}};
                  const inspected=await inspectTakeoverPage(config);
                  const scope=PageImageSaverTakeover.classifyTakeoverScope(inspected.product,config);
                  if(scope.decision!=='include') throw new Error('Smoke product scope must include');
                  let saved=null, result, testClock=100000;
                  const runner=PageImageSaverTakeover.createTakeoverRunner({
                    now:()=>testClock, random:()=>0.5, read:async()=>structuredClone(saved),
                    save:async run=>{saved=structuredClone(run);},alarm:async()=>{},notify:async()=>{},
                    verify:async()=>({storage:'receiver',status:'missing'}),
                    load:async()=>({...await inspectTakeoverPage(config),tabId:7}),
                    capture:async(url,actualScope,binding)=>{
                      result=await captureCurrentProduct({manual:false,binding,scopeOverride:{...actualScope,
                        reason:actualScope.reason+'; Offline Bravissimo fixture; synthetic PNG image bytes fulfilled locally'}});
                      return result;
                    }});
                  await runner.importDiscovery(config,[{sha256:'a'.repeat(64),report:{format:'page-image-saver-discovery/v1',
                    schema_version:1,mode:'discovery',site:config.domain,started_utc:'2026-10-14T00:00:00Z',
                    listings:[{url:'https://www.bravissimo.com/us/collections/all-bras/',
                      final_url:'https://www.bravissimo.com/us/collections/all-bras/',
                      products:[{url:window.location.href,card_text:'Offline public fixture'}],
                      next_url:null,end_check:{observed:null,passed:false}}]}}]);
                  await runner.start();await runner.tick();testClock+=12000;await runner.tick();
                  if(saved.status!=='finished_with_gaps' || saved.products[0].reason!=='exported_unverified')
                    throw new Error('Downloads queue must finish with unverified export, not pause: '+saved.status+' '+saved.reason);
                  return {files,completion:result.completion}; }""",CONFIG)
                self.assertEqual(result['completion']['identity']['selected_color'],row['color'])
                self.assertEqual(result['completion']['identity']['color_key'],'color')
                self.assertEqual(result['completion']['product']['product_id'],row['product_id'])
                product=next(data for name,data in result['files'].items() if name.endswith('/product.json'))
                self.assertLess(len(product),512*1024)
                with tempfile.TemporaryDirectory() as tmp:
                    root=Path(os.environ.get('PIS_BRAVISSIMO_EXPORT',tmp))
                    for name,data in result['files'].items():
                        target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bytes(data))
            finally:page.close()

if __name__=='__main__': unittest.main()
