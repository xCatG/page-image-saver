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

    def test_listing_seed_file_input_uses_discovery_mode(self):
        page = self.browser.new_page()
        page.route('**/*', lambda route: route.fulfill(status=200, body=''))
        page.goto('https://www.wakudoki.ne.jp/')
        content = source('content_script.js')
        start = content.index('<label>Run mode <select id="takeover-mode">')
        end = content.index('<button id="shopify-feed-btn"', start)
        page.set_content(content[start:end] + '<div id="takeover-progress"></div><div id="takeover-feedback"></div>')
        try:
            page.add_script_tag(content=source('extension_helpers.js'))
            page.add_script_tag(content=source('takeover_runner.js'))
            page.evaluate("""config => {
                window.savedRun = null;
                window.runner = PageImageSaverTakeover.createTakeoverRunner({
                    read: async () => structuredClone(window.savedRun),
                    save: async run => {window.savedRun = structuredClone(run);}
                });
                window.loadCaptureSiteConfig = async () => config;
                window.takeoverRequest = async (action, args) => runner.importDiscovery(args.config, args.reuse ? undefined : args.sources);
            }""", json.loads(source('site_config/www.wakudoki.ne.jp.json')))
            wiring = content[content.index("  const takeoverFeedback = container.querySelector"):content.index("  previewButton.addEventListener('click', async () => {", content.index("  const takeoverFeedback = container.querySelector"))]
            page.add_script_tag(content="const container=document; let takeoverRefreshSequence=0; async function refreshTakeoverProgress() {} function showStatusMessage() {}" + wiring)
            report = dict(format='page-image-saver-listing-seeds/v1', schema_version=1,
                          site='www.wakudoki.ne.jp', seeds=['https://www.wakudoki.ne.jp/c/000010001/?dpt=pro&udns=1'])
            page.locator('#takeover-discovery-files').set_input_files(dict(name='seeds.json',mimeType='application/json',buffer=json.dumps(report).encode()))
            page.wait_for_function("window.savedRun?.listingSeeds?.length === 1 && document.querySelector('#takeover-mode').value === 'discovery'")
            self.assertEqual(page.evaluate('savedRun.status'), 'preview')
            self.assertEqual(page.evaluate('savedRun.listings.queue'), [])
            self.assertIn('Listing seeds ready', page.locator('#takeover-feedback').inner_text())
        finally:
            page.close()

    def test_invalid_structured_product_has_specific_classification(self):
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        row = next(r for r in json.loads((FIXTURES / 'shirohato-expected.json').read_text()) if 'product_id' in r)
        page = self.open_fixture(config['domain'], row['fixture'])
        try:
            page.evaluate("url => history.replaceState({}, '', url)", row['url'])
            page.evaluate("""() => {
                const node = document.querySelector('script[type="application/ld+json"]');
                const value = JSON.parse(node.textContent);
                delete value.brand;
                node.textContent = JSON.stringify(value);
            }""")
            content = source('content_script.js')
            inspector = content[content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')]
            page.add_script_tag(content='const takeoverDocumentId="fixture"; function rescanCaptureImages() {}' + inspector)
            result = page.evaluate("""async config => {
                try { await inspectTakeoverPage(config, 'capture', 'product'); }
                catch (error) { return {code:error.code, reason:error.message}; }
            }""", config)
            self.assertEqual(result, dict(code='PRODUCT_EVIDENCE_INVALID', reason='Shirohato product: missing brand'))
            page.evaluate("document.title = 'Captcha challenge'")
            self.assertEqual(page.evaluate("config => inspectTakeoverPage(config, 'capture', 'product')", config)['kind'], 'challenge')
        finally:
            page.close()

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
                    self.assertEqual({k:evidence['microdata'].get(k) for k in ('sku','productID','url')},
                        dict(sku=row['product_id'],productID=row['product_id'],url=row['url']))
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

    def test_readiness_diagnostic_and_read_only_probe(self):
        # Synthetic URL form, NOT a claim about the unknown live DOM.
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        for row in json.loads((FIXTURES / 'shirohato-expected.json').read_text()):
            if row.get('product_id') not in ('c6510226179ef', '40pxb178ml', 'c2226hm038gb'):
                continue
            with self.subTest(product=row['product_id']):
                page = self.open_fixture(config['domain'], row['fixture'])
                try:
                    page.evaluate("url => history.replaceState({}, '', url)", row['url'])
                    page.evaluate("""selector => {
                        const n = document.querySelector(selector);
                        n.setAttribute('src', n.getAttribute('src').replace('https:', '') + '?secret=do-not-print');
                        const original = PageImageSaverHelpers.waitForAutoCaptureReady;
                        PageImageSaverHelpers.waitForAutoCaptureReady = (read, options) => {
                            let now = 0;
                            return original(read, {...options, timeoutMs: 0, now: () => now,
                                delay: async () => {now++;}});
                        };
                    }""", config['product']['allImagesSelector'])
                    before = page.content()
                    report = page.evaluate(source('evidence/owner-probe.js'))
                    self.assertEqual(page.content(), before)
                    self.assertEqual(report['matchingImages'], len(row['images']))
                    self.assertEqual(report['images'][0]['src']['form'], 'protocol-relative')
                    self.assertTrue(report['images'][0]['src']['hasQuery'])
                    self.assertNotIn('do-not-print', json.dumps(report))
                    with self.assertRaisesRegex(Exception, 'gallery readiness timeout: Shirohato gallery: image 1 is not an absolute URL'):
                        self.inspect(page, config)
                finally:
                    page.close()

    def test_owner_probed_subimages_pass_readiness(self):
        config = json.loads(source('site_config/www.wakudoki.ne.jp.json'))
        page = self.open_fixture(config['domain'], 'shirohato-c6510226179ef.html')
        try:
            page.evaluate("history.replaceState({}, '', '/productdetail/c6510226179ef/1/')")
            result = self.inspect(page, config)
            self.assertEqual(result['kind'], 'product')
            self.assertEqual(result['imageCount'], 14)
            gallery = page.evaluate("c => captureGallery(c, 'site')", config)
            self.assertEqual(gallery[3:], [
                f'https://img.wakudoki.ne.jp/Contents/ProductSubImages/0/c6510226179ef_sub{i:02d}_LL.jpg'
                for i in range(1, 12)])
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
            product_file = next(data for name,data in result['files'].items() if name.endswith('/product.json'))
            microdata = json.loads(bytes(product_file))['microdata']
            self.assertEqual({k:microdata.get(k) for k in ('sku','productID','url')},
                dict(sku='c6510226179ef',productID='c6510226179ef',url=url))
            self.assertTrue(microdata['colors'])
            self.assertTrue(microdata['size'])
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
