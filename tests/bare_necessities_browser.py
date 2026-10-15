"""Owner-saved DOM regressions. All browser requests fulfilled locally; no network."""
import json
import os
import tempfile
import unittest
from pathlib import Path
import saved_page_fixtures as harness
from saved_page_fixtures import source, FIXTURES

ROWS = json.loads((FIXTURES / 'bare-necessities-expected.json').read_text())
CONFIG = json.loads(source('site_config/www.barenecessities.com.json'))

class BareNecessitiesBrowser(unittest.TestCase):
    setUpClass = classmethod(harness.SavedPageFixtures.setUpClass.__func__)
    tearDownClass = classmethod(harness.SavedPageFixtures.tearDownClass.__func__)
    open_fixture = harness.SavedPageFixtures.open_fixture

    def open(self,row):
        page=self.open_fixture(CONFIG['domain'],row['fixture'])
        page.evaluate('url => history.replaceState({}, "", url)',row['url'])
        content=source('content_script.js')
        page.add_script_tag(content='const takeoverDocumentId="fixture"; function rescanCaptureImages() {}'+content[content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')])
        return page

    def test_all_ten_saved_products_bind_identity_and_current_gallery(self):
        for row in ROWS:
            if 'product_id' not in row: continue
            with self.subTest(product=row['product_id']):
                page=self.open(row)
                try:
                    self.assertEqual(page.evaluate('capturePageProduct()'),dict(name=row['name'],sku=None,product_id=row['product_id'],color=None,offers=dict(price=row['price'],currency='USD')))
                    self.assertEqual(page.evaluate("c => captureGallery(c,'site')",CONFIG),row['images'])
                    result=page.evaluate('c => inspectTakeoverPage(c)',CONFIG)
                    self.assertEqual(result['colorLinks'],[])
                    self.assertEqual(result['imageCount'],len(row['images']))
                    self.assertEqual(result['product']['category'],row['type'])
                    page.evaluate("document.querySelector('link[rel=canonical]').href='https://evil.test/products/other'")
                    with self.assertRaisesRegex(Exception,'Bare Necessities product'):
                        page.evaluate('capturePageProduct()')
                finally: page.close()

    def test_four_saved_listings_and_positive_end(self):
        for row in ROWS:
            if 'products' not in row: continue
            page=self.open(row)
            try:
                result=page.evaluate("c => inspectTakeoverPage(c,'discovery')",CONFIG)
                self.assertEqual(result['products'],[u.split('?')[0] for u in row['products']])
                self.assertEqual(result['next'],row['next'])
                self.assertEqual(result['end'],dict(type='result-total',total=row['total']))
                # Synthetic final state: observed numbered controls plus disabled Next must reconcile.
                page.evaluate("last => {document.querySelector('.br-pagination__item--current').textContent=String(last); document.querySelector('.br-pagination__item--next').disabled=true; history.replaceState({},'', '?page='+last)}",17 if row['total']==580 else 2)
                final=page.evaluate("c => inspectTakeoverPage(c,'discovery')",CONFIG)
                self.assertIsNone(final['next'])
                self.assertEqual(final['end'],result['end'])
            finally:page.close()

    def test_blocked_insider_grid_has_specific_diagnostic(self):
        page=self.open(ROWS[0])
        try:
            page.evaluate("document.querySelectorAll('.br-collection .br-product-tile').forEach(n=>n.remove())")
            with self.assertRaisesRegex(Exception,'product grid not rendered — Insider search blocked\\?'):
                page.evaluate("c => inspectTakeoverPage(c,'discovery')",CONFIG)
        finally:page.close()

    def test_real_export_three_smoke_candidates(self):
        handles=['prima-donna-deauville-side-support-bra-016-1811','wacoal-b-smooth-full-brief-838175','freya-facinate-suspender-aa403191']
        for handle in handles:
            row=next(r for r in ROWS if r['url'].endswith('/'+handle)); page=self.open(row)
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
                  const result=await captureCurrentProduct({manual:false,scopeOverride:{...scope,reason:scope.reason+'; Offline BN fixture; synthetic image bytes'}});
                  return {files,completion:result.completion}; }""",CONFIG)
                self.assertEqual(result['completion']['identity']['selected_color'],None)
                self.assertEqual(result['completion']['product']['product_id'],row['product_id'])
                product=next(data for name,data in result['files'].items() if name.endswith('/product.json'))
                self.assertLess(len(product),512*1024)
                with tempfile.TemporaryDirectory() as tmp:
                    root=Path(os.environ.get('PIS_BN_EXPORT',tmp))
                    for name,data in result['files'].items():
                        target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bytes(data))
            finally:page.close()

if __name__=='__main__': unittest.main()
