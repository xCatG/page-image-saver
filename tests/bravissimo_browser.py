"""Owner-saved DOM regressions. All browser requests fulfilled locally; no network."""
import json
import os
import tempfile
import unittest
from pathlib import Path
import saved_page_fixtures as harness
from saved_page_fixtures import source, FIXTURES

ROWS = (json.loads((FIXTURES / 'bravissimo-expected.json').read_text()) +
        json.loads((FIXTURES / 'bravissimo-name-expected.json').read_text()))
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

    def test_shared_gallery_filename_still_requires_current_product_membership(self):
        row=next(r for r in ROWS if r.get('code') == 'fy563')
        page=self.open(row)
        shared='https://images.ctfassets.net/bz0fvtkbk5r1/shared/lifestyle.jpg'
        try:
            page.evaluate("""shared => {
              const script=Array.from(document.scripts).find(node=>node.textContent.includes('setDataLayer('));
              const match=script.textContent.match(/setDataLayer\((\{.*?\})\);/s);
              const value=JSON.parse(match[1]); value.product.images=[{zoom:shared}];
              script.textContent=script.textContent.replace(match[1],JSON.stringify(value));
              const sources=Array.from(document.querySelectorAll('#product-gallery .c-product-gallery__carousel--feature picture source'));
              sources.forEach(node=>node.setAttribute('srcset',shared));
            }""",shared)
            self.assertEqual(page.evaluate("c => captureGallery(c,'site')",CONFIG),[shared])
            page.evaluate("""() => {
              document.querySelectorAll('#product-gallery .c-product-gallery__carousel--feature picture source')
                .forEach(node=>node.setAttribute('srcset','https://images.ctfassets.net/bz0fvtkbk5r1/other/not-current.jpg'));
            }""")
            with self.assertRaisesRegex(Exception,'current gallery not bound'):
                page.evaluate("c => captureGallery(c,'site')",CONFIG)
        finally: page.close()

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

    def test_production_seed_discovery_completes_with_saved_terminal_grid(self):
        row=next(r for r in ROWS if r['fixture']=='bravissimo-all-bras-200.html')
        page=self.open(row)
        try:
            page.add_script_tag(content=source('takeover_runner.js'))
            result=page.evaluate("""async config => {
              let saved=null, clock=100000;
              const runner=PageImageSaverTakeover.createTakeoverRunner({now:()=>clock,random:()=>0.5,
                read:async()=>structuredClone(saved),save:async run=>{saved=structuredClone(run);},
                alarm:async()=>{},notify:async()=>{},load:async()=>inspectTakeoverPage(config,'discovery')});
              await runner.importDiscovery(config,[{sha256:'a'.repeat(64),report:{
                format:'page-image-saver-listing-seeds/v1',schema_version:1,site:config.domain,
                seeds:[window.location.href]}}]);
              await runner.start(); await runner.tick(); clock+=12000; await runner.tick();
              return saved;
            }""",CONFIG)
            self.assertEqual(result['status'],'complete')
            self.assertTrue(result['listings']['discoveryComplete'])
            self.assertEqual(len(result['listings']['visited'][0]['products']),129)
        finally: page.close()

    def test_real_export_smoke_and_name_regressions(self):
        handles=['fy563','pn305','lg402','ck202','fa358','yb116']
        for handle in handles:
            row=next(r for r in ROWS if r.get('code') == handle); page=self.open(row)
            try:
                content=source('content_script.js')
                page.add_script_tag(content=source('takeover_runner.js'))
                page.add_script_tag(content=content[content.index('function captureSwatchColor()'):content.index('function captureCanonicalUrl(')]+content[content.index('function captureCanonicalUrl('):content.index('async function recordCaptureFailure(')]+content[content.index('function takeoverUnavailableChoice('):content.index('function rescanCaptureImages(')]+content[content.index('async function captureCurrentProduct('):content.index('function takeoverRequest(')])
                background=source('background.js')
                page.evaluate("""() => {
                  globalThis.captureListeners=[];
                  globalThis.chrome={runtime:{onMessage:{addListener:fn=>captureListeners.push(fn)}}};
                }""")
                page.add_script_tag(content=
                    background[background.index('function chromeCallback('):background.index('async function takeoverTabComplete(')]+
                    background[background.index('function takeoverSameUrl('):background.index('async function assertAutoCaptureAllowed(')]+
                    background[background.index('chrome.runtime.onMessage.addListener(',background.index('// Product capture is always local.')):background.index('/*\n  The product capture path')])
                result=page.evaluate("""async config => {
                  globalThis.previousCaptureStates=new Map(); globalThis.loadCaptureSiteConfig=async()=>config;
                  const files={};
                  globalThis.CONFIG={receiver:{enabled:false}};
                  globalThis.requireSettingsReady=async()=>{};
                  globalThis.fetch=async url=>({ok:true,url,headers:{get:()=> 'image/png'},
                    arrayBuffer:async()=>Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0)).buffer});
                  globalThis.blobToDataUrl=blob=>new Promise(resolve=>{
                    const reader=new FileReader(); reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
                  PageImageSaverHelpers.saveCaptureDownload=async(_chrome,data,path)=>{
                    files[path]=Array.from(Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0)));};
                  chrome.storage={local:{get:(_key,reply)=>reply({catalogTakeoverTabId:7})}};
                  chrome.tabs={get:(_id,reply)=>reply({id:7,url:window.location.href})};
                  chrome.runtime.sendMessage=(message,reply)=>{
                    for(const listener of captureListeners)
                      if(listener(message,{tab:{id:7,url:window.location.href},url:window.location.href},reply)) return;
                    throw new Error('No background capture handler');};
                  const inspected=await inspectTakeoverPage(config);
                  const scope=PageImageSaverTakeover.classifyTakeoverScope(inspected.product,config);
                  if(scope.decision==='exclude') throw new Error('Fixture product scope must permit capture');
                  let saved=null, result, testClock=100000;
                  globalThis.takeoverIo={read:async()=>structuredClone(saved)};
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
                    throw new Error('Downloads queue must finish with unverified export, not pause: '+saved.status+' '+saved.reason+' '+JSON.stringify(saved.products));
                  return {files,completion:result.record}; }""",CONFIG)
                self.assertEqual(result['completion']['identity']['selected_color'],row['color'])
                self.assertEqual(result['completion']['identity']['color_key'],'color')
                self.assertEqual(result['completion']['product']['product_id'],row['product_id'])
                product=next(data for name,data in result['files'].items() if name.endswith('/product.json'))
                self.assertLess(len(product),512*1024)
                # The receiver uses this exact invariant: microdata is trimmed, claimed facts must agree.
                from lingerie_trends.gold_set import _check_product_envelope
                envelope=json.loads(bytes(product))
                _check_product_envelope(envelope,result['completion']['product'])
                self.assertEqual(result['completion']['product']['name'],row['name'])
                with tempfile.TemporaryDirectory() as tmp:
                    root=Path(os.environ.get('PIS_BRAVISSIMO_EXPORT',tmp))
                    for name,data in result['files'].items():
                        target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bytes(data))
                    from lingerie_trends.gold_set import _validate_capture_record
                    capture_root=root/'PageImageSaver'
                    completion=next(root/name for name in result['files'] if name.endswith('/complete.json'))
                    _validate_capture_record(completion,capture_root,result['completion'])
            finally:page.close()

if __name__=='__main__': unittest.main()
