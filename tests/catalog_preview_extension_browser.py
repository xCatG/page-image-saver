"""Installed-extension regression for catalog previews using saved, offline page HTML.

Run with: uv run --offline --with playwright python tests/catalog_preview_extension_browser.py
"""

from pathlib import Path
import os
import shutil
import tempfile
import unittest
import json
import hashlib

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
        self.worker.evaluate("chrome.storage.session.clear()")
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
        elif url.startswith("https://us.chantelle.com/list"):
            route.fulfill(status=200, content_type="text/html", body='''<html lang="en-US"><body>
              <article class="product-card"><a class="product-card__link" href="/product/bra-black">Lace Bra</a> <span>$42</span></article>
              <article class="product-card"><a class="product-card__link" href="/product/brief-black">Brief</a> <span>$18</span></article>
              </body></html>''')
        elif url.startswith('https://us.chantelle.com/product/'):
            route.fulfill(status=200, content_type='text/html', body='''<html><body>
              <script type="application/ld+json">{"@type":"Product","name":"Fixture Bra","color":"Black","offers":{"price":"42","priceCurrency":"USD"}}</script>
              <div class="pdp-product-images__image"><img class="main-pdp-image" src="https://imagedelivery.net/fixture/prod/production/P/STYLE/BLACK/w=1024"></div>
              <a class="variant-picker__variant-link" href="/product/extra-color">Red</a>
              </body></html>''')
        else:
            route.fulfill(status=404, body="")

    def open_panel(self, url):
        self.page.goto(url, wait_until="domcontentloaded")
        self.worker.evaluate("""async url => {
          const [tab] = await chrome.tabs.query({url});
          for (let attempt = 0; attempt < 30; attempt++) {
            try { return await chrome.tabs.sendMessage(tab.id, {action: 'findImages'}); }
            catch (error) {
              if (!String(error).includes('Receiving end does not exist') || attempt === 29) throw error;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }""", url)
        self.page.locator("#catalog-capture-section").wait_for(timeout=5000)
        if not self.page.locator("#catalog-capture-section").evaluate('node => node.open'):
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

    def test_shopify_feed_real_panel_bridge_and_duplicate_guard(self):
        requests = []
        def saved_shopify(route):
            if '/products.json?' in route.request.url:
                requests.append(route.request.url)
                count = 250 if len(requests) == 1 else 1
                route.fulfill(status=200, content_type='application/json',
                    body=json.dumps({'products': [{'id': n} for n in range(count)]}))
            else:
                route.fulfill(status=200, content_type='text/html', body='<html><body>Saved storefront</body></html>')
        self.page.route('https://www.sanscomplexe.com/**', saved_shopify)
        self.worker.evaluate("""() => {
          globalThis.feedDownloads = [];
          globalThis.savedFeedDownload = PageImageSaverHelpers.saveCaptureDownload;
          PageImageSaverHelpers.saveCaptureDownload = async (_chrome, data, filename) => {
            feedDownloads.push({filename, report: JSON.parse(atob(data.split(',')[1]))});
          };
        }""")
        try:
            url = 'https://www.sanscomplexe.com/en/collections/soutien-gorge'
            self.open_panel(url)
            self.assertTrue(self.page.locator('#shopify-feed-btn').is_visible())
            self.page.locator('#shopify-feed-btn').click()
            self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('1 pages')")
            self.page.locator('#close-btn').click()
            self.worker.evaluate("""async url => {
              const [tab] = await chrome.tabs.query({url});
              await chrome.tabs.sendMessage(tab.id, {action:'findImages'});
            }""", url)
            self.page.locator('#shopify-feed-btn').click()
            self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('already active')")
            self.page.locator('#takeover-start-btn').click()
            self.page.wait_for_function("document.body.innerText.includes('wait for it to finish before take-over')")
            # The first operation survives its panel being closed; only the browser boundary is stubbed.
            self.page.wait_for_function("document.body.innerText.includes('Shopify feed saved to Downloads')", timeout=20000)
            downloaded = self.worker.evaluate('feedDownloads[0]')
            self.assertEqual(len(requests), 2)
            self.assertEqual(downloaded['report']['prefix'], '/en')
            self.assertEqual([p['product_count'] for p in downloaded['report']['fetched']], [250, 1])
            self.assertTrue(downloaded['filename'].startswith('www.sanscomplexe.com-products-feed-'))
        finally:
            self.worker.evaluate('() => { PageImageSaverHelpers.saveCaptureDownload = savedFeedDownload; }')

    def test_listing_discovery_uses_real_background_without_receiver_or_pdp(self):
        # Extension-created tabs can race Playwright's initial request routing.
        # Route an existing owned tab before the real runner navigates it.
        runner_page = self.context.new_page()
        runner_page.route('**/*', self.route_fixture)
        runner_page.goto('https://us.chantelle.com/list-runner')
        self.worker.evaluate('''async () => {
          const [tab] = await chrome.tabs.query({url: 'https://us.chantelle.com/list-runner'});
          await chrome.storage.local.set({catalogTakeoverTabId: tab.id});
        }''')
        try:
            self.open_panel('https://us.chantelle.com/list')
            self.assertEqual(self.page.locator('#takeover-mode').count(), 1)
            self.page.locator('#takeover-mode').select_option('discovery')
            self.page.locator('#takeover-preview-btn').click()
            self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Preview ready')")
            run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
            self.assertEqual(run['mode'], 'discovery')
            self.page.locator('#takeover-mode').select_option('capture')
            self.page.locator('#takeover-start-btn').click()
            self.page.wait_for_timeout(200)
            self.assertIn('preview the selected mode', self.page.locator('#status-message').inner_text())
            self.page.locator('#takeover-mode').select_option('discovery')
            self.worker.evaluate('''async () => {
              const {catalogTakeoverRun: run} = await chrome.storage.local.get('catalogTakeoverRun');
              run.config.takeover = {intervalMs: 0};
              await chrome.storage.local.set({catalogTakeoverRun: run});
            }''')
            self.page.locator('#takeover-start-btn').click()
            for _ in range(100):
                run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
                if run['status'] in ['finished_with_gaps', 'complete', 'paused']:
                    break
                self.page.wait_for_timeout(100)
            self.assertEqual(len(run['listings']['visited']), 1, run)
            report = self.worker.evaluate('''async () => PageImageSaverTakeover.exportTakeoverReport(
              (await chrome.storage.local.get('catalogTakeoverRun')).catalogTakeoverRun)''')
            self.assertEqual(report['format'], 'page-image-saver-discovery/v1')
            self.assertEqual(report['status'], 'finished_with_gaps')
            self.assertEqual(report['totals'], {'listing_pages': 1, 'product_urls': 2})
            self.assertEqual(report['locale'], 'en-US')
            self.assertEqual(report['listings'][0]['products'][0]['card_text'], 'Lace Bra $42')
            owned = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverTabId').then(x => chrome.tabs.get(x.catalogTakeoverTabId))")
            self.assertEqual(owned['url'], 'https://us.chantelle.com/list')
            self.worker.evaluate('chrome.tabs.remove(' + str(owned['id']) + ')')
        finally:
            if not runner_page.is_closed():
                runner_page.close()

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

    def test_discovery_files_prepare_fixed_queue_and_downloads_remain_unverified(self):
        self.open_panel('https://us.chantelle.com/list')
        self.assertEqual(self.page.locator('#takeover-discovery-files').count(), 1)
        def source(listing, urls):
            return json.dumps({'schema_version':1, 'format':'page-image-saver-discovery/v1',
                'mode':'discovery', 'site':'us.chantelle.com', 'started_utc':'2026-10-03T10:00:00.000Z',
                'listings':[{'url':listing, 'final_url':listing,
                    'products':[{'url':url,'card_text':'Fixture card'} for url in urls]}]}).encode()
        bra = 'https://us.chantelle.com/product/bra-black'
        brief = 'https://us.chantelle.com/product/brief-black'
        first = source('https://us.chantelle.com/list-bras', [bra])
        second = source('https://us.chantelle.com/list-panties', [bra, brief])
        self.page.locator('#takeover-discovery-files').set_input_files([
            {'name':'bras.json','mimeType':'application/json','buffer':first},
            {'name':'panties.json','mimeType':'application/json','buffer':second}])
        self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Fixed queue ready')")
        run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
        self.assertEqual([row['url'] for row in run['products']], [bra,brief])
        self.assertEqual(run['products'][0]['origins'], [
            {'file_sha256':hashlib.sha256(first).hexdigest(),'listing_url':'https://us.chantelle.com/list-bras'},
            {'file_sha256':hashlib.sha256(second).hexdigest(),'listing_url':'https://us.chantelle.com/list-panties'}])
        self.assertIn(bra, self.page.locator('#takeover-start-url').inner_text())
        runner_page = self.context.new_page()
        runner_page.route('**/*', self.route_fixture)
        runner_page.goto('https://us.chantelle.com/list-runner')
        self.worker.evaluate('''async () => {
          const [tab] = await chrome.tabs.query({url:'https://us.chantelle.com/list-runner'});
          const {catalogTakeoverRun:run} = await chrome.storage.local.get('catalogTakeoverRun');
          run.config.takeover = {intervalMs:0};
          await chrome.storage.local.set({catalogTakeoverRun:run,catalogTakeoverTabId:tab.id});
          await chrome.storage.sync.set({imageUploaderSettings:{receiver:{enabled:false}}});
          globalThis.fixtureFetch = globalThis.fetch;
          globalThis.fixtureSave = PageImageSaverHelpers.saveCaptureDownload;
          globalThis.fixtureDownloads = [];
          globalThis.fetch = async url => {
            if (!String(url).startsWith('https://imagedelivery.net/')) throw new Error('Unexpected fixture request: ' + url);
            return new Response(new Uint8Array([137,80,78,71,13,10,26,10]), {headers:{'content-type':'image/png'}});
          };
          PageImageSaverHelpers.saveCaptureDownload = async (_chrome,url,filename) => fixtureDownloads.push({url,filename});
        }''')
        try:
            self.page.locator('#takeover-start-btn').click()
            for _ in range(150):
                run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
                if run['status'] in ['finished_with_gaps','complete','paused']:
                    break
                self.page.wait_for_timeout(100)
            self.assertEqual(run['status'],'finished_with_gaps',run)
            self.assertEqual([row['url'] for row in run['products']],[bra,brief])
            self.assertEqual([row['reason'] for row in run['products']],['exported_unverified','exported_unverified'])
            self.assertEqual(run['listings']['visited'],[])
            self.assertEqual(self.worker.evaluate("fixtureDownloads.filter(x => x.filename.endsWith('/complete.json')).length"),2)
        finally:
            self.worker.evaluate('() => { globalThis.fetch = fixtureFetch; PageImageSaverHelpers.saveCaptureDownload = fixtureSave; }')
            runner_page.close()

    def test_gone_queue_navigates_offline_without_pausing_or_capturing_redirect(self):
        self.open_panel('https://us.chantelle.com/list')
        base = 'https://us.chantelle.com/product/'
        urls = [base + 'gone-first', base + 'old-product', base + 'bra-black'] + [base + f'gone-{i}' for i in range(5)]
        source = json.dumps({'schema_version':1, 'format':'page-image-saver-discovery/v1',
            'mode':'discovery', 'site':'us.chantelle.com',
            'listings':[{'url':'https://us.chantelle.com/list','final_url':'https://us.chantelle.com/list',
                'products':[{'url':url} for url in urls]}]}).encode()
        self.page.locator('#takeover-discovery-files').set_input_files(
            {'name':'discovery-001.json','mimeType':'application/json','buffer':source})
        self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Fixed queue ready')")
        runner_page = self.context.new_page()
        visited = []
        def offline(route):
            url = route.request.url
            if route.request.is_navigation_request():
                visited.append(url)
            if '/gone-' in url:
                route.fulfill(status=404, content_type='text/html', body='<html><body>Gone</body></html>')
            elif url == base + 'old-product':
                route.fulfill(status=200, content_type='text/html', body='<script>location.replace(' + json.dumps(base + 'replacement') + ')</script>')
            else:
                self.route_fixture(route)
        runner_page.route('**/*', offline)
        self.context.set_offline(True)
        runner_page.goto('https://us.chantelle.com/list-runner')
        self.worker.evaluate("""async () => {
          const [tab] = await chrome.tabs.query({url:'https://us.chantelle.com/list-runner'});
          const {catalogTakeoverRun:run} = await chrome.storage.local.get('catalogTakeoverRun');
          run.config.takeover = {intervalMs:0};
          await chrome.storage.local.set({catalogTakeoverRun:run,catalogTakeoverTabId:tab.id});
          globalThis.goneFixtureOriginal = PageImageSaverHelpers.captureWithReceiver;
          globalThis.goneFixtureSettings = await chrome.storage.sync.get('imageUploaderSettings');
          await chrome.storage.sync.set({imageUploaderSettings:{receiver:{enabled:true,
            url:'http://127.0.0.1:8765',token:'offline-test-only'}}});
          globalThis.goneFixtureCaptures = [];
          PageImageSaverHelpers.captureWithReceiver = async (payload, _settings, io) => {
            const identity = payload.identity;
            if (io.verifyOnly) return {storage:'receiver',status:
              goneFixtureCaptures.includes(identity.product_url)?'already':'missing'};
            goneFixtureCaptures.push(identity.product_url);
            return {storage:'receiver',status:'published',identity};
          };
        }""")
        try:
            self.page.locator('#takeover-start-btn').click()
            for _ in range(300):
                run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
                if run['status'] in ['complete','finished_with_gaps','paused']:
                    break
                self.page.wait_for_timeout(100)
            self.assertEqual(run['status'], 'complete', run)
            self.assertEqual([row['url'] for row in run['products']], urls)
            self.assertEqual([row['status'] for row in run['products']], ['skipped','skipped','captured'] + ['skipped']*5)
            self.assertEqual(run['products'][0]['reason'], 'gone: HTTP 404')
            self.assertEqual(run['products'][1]['reason'], 'gone: redirected to ' + base + 'replacement', {'visited':visited,'products':run['products']})
            self.assertEqual(self.worker.evaluate('goneFixtureCaptures'), [base + 'bra-black'])
            self.assertIn(base + 'replacement', visited)
            report = self.worker.evaluate("""async () => PageImageSaverTakeover.exportTakeoverReport(
              (await chrome.storage.local.get('catalogTakeoverRun')).catalogTakeoverRun)""")
            self.assertEqual(report['accounting']['gone'],7)
            self.assertEqual(report['accounting']['skipped'],0)
            self.page.wait_for_function("document.querySelector('#takeover-progress').textContent.includes('gone 7')")
            self.assertIn('All other skips require receiver verification', self.page.locator('#takeover-progress').inner_text())
        finally:
            self.context.set_offline(False)
            self.worker.evaluate('''async () => {
              PageImageSaverHelpers.captureWithReceiver = goneFixtureOriginal;
              await chrome.storage.sync.remove('imageUploaderSettings');
              await chrome.storage.sync.set(goneFixtureSettings);
            }''')
            runner_page.close()

    def test_latest_preview_seed_and_current_discovery_reuse_are_visible(self):
        self.open_panel('https://us.chantelle.com/list-first')
        self.page.locator('#takeover-mode').select_option('discovery')
        self.page.locator('#takeover-preview-btn').click()
        self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Preview ready')")
        self.open_panel('https://us.chantelle.com/list-latest')
        self.page.locator('#takeover-mode').select_option('discovery')
        self.page.locator('#takeover-preview-btn').click()
        self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Preview ready')")
        self.assertEqual(self.page.locator('#takeover-start-url').count(),1)
        self.assertIn('https://us.chantelle.com/list-latest',self.page.locator('#takeover-start-url').inner_text())
        run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
        self.assertEqual([row['url'] for row in run['previews']],['https://us.chantelle.com/list-latest'])
        self.worker.evaluate('''async () => {
          const {catalogTakeoverRun:run} = await chrome.storage.local.get('catalogTakeoverRun');
          run.status='finished_with_gaps'; run.startedAt='2026-10-03T10:00:00.000Z';
          run.listings.visited=[{url:run.seedUrl,final_url:run.seedUrl,
            products:[{url:'https://us.chantelle.com/product/bra-black',card_text:'Bra'}],next_url:null,end:null,endPassed:false}];
          await chrome.storage.local.set({catalogTakeoverRun:run});
        }''')
        self.page.locator('#takeover-reuse-discovery-btn').click()
        self.page.wait_for_function("document.querySelector('#takeover-feedback').textContent.includes('Fixed queue ready')")
        run = self.worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x => x.catalogTakeoverRun)")
        self.assertEqual(run['products'][0]['origins'],[{'run_started_utc':'2026-10-03T10:00:00.000Z',
            'listing_url':'https://us.chantelle.com/list-latest'}])
        self.assertIn('/product/bra-black',self.page.locator('#takeover-start-url').inner_text())


if __name__ == "__main__":
    unittest.main()
