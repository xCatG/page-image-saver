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

    def test_vs_renamed_velour_slug_binding_and_gallery(self):
        config = json.loads(source("site_config/www.victoriassecret.com.json"))
        queued = "https://www.victoriassecret.com/us/pink/panties-catalog/5000005293/-/a/generic-11291842-choice-72ZS/plush-touch-boyshort-panty-green"
        page = self.open_fixture(config['domain'], 'victoriassecret-pink-velour.html')
        try:
            page.evaluate("url => history.replaceState({}, '', url)", queued)
            content = source("content_script.js")
            page.add_script_tag(content='const takeoverDocumentId="fixture";' +
                content[content.index("function captureCanonicalUrl("):content.index("function rescanCaptureImages(")])
            page.evaluate("url => assertTakeoverBinding({documentId:'fixture', documentUrl:url, expectedUrl:url})", queued)
            facts = page.evaluate('capturePageProduct()')
            self.assertEqual(facts['name'], 'Plush Touch Velour Boyshort Panty')
            self.assertEqual(facts['color'], 'Pretty Mint Confetti Velour')
            self.assertTrue(page.evaluate('c => captureProductSeen(c)', config))
            self.assertEqual(len(page.evaluate("c => captureGallery(c, 'site')", config)), 3)
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
        cls.extractor = (content[start:end] +
            content[content.index("function captureCanonicalUrl("):content.index("function capturePageHtml()")] +
            content[content.index("function takeoverUnavailableChoice("):content.index("function assertTakeoverBinding(")])
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

    def test_vdv_saved_colour_pdps_preserve_facts_and_full_gallery(self):
        cases = json.loads((FIXTURES / 'vdv-expected.json').read_text())
        for row in cases:
            with self.subTest(brand=row['brand'], kind=row['kind']):
                host = f"www.{row['brand']}.com"
                config = json.loads(source(f'site_config/{host}.json'))
                page = self.open_fixture(host, row['fixture'])
                try:
                    page.evaluate("url => history.replaceState({}, '', url)", row['url'])
                    evidence = page.evaluate('capturePageProductEvidence()')
                    self.assertEqual(evidence['format'], 'page-image-saver-product-evidence/v1')
                    facts = evidence['facts']
                    self.assertEqual({k:facts[k] for k in ['name','sku','product_id','color']},
                        {k:row[k] for k in ['name','sku','product_id','color']})
                    self.assertEqual(facts['offers'], {'price':str(row['price']), 'currency':'USD'})
                    self.assertEqual(page.evaluate("c => captureGallery(c, 'site')", config), row['images'])
                    self.assertTrue(page.evaluate('c => captureProductSeen(c)', config))
                    content = source('content_script.js')
                    page.add_script_tag(content='const takeoverDocumentId="fixture";' + content[
                        content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')])
                    inspected = page.evaluate("c => inspectTakeoverPage(c, 'capture-discovery', 'product')", config)
                    self.assertIn('lingerie', inspected['product']['category'])
                    self.assertEqual(inspected['imageCount'],len(row['images']))
                    # A same-tab SPA colour change must not capture stale embedded Next data.
                    page.evaluate("history.replaceState({}, '', '/en-us/p/other-colour-OTHER')")
                    error = page.evaluate("""c => { try {captureGallery(c, 'site'); return 'accepted';}
                        catch(e) {return e.message;} }""", config)
                    self.assertIn('URL differs from product slugs.en',error)
                    page.evaluate("history.replaceState({}, '', '/en-us/lingerie')")
                    self.assertFalse(page.evaluate("c => captureProductSeen(c, {product_id:'cross-sell'})", config))
                finally:
                    page.close()

    def test_lise_numbered_listing_discovery_reads_real_totals(self):
        config = json.loads(source("site_config/www.lisecharmel.com.json"))
        for suffix, count, next_url in [("first", 24, "https://www.lisecharmel.com/lc_us_en/lingerie.html?p=2"), ("last", 9, None)]:
            page = self.open_fixture(config["domain"], f"lisecharmel-listing-{suffix}.html")
            try:
                content = source("content_script.js")
                inspector = content[content.index("function takeoverCategory()"):content.index("// A site must be explicitly enabled")]
                page.add_script_tag(content='const takeoverDocumentId="fixture";' + inspector)
                result = page.evaluate("c => inspectTakeoverPage(c, 'discovery', 'listing')", config)
                self.assertEqual(len(result["products"]), count)
                self.assertEqual(result["next"], next_url)
                self.assertEqual(result["end"], {"type": "result-total", "total": 537})
                self.assertTrue(all(u.startswith("https://www.lisecharmel.com/lc_us_en/") for u in result["products"]))
            finally:
                page.close()

    def test_lise_saved_alias_is_never_rewritten_to_a_nonexistent_slug(self):
        config = json.loads(source("site_config/www.lisecharmel.com.json"))
        page = self.open_fixture(config['domain'], 'lisecharmel-alias-listing.html')
        try:
            content = source('content_script.js')
            page.add_script_tag(content='const takeoverDocumentId="fixture";' + content[
                content.index('function takeoverCategory()'):content.index('// A site must be explicitly enabled')])
            expected = 'https://www.lisecharmel.com/lc_us_en/catalog/product/view/id/69666/s/non-wire-bra-sublime-en-dentelle-noir-ach6513-0005/category/13/'
            result = page.evaluate("c => inspectTakeoverPage(c, 'discovery', 'listing')", config)
            self.assertEqual(result['products'], [expected])
            self.assertEqual([c['url'] for c in result['cards']], [expected])
            # A second category and a later direct URL for the same evidenced id.
            page.evaluate("""url => {
              const card = document.querySelector('li');
              const duplicate = card.cloneNode(true); duplicate.querySelector('a.product-item-link').href = url.replace('/13/', '/19/');
              document.querySelector('ol').append(duplicate);
              const direct = card.cloneNode(true); direct.querySelector('a.product-item-photo').href = '/lc_us_en/linked-direct.html';
              document.querySelector('ol').append(direct);
            }""", expected)
            result = page.evaluate("c => inspectTakeoverPage(c, 'discovery', 'listing')", config)
            self.assertEqual(result['products'], ['https://www.lisecharmel.com/lc_us_en/linked-direct.html'])
        finally:
            page.close()

    def test_lise_alias_binding_stays_exact_and_rejects_unknown_canonical_rewrites(self):
        page = self.open_fixture('www.lisecharmel.com', 'lisecharmel-bra-magento.html')
        alias = 'https://www.lisecharmel.com/lc_us_en/catalog/product/view/id/69666/s/non-wire-bra-sublime-en-dentelle-noir-ach6513-0005/category/13/'
        try:
            content = source('content_script.js')
            page.add_script_tag(content='const takeoverDocumentId="fixture";' + content[
                content.index('function captureCanonicalUrl('):content.index('function rescanCaptureImages(')])
            page.evaluate("document.querySelectorAll('link[rel=canonical]').forEach(n => n.remove())")
            page.evaluate("url => history.replaceState({}, '', url)", alias)
            page.evaluate("url => assertTakeoverBinding({documentId:'fixture', expectedUrl:url})", alias)
            # No canonical in the saved PDPs; an unexpected canonical must not grant a rewrite.
            page.evaluate("""() => { const c = document.createElement('link'); c.rel='canonical';
                c.href='/lc_us_en/non-wire-bra-sublime-en-dentelle-noir-ach6513-0005.html'; document.head.append(c); }""")
            result = page.evaluate("""url => {try {assertTakeoverBinding({documentId:'fixture',expectedUrl:url}); return 'accepted';}
                catch(e) {return e.message;} }""", alias)
            self.assertIn('take-over document or product URL changed: canonical', result)
        finally:
            page.close()

    def test_lise_early_observer_retains_init_removed_in_same_task(self):
        page = self.open_fixture("www.lisecharmel.com", "lisecharmel-bra-magento.html")
        try:
            page.evaluate("window.initText=document.querySelector('script[type=\"text/x-magento-init\"]').textContent;document.querySelectorAll('script[type=\"text/x-magento-init\"]').forEach(n=>n.remove())")
            page.add_script_tag(content=source("lisecharmel_gallery.js"))
            page.evaluate("const s=document.createElement('script');s.type='text/x-magento-init';s.textContent=window.initText;document.body.append(s);s.remove()")
            self.assertEqual(page.evaluate("PageImageSaverLiseGallery.length"), 1)
        finally:
            page.close()

    def test_lise_magento_originals_and_colour_specific_facts(self):
        config = json.loads(source("site_config/www.lisecharmel.com.json"))
        cases = [("bra", "1/2 pad cup", "231451", "ACH7015_12087", "Deesse Aurore", "202", 8),
                 ("brief", "Fancy Brief", "235803", "ACM0214_15093", "Vert Parme", "132", 6),
                 ("body", "Bodysuit", "216181", "ALJ5249_18082", "Ombre Rouge", "253", 8)]
        for kind, name, product_id, sku, color, price, count in cases:
            with self.subTest(kind=kind):
                page = self.open_fixture("www.lisecharmel.com", f"lisecharmel-{kind}-magento.html")
                page.evaluate("history.replaceState({}, '', document.querySelector('link[rel=canonical]').href)")
                try:
                    result = page.evaluate("c => ({facts: capturePageProduct(), seen: captureProductSeen(c), gallery: captureGallery(c, 'site')})", config)
                    self.assertTrue(result["seen"])
                    self.assertEqual(result["facts"]["sku"], sku)
                    self.assertEqual(result["facts"]["color"], color)
                    self.assertEqual(result["facts"]["offers"], {"price": price, "currency": "USD"})
                    self.assertEqual(result["facts"]["product_id"], product_id)
                    self.assertEqual(result["facts"]["name"], name)
                    self.assertEqual(len(result["gallery"]), count)
                    self.assertTrue(all("height=&width=" in u for u in result["gallery"]))
                    # Magento consumes init scripts during hydration: retain their original evidence.
                    page.add_script_tag(content=source("lisecharmel_gallery.js"))
                    page.evaluate("document.querySelectorAll('script[type=\"text/x-magento-init\"]').forEach(n=>n.remove())")
                    self.assertEqual(page.evaluate("c => captureGallery(c, 'site')", config), result["gallery"])
                    page.evaluate("globalThis.PageImageSaverLiseGallery = []")
                    with self.assertRaisesRegex(Exception, "gallery"):
                        page.evaluate("c => captureGallery(c, 'site')", config)
                finally:
                    page.close()

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
