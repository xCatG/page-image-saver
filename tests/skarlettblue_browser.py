"""Offline production-extractor checks over owner-saved Skarlett Blue DOM."""
import json
import unittest
from urllib.parse import urlsplit
from saved_page_fixtures import SavedPageFixtures, FIXTURES, source


class SkarlettBlueFixtures(SavedPageFixtures):
    def test_skarlettblue_saved_pages(self):
        config = json.loads(source('site_config/www.skarlettblue.com.json'))
        cases = json.loads((FIXTURES / 'skarlettblue-expected.json').read_text())
        listings = []
        self.assertEqual([len(c['images']) for c in cases if not c['listing']], [6, 4, 4, 4, 36, 46, 5])
        for case in cases:
            with self.subTest(source=case['source']):
                page = self.open_fixture(config['domain'], case['fixture'])
                try:
                    if case['listing']:
                        links = page.locator(config['listing']['productLinkSelector']).evaluate_all('(ns) => ns.map(n => n.href)')
                        self.assertEqual(links, case['products'])
                        self.assertEqual(len(links), 50)
                        listings.append(set(links))
                        self.assertEqual(page.locator(config['listing']['pagination']['nextSelector']).get_attribute('href'), case['next'])
                        content = source('content_script.js')
                        page.add_script_tag(content='const takeoverDocumentId="fixture";' + content[
                            content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')])
                        discovered = page.evaluate("c => inspectTakeoverPage(c, 'discovery', 'listing')", config)
                        expected = ['https://www.skarlettblue.com/products/' + urlsplit(u).path.split('/products/')[1] for u in case['products']]
                        self.assertEqual(discovered['products'], expected)
                        self.assertEqual([c['url'] for c in discovered['cards']], expected)
                        self.assertEqual(discovered['next'], case['next'])
                        for invalid in ['https://unrelated.example/products/bra', 'https://www.skarlettblue.com/pages/about']:
                            page.locator(config['listing']['productLinkSelector']).first.evaluate('(n, u) => n.href = u', invalid)
                            with self.assertRaisesRegex(Exception, 'foreign or invalid product link'):
                                page.evaluate("c => inspectTakeoverPage(c, 'discovery', 'listing')", config)
                    else:
                        self.assertTrue(page.evaluate('c => captureProductSeen(c)', config))
                        self.assertTrue(page.evaluate('capturePageProduct().name'))
                        content = source('content_script.js')
                        page.add_script_tag(content='const takeoverDocumentId="fixture";' + content[
                            content.index('function captureCanonicalUrl('):content.index('function rescanCaptureImages(')])
                        canonical = page.locator('link[rel=canonical]').get_attribute('href')
                        page.evaluate("u => history.replaceState({}, '', u)", canonical)
                        page.evaluate("u => assertTakeoverBinding({documentId:'fixture', expectedUrl:u})", canonical)
                        with self.assertRaisesRegex(Exception, 'URL'):
                            page.evaluate("assertTakeoverBinding({documentId:'fixture', expectedUrl:'https://www.skarlettblue.com/products/unrelated'})")
                        gallery = page.evaluate("c => captureGallery(c, 'site')", config)
                        self.assertEqual(gallery, case['images'])
                        self.assertEqual(len(gallery), len(set(gallery)))
                        transformed = page.evaluate("c => captureGallery(c, 'site').map(u => PageImageSaverHelpers.captureImageUrls(u, c.product.highResTransform).fetched_url)", config)
                        self.assertTrue(all('width=1500' in u for u in transformed))
                        self.assertTrue(all('/cdn/shop/files/' in u for u in gallery))
                finally:
                    page.close()
        self.assertEqual(len(listings[0] | listings[1]), 100)
        self.assertFalse(listings[0] & listings[1])


if __name__ == '__main__':
    unittest.main(defaultTest='SkarlettBlueFixtures.test_skarlettblue_saved_pages')
