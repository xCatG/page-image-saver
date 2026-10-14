"""Offline saved-DOM contract: every request is fulfilled locally, including CDN images."""
import json
import re
import os
from pathlib import Path
import tempfile
import unittest
import saved_page_fixtures as harness
from saved_page_fixtures import source, FIXTURES


class ShirohatoBrowser(unittest.TestCase):
    setUpClass = classmethod(harness.SavedPageFixtures.setUpClass.__func__)
    tearDownClass = classmethod(harness.SavedPageFixtures.tearDownClass.__func__)
    open_fixture = harness.SavedPageFixtures.open_fixture

    def inspect(self, page, config, mode='capture'):
        content = source('content_script.js')
        inspector = content[content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')]
        page.add_script_tag(content='const takeoverDocumentId="fixture"; function rescanCaptureImages() {}' + inspector)
        return page.evaluate('([c,m]) => inspectTakeoverPage(c,m)', [config, mode])

    def test_all_saved_products(self):
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        for row in json.loads((FIXTURES / 'shirohato-expected.json').read_text()):
            if 'product_id' not in row:
                continue
            with self.subTest(product=row['product_id']):
                page = self.open_fixture(config['domain'], row['fixture'])
                try:
                    page.evaluate("url => history.replaceState({}, '', url)", row['url'])
                    evidence = page.evaluate('capturePageProductEvidence()')
                    self.assertEqual(evidence['fact_source'], 'jsonld')
                    self.assertEqual(evidence['facts'], dict(name=row['name'],sku=row['product_id'],product_id=row['product_id'],color=None,offers=dict(price=row['price'],currency='JPY')))
                    self.assertEqual(evidence['jsonld'][0]['brand']['name'], row['brand'])
                    self.assertEqual(evidence['microdata']['colors'], row['colors'])
                    self.assertEqual(evidence['microdata']['size'], row['size'])
                    self.assertEqual(page.evaluate("c => captureGallery(c,'site')", config), row['images'])
                    result = self.inspect(page, config)
                    self.assertEqual(result['kind'], 'product')
                    self.assertEqual(result['product']['category'], row['category'])
                    self.assertEqual(result['colorLinks'], [])
                    self.assertEqual(result['imageCount'], len(row['images']))
                    page.evaluate("document.querySelector('#js-main-slider img').src='https://evil.test/image.jpg'")
                    # The first slide is a duplicated end slide and is deliberately ignored.
                    page.evaluate("document.querySelector('#js-main-slider .swiper-slide:not(.swiper-slide-duplicate) img').src='./saved_files/unproven_LL.jpg'")
                    with self.assertRaisesRegex(Exception, 'Shirohato gallery'):
                        page.evaluate("c => captureGallery(c,'site')", config)
                finally:
                    page.close()

    def test_real_capture_export_contract(self):
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        page = self.open_fixture(config['domain'], 'shirohato-c6510226179ef.html')
        try:
            url = 'https://www.wakudoki.ne.jp/productdetail/c6510226179ef/1/'
            page.evaluate("url => history.replaceState({}, '', url)", url)
            content = source('content_script.js')
            # Execute the real capture path and real export writer; only storage/image IO is local.
            page.add_script_tag(content=content[content.index('function captureSwatchColor()'):content.index('function captureCanonicalUrl(')] +
                content[content.index('function capturePageHtml()'):content.index('async function recordCaptureFailure(')] +
                content[content.index('async function captureCurrentProduct('):content.index('function takeoverRequest(')])
            result = page.evaluate("""async config => {
              globalThis.previousCaptureStates = new Map();
              globalThis.loadCaptureSiteConfig = async () => config;
              globalThis.assertTakeoverBinding = () => {};
              const files = {};
              globalThis.chrome = {runtime: {sendMessage: async (message, reply) => {
                const completion = await PageImageSaverHelpers.exportProductCapture(message.payload, {
                  attemptId: '0123456789abcdef',
                  fetchImage: async () => ({bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII='), c=>c.charCodeAt(0)), contentType:'image/png'}),
                  saveBytes: async (path, bytes) => {files[path] = Array.from(bytes);}
                });
                reply({success:true,storage:'downloads',completion});
              }}};
              const result = await captureCurrentProduct({manual:false,scopeOverride:{decision:'include',reason:'Offline JP bra fixture'}});
              return {files, completion:result.completion};
            }""", config)
            self.assertEqual(set(result['completion']['product']), {'name','sku','product_id','color','offers'})
            self.assertEqual(result['completion']['identity']['selected_color'], None)
            self.assertEqual(len(result['completion']['evidence']['images']), 14)
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(os.environ.get('PIS_SHIROHATO_EXPORT', tmp))
                for name, data in result['files'].items():
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(bytes(data))
        finally:
            page.close()

    def test_saved_listing_cards_next_and_displayed_totals(self):
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        for row in json.loads((FIXTURES / 'shirohato-expected.json').read_text()):
            if 'products' not in row:
                continue
            with self.subTest(listing=row['fixture']):
                page = self.open_fixture(config['domain'], row['fixture'])
                try:
                    page.evaluate("url => history.replaceState({}, '', url)", row['url'])
                    result = self.inspect(page, config, 'discovery')
                    self.assertEqual(result['kind'], 'listing')
                    # Numeric bid is the sole query in these independently saved listing links.
                    expected = [re.sub(r'\?bid=[0-9]+$', '', url) for url in row['products']]
                    self.assertEqual(result['products'], expected)
                    self.assertEqual([card['url'] for card in result['cards']], expected)
                    self.assertEqual(len(result['products']), 60)
                    self.assertEqual(result['next'], row['next'])
                    self.assertEqual(result['end'], dict(type='result-total',total=row['total']))
                finally:
                    page.close()


if __name__ == '__main__':
    unittest.main()
