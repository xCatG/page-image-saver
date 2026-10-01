"""Installed-extension regression for catalog previews using saved, offline page HTML.

Run with: uv run --offline --with playwright python tests/catalog_preview_extension_browser.py
"""

from pathlib import Path
import os
import shutil
import tempfile
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FULL_CHROMIUM = sorted((Path.home() / ".cache/ms-playwright").glob("chromium-*/chrome-linux64/chrome"))
CHROMIUM = os.environ.get("PIS_CHROMIUM") or shutil.which("chromium") or (
    str(FULL_CHROMIUM[-1]) if FULL_CHROMIUM else None)
LISE_HTML = (ROOT / "tests/fixtures/lisecharmel-product.html").read_text()
EMPREINTE_URL = "https://www.empreinte.eu/in/fr/soutiens-gorge/old-product.html"


class CatalogPreviewExtensionBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CHROMIUM:
            raise RuntimeError("Full Chromium is required; set PIS_CHROMIUM to its executable path")
        cls.profile = tempfile.TemporaryDirectory(prefix="pis-preview-test-")
        cls.playwright = sync_playwright().start()
        cls.context = cls.playwright.chromium.launch_persistent_context(
            cls.profile.name, headless=True, executable_path=CHROMIUM,
            args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"])
        cls.worker = cls.context.service_workers[0] if cls.context.service_workers else cls.context.wait_for_event(
            "serviceworker", timeout=10000)

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.playwright.stop()
        cls.profile.cleanup()

    def setUp(self):
        self.worker.evaluate("chrome.storage.local.clear()")
        self.page = self.context.new_page()
        self.page.route("**/*", self.route_fixture)

    def tearDown(self):
        self.page.close()

    @staticmethod
    def route_fixture(route):
        url = route.request.url
        if url.startswith("chrome-extension://"):
            route.continue_()
        elif url.startswith("https://www.lisecharmel.com/"):
            route.fulfill(status=200, content_type="text/html", body=LISE_HTML)
        elif url.startswith("https://unknown.example.test/"):
            route.fulfill(status=200, content_type="text/html", body="<html><body>Unknown site</body></html>")
        else:
            route.fulfill(status=404, body="")

    def open_panel(self, url):
        self.page.goto(url, wait_until="domcontentloaded")
        self.worker.evaluate("""async url => {
          const [tab] = await chrome.tabs.query({url});
          return chrome.tabs.sendMessage(tab.id, {action: 'findImages'});
        }""", url)
        self.page.locator("#catalog-capture-section").wait_for(timeout=5000)
        self.page.locator("#catalog-capture-section summary").click()

    def test_real_missing_config_rejection_falls_back_and_replaces_foreign_preview(self):
        self.worker.evaluate("""url => chrome.storage.local.set({catalogTakeoverRun: {
          version: 1, generation: 1, status: 'preview', domain: 'www.empreinte.eu',
          previews: [{kind: 'listing', url, products: 4}], products: [],
          preview: {endCheckConfigured: false}, listings: {visited: []}
        }})""", EMPREINTE_URL)
        self.open_panel("https://www.lisecharmel.com/product-test")
        progress = self.page.locator("#takeover-progress")
        self.page.wait_for_function("document.querySelector('#takeover-progress').textContent.includes('www.empreinte.eu')")
        self.assertNotIn(EMPREINTE_URL, progress.inner_text())
        self.assertNotIn("4 product links", progress.inner_text())
        self.page.locator("#takeover-preview-btn").click()
        self.page.wait_for_function("document.querySelector('#takeover-progress').textContent.includes('3 gallery images')")
        self.assertIn("www.lisecharmel.com/product-test", progress.inner_text())
        self.assertNotIn(EMPREINTE_URL, progress.inner_text())
        self.assertEqual(self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun.domain)"),
                         "www.lisecharmel.com")

    def test_unknown_site_failure_is_visible_and_cannot_control_foreign_run(self):
        self.worker.evaluate("""url => chrome.storage.local.set({catalogTakeoverRun: {
          version: 1, generation: 1, status: 'running', domain: 'www.empreinte.eu',
          previews: [{kind: 'listing', url, products: 4}], products: [],
          preview: {endCheckConfigured: false}, listings: {visited: []}
        }})""", EMPREINTE_URL)
        self.open_panel("https://unknown.example.test/page")
        progress = self.page.locator("#takeover-progress")
        self.page.wait_for_function("document.querySelector('#takeover-progress').textContent.includes('www.empreinte.eu')")
        self.assertNotIn(EMPREINTE_URL, progress.inner_text())
        self.assertIn("must stop or finish", progress.inner_text())
        self.page.locator("#takeover-preview-btn").click()
        feedback = self.page.locator("#takeover-feedback")
        self.page.wait_for_function("document.querySelector('#takeover-feedback')?.textContent.includes('No site config')")
        self.page.wait_for_timeout(2200)
        self.assertIn("No site config", feedback.inner_text())
        self.assertNotIn(EMPREINTE_URL, progress.inner_text())
        self.assertTrue(self.page.locator("#takeover-start-btn").is_disabled())
        self.assertTrue(self.page.locator("#takeover-stop-btn").is_disabled())
        self.assertEqual(self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun.domain)"),
                         "www.empreinte.eu")


if __name__ == "__main__":
    unittest.main()
