"""Browser regression check for the image selector's catalog controls.

Run with: python3 tests/catalog_panel_browser.py
Requires the Python Playwright package and Chromium.
"""

from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright


SOURCE = (Path(__file__).resolve().parents[1] / "content_script.js").read_text()
START = SOURCE.index("function createImageSelectionUI(images) {")
END = SOURCE.index("// Apply size filter to images", START)
PANEL_SOURCE = SOURCE[START:END]

BOOTSTRAP = """
let currentDomain = 'shop.example.test';
let currentFilteredImages = [];
let allImagesCache = [];
let ignoredImageUrls = new Set();
let domainSettings = {minWidth: 50, minHeight: 50};
globalThis.storageValues = {};
globalThis.actions = [];
globalThis.chrome = {
  runtime: {lastError: null},
  storage: {
    local: {
      get(defaults, callback) {
        setTimeout(() => callback({...defaults, ...storageValues}), 0);
      },
      set(values) { Object.assign(storageValues, values); }
    },
    sync: {get(_key, callback) { callback({}); }}
  }
};
globalThis.loadCaptureSiteConfig = async () => null;
globalThis.capturePageProduct = () => ({});
globalThis.refreshTakeoverProgress = async () => {};
globalThis.normalizeImageUrl = url => url;
globalThis._createImageItemElement = () => document.createElement('div');
globalThis.captureCurrentProduct = async () => { actions.push('capture'); return {}; };
globalThis.recordCaptureFailure = async () => {};
globalThis.showStatusMessage = () => {};
globalThis.inspectTakeoverPage = async () => ({});
globalThis.takeoverRequest = async action => { actions.push(action); return {}; };
globalThis.PageImageSaverHelpers = {captureResultMessage: () => 'Captured'};
"""


class CatalogPanelBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.page.set_default_timeout(3000)
        self.page.set_content("<!doctype html><html><body></body></html>")
        self.page.add_script_tag(content=BOOTSTRAP + PANEL_SOURCE)

    def tearDown(self):
        self.page.close()

    def test_close_panel_while_status_request_is_pending(self):
        refresh = SOURCE[SOURCE.index('let takeoverRefreshSequence'):SOURCE.index('function takeoverCategory(')]
        self.page.add_script_tag(content=refresh)
        self.page.evaluate("""() => {
          globalThis.takeoverRequest = () => new Promise(resolve => {globalThis.finishStatus=resolve;});
          createImageSelectionUI([]);
        }""")
        self.page.locator('#close-btn').click()
        result = self.page.evaluate("""async () => {
          // Refresh explicitly so the promise itself is observable.
          createImageSelectionUI([]);
          const pending=refreshTakeoverProgress();
          document.querySelector('#close-btn').click();
          finishStatus({run:null,summary:{}});
          try { await pending; return 'settled'; } catch(error) {return error.message;}
        }""")
        self.assertEqual(result, 'settled')

    def open_panel(self):
        self.page.evaluate("createImageSelectionUI([])")
        self.page.wait_for_timeout(50)

    def test_catalog_is_closed_and_original_toolbar_and_grid_remain_usable(self):
        self.open_panel()
        details = self.page.locator("#catalog-capture-section")
        self.assertFalse(details.evaluate("element => element.open"))
        self.assertEqual(details.locator("summary").inner_text(), "Catalog capture")
        for button in ["save-selected-btn", "select-all-btn", "deselect-all-btn",
                       "save-page-btn", "take-screenshot-btn", "take-full-screenshot-btn", "close-btn"]:
            self.assertEqual(self.page.locator(f"#{button}").count(), 1)
            self.assertEqual(details.locator(f"#{button}").count(), 0)
        for control in ["capture-product-btn", "takeover-preview-btn", "takeover-start-btn",
                        "takeover-pause-btn", "takeover-resume-btn", "takeover-stop-btn",
                        "takeover-export-btn", "capture-image-mode", "capture-color-policy",
                        "capture-color", "capture-scope", "capture-scope-reason",
                        "capture-same-color-selection", "capture-auto-site"]:
            self.assertEqual(details.locator(f"#{control}").count(), 1, control)
        grid_height = self.page.locator("#image-list").evaluate(
            "element => element.getBoundingClientRect().height")
        print(f"Collapsed catalog: image grid is {grid_height:.0f}px tall in a 900px viewport")
        self.assertGreater(grid_height, 180, f"image grid height: {grid_height}")

    def test_feed_button_is_hidden_except_for_shopify(self):
        self.open_panel()
        self.assertEqual(self.page.locator('#shopify-feed-btn').count(), 1)
        self.assertTrue(self.page.locator('#shopify-feed-btn').evaluate('n => n.hidden'))
        self.page.locator('#close-btn').click()
        self.page.evaluate("loadCaptureSiteConfig = async () => ({platform:'shopify'})")
        self.open_panel()
        self.assertFalse(self.page.locator('#shopify-feed-btn').evaluate('n => n.hidden'))

    def test_open_state_persists_per_domain_after_reopening(self):
        self.open_panel()
        self.page.locator("#catalog-capture-section summary").click()
        self.assertTrue(self.page.locator("#catalog-capture-section").evaluate("element => element.open"))
        self.page.wait_for_function("storageValues['catalogCaptureOpen:shop.example.test'] === true")
        self.assertTrue(self.page.evaluate("storageValues['catalogCaptureOpen:shop.example.test']"))
        self.page.locator("#close-btn").click()
        self.open_panel()
        self.assertTrue(self.page.locator("#catalog-capture-section").evaluate("element => element.open"))
        self.page.locator("#close-btn").click()
        self.page.evaluate("currentDomain = 'other.example.test'")
        self.open_panel()
        self.assertFalse(self.page.locator("#catalog-capture-section").evaluate("element => element.open"))

    def test_compact_controls_leave_most_of_short_windows_for_images(self):
        for height in (600, 768, 900):
            with self.subTest(height=height):
                self.page.evaluate("document.querySelector('#image-selector-container')?.remove(); storageValues = {}")
                self.page.set_viewport_size({"width": 1280, "height": height})
                self.open_panel()
                panel = self.page.locator("#image-selector-container")
                grid = panel.locator("#image-list").bounding_box()
                self.assertGreaterEqual(grid["height"], height * 0.55)
                self.assertLessEqual(grid["y"] + grid["height"], height)
                panel.locator("#catalog-capture-section summary").click()
                for button in panel.locator("button").all():
                    size = button.bounding_box()
                    self.assertLessEqual(size["height"], 28, button.inner_text())
                    self.assertGreaterEqual(size["height"], 24, button.inner_text())
                    self.assertFalse(button.evaluate("el => el.scrollWidth > el.clientWidth"))
                panel.locator("#close-btn").click()
                self.page.evaluate("storageValues = {}")

    def test_host_touch_button_styles_do_not_expand_panel_or_lose_focus_ring(self):
        self.page.add_style_tag(content="""
          button { min-height: 56px; padding: 20px; margin: 12px;
                   font-size: 24px; line-height: 2; width: 100%; outline: none; }
        """)
        self.page.evaluate("document.body.innerHTML = '<button id=host-button>Host button</button>'")
        self.open_panel()
        panel = self.page.locator("#image-selector-container")
        panel.locator("#catalog-capture-section summary").click()
        for button in panel.locator("button").all():
            self.assertLessEqual(button.bounding_box()["height"], 28, button.inner_text())
        self.assertGreaterEqual(self.page.locator("#host-button").bounding_box()["height"], 56)
        self.page.keyboard.press("Tab")
        panel.locator("#save-selected-btn").focus()
        self.assertTrue(panel.locator("#save-selected-btn").evaluate("el => el.matches(':focus-visible')"))
        self.assertNotEqual(panel.locator("#save-selected-btn").evaluate(
            "el => getComputedStyle(el).outlineStyle"), "none")

    def test_local_folder_controls_still_leave_half_a_short_window_for_images(self):
        self.page.set_viewport_size({"width": 1280, "height": 600})
        self.page.evaluate("""() => { chrome.storage.sync.get = (_key, callback) =>
            callback({imageUploaderSettings: {local: {enabled: true}}}); }""")
        self.open_panel()
        panel = self.page.locator("#image-selector-container")
        self.assertTrue(panel.locator("#folder-name").is_visible())
        self.assertGreaterEqual(panel.locator("#image-list").bounding_box()["height"], 300)
        panel.locator("#catalog-capture-section summary").click()
        self.assertGreaterEqual(panel.locator("#image-list").bounding_box()["height"], 100)

    def test_compact_buttons_work_when_storefront_blocks_style_elements(self):
        self.page.evaluate("""() => {
          const policy = document.createElement('meta');
          policy.httpEquiv = 'Content-Security-Policy';
          policy.content = "style-src-elem 'none'; style-src-attr 'unsafe-inline'";
          document.head.appendChild(policy);
        }""")
        self.open_panel()
        self.assertLessEqual(self.page.locator("#save-selected-btn").bounding_box()["height"], 28)

    def test_user_toggle_wins_over_delayed_storage_restore(self):
        self.page.evaluate("""storageValues['catalogCaptureOpen:shop.example.test'] = false;
          const originalGet = chrome.storage.local.get;
          chrome.storage.local.get = (key, callback) => {
            if (key === 'catalogCaptureOpen:shop.example.test') {
              window.releaseSavedState = () => callback({[key]: false});
            } else originalGet(key, callback);
          };""")
        self.open_panel()
        self.page.locator("#catalog-capture-section summary").click()
        self.page.evaluate("releaseSavedState()")
        self.assertTrue(self.page.locator("#catalog-capture-section").evaluate("element => element.open"))
        self.page.wait_for_function("storageValues['catalogCaptureOpen:shop.example.test'] === true")
        self.assertTrue(self.page.evaluate("storageValues['catalogCaptureOpen:shop.example.test']"))

    def test_recent_failures_are_scoped_to_domain_and_refresh_on_open(self):
        self.page.evaluate("""storageValues.captureFailures = [
          {url: 'https://shop.example.test/old', at: '2026-09-01T00:00:00Z', reason: 'old'},
          {url: 'https://other.example.test/bra', at: '2026-09-29T00:00:00Z', reason: 'other site'},
          ...Array.from({length: 6}, (_, i) => ({url: `https://shop.example.test/${i}`,
            at: `2026-09-29T00:00:0${i}Z`, reason: `failure ${i}`}))
        ]""")
        self.open_panel()
        self.page.locator("#catalog-capture-section summary").click()
        failures = self.page.locator("#capture-failures li")
        self.assertEqual(failures.count(), 5)
        self.assertIn("shop.example.test", failures.first.inner_text())
        self.assertIn("2026-09-29T00:00:05Z", failures.first.inner_text())
        self.assertIn("failure 5", failures.first.inner_text())
        self.assertNotIn("other site", self.page.locator("#capture-failures").inner_text())
        self.assertNotIn("failure 0", self.page.locator("#capture-failures").inner_text())
        self.page.evaluate("""storageValues.captureFailures.push({url: 'https://shop.example.test/new',
          at: '2026-09-30T00:00:00Z', reason: '<img src=x onerror=alert(1)>'})""")
        self.page.locator("#catalog-capture-section summary").click()
        self.page.locator("#catalog-capture-section summary").click()
        self.page.wait_for_timeout(50)
        self.assertIn("<img src=x onerror=alert(1)>", failures.first.inner_text())
        self.assertEqual(self.page.locator("#capture-failures img").count(), 0)

    def test_toolbar_and_catalog_buttons_keep_their_click_handlers(self):
        self.open_panel()
        self.page.evaluate("""currentFilteredImages = [{url: 'https://shop.example.test/bra.png'}];
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.dataset.index = '0';
          document.querySelector('#image-list').appendChild(checkbox);""")
        self.page.locator("#select-all-btn").click()
        self.assertTrue(self.page.locator("#image-list input").is_checked())
        self.page.locator("#deselect-all-btn").click()
        self.assertFalse(self.page.locator("#image-list input").is_checked())
        self.page.locator("#catalog-capture-section summary").click()
        self.page.locator("#capture-auto-site").check()
        self.page.locator("#select-all-btn").click()
        self.page.locator("#deselect-all-btn").click()
        self.assertFalse(self.page.locator("#image-list input").is_checked())
        self.assertTrue(self.page.locator("#capture-auto-site").is_checked())
        self.page.locator("#capture-product-btn").click()
        for button in ["takeover-start-btn", "takeover-pause-btn", "takeover-resume-btn",
                       "takeover-stop-btn", "takeover-export-btn"]:
            self.page.locator(f"#{button}").click()
        self.assertEqual(self.page.evaluate("actions"), ["capture", "takeoverStart", "takeoverPause",
                                                     "takeoverResume", "takeoverStop", "takeoverExport"])

    def test_toolbar_does_not_change_host_page_checkboxes_with_same_id(self):
        self.page.evaluate("""document.body.innerHTML = '<div id="image-list"><input type="checkbox" data-index="0" checked></div>'""")
        self.open_panel()
        self.page.evaluate("""currentFilteredImages = [{url: 'https://shop.example.test/bra.png'}];
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox'; checkbox.dataset.index = '0';
          document.querySelector('#image-selector-container #image-list').appendChild(checkbox);""")
        host = self.page.locator("body > #image-list input")
        own = self.page.locator("#image-selector-container #image-list input")
        self.page.locator("#select-all-btn").click()
        self.assertTrue(own.is_checked())
        self.page.locator("#deselect-all-btn").click()
        self.assertFalse(own.is_checked())
        self.assertTrue(host.is_checked())

    def test_new_manual_failure_appears_while_catalog_stays_open(self):
        self.page.evaluate("""(() => { captureCurrentProduct = async () => { throw Error('receiver unreachable'); };
          recordCaptureFailure = async error => { storageValues.captureFailures = [{
            url: 'https://shop.example.test/bra', at: 'now', reason: error.message}]; }; })()""")
        self.open_panel()
        self.page.locator("#catalog-capture-section summary").click()
        self.page.locator("#capture-product-btn").click()
        self.page.wait_for_function("document.querySelector('#capture-failures').textContent.includes('receiver unreachable')")
        self.assertIn("receiver unreachable", self.page.locator("#capture-failures").inner_text())


if __name__ == "__main__":
    unittest.main()
