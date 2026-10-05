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
