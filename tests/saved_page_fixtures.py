"""Browser regressions over scrubbed excerpts of saved storefront DOM."""

import json
import os
from pathlib import Path
import subprocess
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
BASELINE = os.environ.get("PIS_FIXTURE_BASELINE")


def source(path):
    if BASELINE:
        return subprocess.check_output(["git", "show", f"{BASELINE}:{path}"], cwd=ROOT, text=True)
    return (ROOT / path).read_text()


class SavedPageFixtures(unittest.TestCase):
    def test_vs_and_pink_rendered_product_facts_and_primary_gallery(self):
        config = json.loads(source("site_config/www.victoriassecret.com.json"))
        cases = [
            ('wave', 'Wave Stripe Peekaboo Demi Bra', 'Black', '1128847700', '64.95', 3),
            ('viper', 'Viper Embroidery Peekaboo Halter Demi Bra', 'Black', '1128847600', '64.95', 3),
            ('pink-rose', 'PINK Wink™ Push-Up Balconette Bra', 'Rose Taupe', '5000009521', '49.95', 5),
            ('pink-blue', 'PINK Wink™ Push-Up Balconette Bra', 'Sheer Blue', '5000009521', '49.95', 4)]
        for file, name, color, product_id, price, count in cases:
            with self.subTest(file=file):
                page = self.open_fixture(config['domain'], f'victoriassecret-{file}.html')
                try:
                    facts = page.evaluate('capturePageProduct()')
                    self.assertEqual({k:facts[k] for k in ('name','color','product_id','offers')},
                        {'name':name,'color':color,'product_id':product_id,'offers':{'price':price,'currency':'USD'}})
                    self.assertTrue(page.evaluate('c => captureProductSeen(c)', config))
                    gallery = page.evaluate("c => captureGallery(c, 'site')", config)
                    self.assertEqual(len(gallery), count)
                    self.assertTrue(all(u.startswith('https://www.victoriassecret.com/p/') for u in gallery))
                    self.assertFalse(any('_SW.' in u for u in gallery))
                    if file == 'wave':
                        self.assertEqual(gallery[0], 'https://www.victoriassecret.com/p/1000x1333/png/zz/26/08/31/01/1128847754A2_OM_F.jpg')
                    evidence = page.evaluate('capturePageProductEvidence()')
                    self.assertEqual(evidence['fact_source'], 'microdata')
                    self.assertEqual(evidence['microdata']['color'], color)
                finally:
                    page.close()

    def test_vs_adaptive_readiness_and_ganache_facts(self):
        config = json.loads(source("site_config/www.victoriassecret.com.json"))
        page = self.open_fixture(config['domain'], 'victoriassecret-adaptive.html')
        try:
            content = source("content_script.js")
            inspector = content[content.index("function takeoverCategory()"):
                content.index("// A site must be explicitly enabled")]
            page.add_script_tag(content='const takeoverDocumentId="fixture"; function rescanCaptureImages() {}' + inspector)
            result = page.evaluate("c => inspectTakeoverPage(c, 'capture-discovery', 'product')", config)
            self.assertEqual(result['kind'], 'product')
            self.assertEqual(result['imageCount'], 5)
            self.assertEqual(result['product']['name'], 'VS Adaptive Lightly Lined Front-Close Full Coverage Bra')
            self.assertEqual(result['product']['color'], 'Ganache')
            self.assertEqual(result['product']['product_id'], '5000008963')
            self.assertEqual(result['product']['offers'], {'price': '54.95', 'currency': 'USD'})
            self.assertEqual(page.locator('[data-testid="ImageBadge"]').count(), 1)
            self.assertEqual(page.evaluate("c => captureGallery(c, 'site')[0]", config),
                'https://www.victoriassecret.com/p/760x1013/tif/zz/23/08/02/02/1121720633F6_OM_F.jpg')
        finally:
            page.close()

    def test_vs_query_rendition_does_not_invent_queryless_original(self):
        config = json.loads(source("site_config/www.victoriassecret.com.json"))
        page = self.open_fixture(config['domain'], 'victoriassecret-wave.html')
        try:
            page.evaluate("""() => {
              const meta = document.createElement('meta');
              meta.content = 'https://www.victoriassecret.com/p/2000x2666/png/zz/26/08/31/01/1128847754A2_OM_F.jpg?crop=1';
              document.head.append(meta);
            }""")
            self.assertEqual(page.evaluate("c => captureGallery(c, 'site')[0]", config),
                'https://www.victoriassecret.com/p/1000x1333/png/zz/26/08/31/01/1128847754A2_OM_F.jpg')
        finally:
            page.close()

    def test_vs_gallery_missing_original_and_listing_fail_closed(self):
        config = json.loads(source("site_config/www.victoriassecret.com.json"))
        page = self.open_fixture(config['domain'], 'victoriassecret-wave.html')
        try:
            page.evaluate("document.querySelector('img[id^=primaryProductAltImages]').src = './saved_files/unknown.jpg'")
            with self.assertRaisesRegex(Exception, 'evidenced'):
                page.evaluate("c => captureGallery(c, 'site')", config)
            page.evaluate("document.querySelectorAll('img[id^=primaryProductAltImages]').forEach(n => n.remove())")
            self.assertFalse(page.evaluate('c => captureProductSeen(c)', config))
        finally:
            page.close()

    def test_sanscomplexe_saved_listing_and_gallery(self):
        config = json.loads(source("site_config/www.sanscomplexe.com.json"))
        page = self.open_fixture(config["domain"], "sanscomplexe-listing.html")
        try:
            self.assertEqual(page.locator(config["listing"]["productLinkSelector"]).count(), 36)
            self.assertEqual(page.locator(config["listing"]["pagination"]["nextSelector"]).get_attribute("href"),
                "/en/collections/all?page=2")
        finally:
            page.close()
        page = self.open_fixture(config["domain"], "sanscomplexe-product.html")
        try:
            self.assertEqual(page.locator(config["product"]["allImagesSelector"]).count(), 5)
            gallery = page.evaluate("config => captureGallery(config, 'site')", config)
            self.assertEqual(len(gallery), 5)
            fetched = page.evaluate("config => captureGallery(config, 'site').map(url => "
                "PageImageSaverHelpers.captureImageUrls(url, config.product.highResTransform).fetched_url)", config)
            self.assertTrue(all("width=2400" in url for url in fetched))
            self.assertTrue(all("recommendation" not in url for url in gallery))
        finally:
            page.close()

    def test_ap_saved_gallery_originals_and_carousel_deduplication(self):
        config = json.loads(source("site_config/www.agentprovocateur.com.json"))
        page = self.open_fixture(config["domain"], "agentprovocateur-davinah.html")
        try:
            self.assertTrue(page.evaluate("c => captureProductSeen(c)", config))
            gallery = page.evaluate("c => captureGallery(c, 'site')", config)
            self.assertEqual(gallery, [
                "https://www.agentprovocateur.com/static/media/catalog/product/2/8/106604_flatshot_front.jpg",
                "https://www.agentprovocateur.com/static/media/catalog/product/2/8/106604_ecom_1.jpg",
                "https://www.agentprovocateur.com/static/media/catalog/product/2/8/106604_ecom_2.jpg"])
            # Model live proxy src using only originals evidenced in this save.
            page.evaluate("""urls => {
              document.querySelectorAll('product-media-wrapper img').forEach(img => {
                const name = img.getAttribute('src').split('/').pop();
                img.src = '/tco-images/unsafe/0x0/filters:quality(80)/' + urls.find(u => u.endsWith('/' + name));
              });
              document.querySelector('#image-selector-container').remove();
            }""", gallery)
            self.assertEqual(page.evaluate("c => captureGallery(c, 'site')", config), gallery)
            page.evaluate("c => PageImageSaverHelpers.prepareLazyGallery(c, document, {timeoutMs: 500})", config)
        finally:
            page.close()

    def test_ap_saved_pages_do_not_guess_missing_gallery_originals(self):
        config = json.loads(source("site_config/www.agentprovocateur.com.json"))
        for name, count in [("lorna", 5), ("essie", 3)]:
            page = self.open_fixture(config["domain"], f"agentprovocateur-{name}.html")
            try:
                self.assertEqual(page.evaluate("c => new Set([...document.querySelectorAll(c.product.allImagesSelector)].map(n => n.getAttribute('src'))).size", config), count)
                result = page.evaluate("""c => {try { captureGallery(c, 'site'); return ''; }
                  catch (e) { return e.message; }}""", config)
                self.assertIn("original", result)
            finally:
                page.close()

    def test_ap_saved_listing_is_scoped_and_has_no_false_terminal_proof(self):
        config = json.loads(source("site_config/www.agentprovocateur.com.json"))
        page = self.open_fixture(config["domain"], "agentprovocateur-listing.html")
        try:
            self.assertEqual(page.locator(config["listing"]["productLinkSelector"]).count(), 3)
            self.assertFalse(page.evaluate("c => captureProductSeen(c)", config))
            self.assertEqual(page.locator(config["listing"]["pagination"]["nextSelector"]).count(), 0)
            self.assertNotIn("endCheck", config["listing"])
        finally:
            page.close()

    def test_ap_live_candidates_skip_bad_input_and_share_lazy_resolution(self):
        config = json.loads(source("site_config/www.agentprovocateur.com.json"))
        page = self.open_fixture(config["domain"], "agentprovocateur-davinah.html")
        try:
            expected = page.evaluate("c => captureGallery(c, 'site')", config)
            page.evaluate("""urls => {
              const main = document.querySelector('main'); main.innerHTML = '';
              const attributes = [
                {src: 'https://[bad/', 'data-src': new URL(urls[0]).pathname},
                {src: 'data:image/gif;base64,AAAA', srcset: urls[1].replace('https:', '') + ' 2x'},
                {src: '', 'data-src': '/tco-images/unsafe/0x0/' + encodeURIComponent(urls[2])},
                {src: 'https://[bad/'}];
              for (const attrs of attributes) {
                const wrapper = document.createElement('product-media-wrapper');
                const img = document.createElement('img'); img.className = 'df-image';
                for (const [key, value] of Object.entries(attrs)) img.setAttribute(key, value);
                wrapper.append(img); main.append(wrapper);
              }
              document.querySelector('#image-selector-container').remove();
            }""", expected)
            self.assertEqual(page.evaluate("c => captureGallery(c, 'site')", config), expected)
            page.evaluate("c => PageImageSaverHelpers.prepareLazyGallery(c, document, {timeoutMs: 500, pollMs: 10})", config)
            page.evaluate("document.querySelector('main').innerHTML = '<product-media-wrapper><img class=\"df-image\" src=\"https://[bad/\"></product-media-wrapper>'")
            reason = page.evaluate("""c => {try { captureGallery(c, 'site'); return ''; }
                catch (e) { return e.message; }}""", config)
            self.assertIn('gallery', reason)
            self.assertIn('https://[bad/', reason)
        finally:
            page.close()

    def test_ap_lazy_placeholder_gets_time_to_materialize(self):
        config = json.loads(source("site_config/www.agentprovocateur.com.json"))
        page = self.open_fixture(config["domain"], "agentprovocateur-davinah.html")
        try:
            page.evaluate("""() => {
              const original = 'https://www.agentprovocateur.com/static/media/catalog/product/2/8/106604_ecom_1.jpg';
              document.querySelector('main').innerHTML = '<product-media-wrapper><img class="df-image"></product-media-wrapper>'.repeat(2);
              const images = document.querySelectorAll('main img');
              images[0].src = original;
              images[1].src = 'data:image/gif;base64,AAAA';
              images[1].scrollIntoView = () => {
                if (window.startedLazyLoad) return;
                window.startedLazyLoad = true;
                setTimeout(() => { images[1].src = original.replace('_1.jpg', '_2.jpg'); }, 100);
              };
            }""")
            result = page.evaluate("""async c => {
              await PageImageSaverHelpers.prepareLazyGallery(c, document, {timeoutMs: 500, pollMs: 10});
              return captureGallery(c, 'site');
            }""", config)
            self.assertEqual(len(result), 2)
        finally:
            page.close()

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        content = source("content_script.js")
        start = content.index("function captureJsonLd()")
        end = content.index("function captureSwatchColor()", start)
        cls.extractor = content[start:end]
        cls.helpers = source("extension_helpers.js")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def open_fixture(self, host, file):
        page = self.browser.new_page()
        page.route("**/*", lambda route: route.fulfill(status=200, body="", content_type="text/html"))
        page.goto(f"https://{host}/", wait_until="domcontentloaded")
        page.set_content((FIXTURES / file).read_text(), wait_until="domcontentloaded")
        page.add_script_tag(content=self.helpers)
        page.add_script_tag(content=self.extractor)
        return page

    def test_lise_saved_microdata_and_picture_gallery(self):
        config = json.loads(source("site_config/lisecharmel.com.json"))
        page = self.open_fixture("www.lisecharmel.com", "lisecharmel-product.html")
        try:
            result = page.evaluate("config => ({evidence: capturePageProductEvidence(), "
                "seen: captureProductSeen(config), gallery: captureGallery(config, 'site'), "
                "selected: [...document.querySelectorAll(config.product.allImagesSelector)].map(n => n.tagName)})", config)
            self.assertTrue(result["seen"])
            self.assertEqual(result["evidence"]["fact_source"], "microdata")
            self.assertEqual(result["evidence"]["facts"], {"name": "Demi cup bra",
                "sku": "ACH3013_0005", "product_id": "66720", "color": "Noir",
                "offers": {"price": "196", "currency": "USD"}})
            self.assertEqual(result["selected"], ["IMG", "IMG", "IMG"])
            self.assertEqual(len(result["gallery"]), 3)
            self.assertTrue(all("ach3013b__" in url for url in result["gallery"]))
        finally:
            page.close()

    def test_aubade_saved_gallery_and_og_only_facts(self):
        config = json.loads(source("site_config/aubade.com.json"))
        page = self.open_fixture("aubade.com", "aubade-product.html")
        try:
            result = page.evaluate("config => ({evidence: capturePageProductEvidence(), "
                "seen: captureProductSeen(config), gallery: captureGallery(config, 'site')})", config)
            self.assertTrue(result["seen"])
            self.assertEqual(result["evidence"]["fact_source"], "meta")
            self.assertEqual(result["evidence"]["facts"]["offers"],
                {"price": "44.50", "currency": "CHF"})
            self.assertEqual(len(result["gallery"]), 2)
            self.assertTrue(all(url.startswith("https://aubade.com/cdn/shop/files/4B26_EXCI_")
                for url in result["gallery"]))
        finally:
            page.close()

    def test_chantelle_saved_cards_with_synthetic_class_churn(self):
        config = json.loads(source("site_config/us.chantelle.com.json"))
        page = self.open_fixture("us.chantelle.com", "chantelle-listing.html")
        try:
            page.eval_on_selector_all("a[data-testid='ProductCard_link']",
                "nodes => nodes.forEach(node => node.classList.remove('product-card__link'))")
            links = page.eval_on_selector_all(config["listing"]["productLinkSelector"],
                "nodes => nodes.map(node => node.getAttribute('href'))")
            self.assertEqual(links, ["/product/norah-comfort-underwire-bra",
                "/product/norah-chic-plunge-t-shirt-bra"])
        finally:
            page.close()

    def test_product_microdata_on_listing_cards_is_not_a_product_page(self):
        for config_file in ("us.chantelle.com.json", "int.aubade.com.json", "www.empreinte.eu.json"):
            config = json.loads(source(f"site_config/{config_file}"))
            page = self.open_fixture(config["domain"], "chantelle-listing.html")
            try:
                page.evaluate("""document.querySelector('article').innerHTML =
                  '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Card bra</span></div>'""")
                self.assertFalse(page.evaluate("config => captureProductSeen(config)", config), config_file)
            finally:
                page.close()


if __name__ == "__main__":
    unittest.main()
