"""Persistent-profile upgrade regression using complete historical/current production workers.

Requires repository history at 4e58f9c (the release before fixed-queue imports).
Run: uv run --offline --with playwright python tests/catalog_worker_upgrade_browser.py
"""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OLD_RELEASE = '4e58f9c2dab9408987f3db2a0122af3aabf8e3a0'


class CatalogWorkerUpgradeTest(unittest.TestCase):
    def test_stale_profile_explains_reload_and_explicit_reload_restores_import(self):
        with tempfile.TemporaryDirectory(prefix='pis-worker-upgrade-') as temporary, sync_playwright() as pw:
            directory = Path(temporary)
            extension = directory / 'extension'
            shutil.copytree(ROOT, extension, ignore=shutil.ignore_patterns('.git', '__pycache__'))
            release_files = ['manifest.json', 'background.js', 'content_script.js',
                             'takeover_runner.js', 'extension_helpers.js']
            for filename in release_files:
                (extension / filename).write_bytes(subprocess.check_output(
                    ['git', 'show', f'{OLD_RELEASE}:{filename}'], cwd=ROOT))
            # Keep identity constant: this tests a worker upgrade, not installing
            # a new extension ID when a manifest key is introduced.
            old_manifest = json.loads((extension / 'manifest.json').read_text())
            current_manifest = json.loads((ROOT / 'manifest.json').read_text())
            if 'key' in current_manifest:
                old_manifest['key'] = current_manifest['key']
            (extension / 'manifest.json').write_text(json.dumps(old_manifest))

            def launch():
                return pw.chromium.launch_persistent_context(str(directory / 'profile'), headless=True,
                    executable_path=pw.chromium.executable_path,
                    args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])

            context = launch()
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                self.assertEqual(worker.evaluate('chrome.runtime.getManifest().version'), '1.0')
            finally:
                context.close()

            # Update the same unpacked path, then reopen the very same browser profile.
            for filename in release_files:
                shutil.copyfile(ROOT / filename, extension / filename)
            context = launch()
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                page = context.new_page()
                def route_fixture(route):
                    if route.request.url.startswith('chrome-extension://'):
                        route.continue_()
                    elif route.request.url.startswith('https://us.chantelle.com/'):
                        route.fulfill(content_type='text/html', body='''<html><body>
                          <a class="product-card__link" href="/product/fixture">Fixture</a></body></html>''')
                    else:
                        route.abort()
                page.route('**/*', route_fixture)
                page.goto('https://us.chantelle.com/list')
                def open_panel(current_worker):
                    current_worker.evaluate('''async () => {
                      const [tab] = await chrome.tabs.query({url:'https://us.chantelle.com/list'});
                      for (let attempt = 0; attempt < 30; attempt++) {
                        try { return await chrome.tabs.sendMessage(tab.id,{action:'findImages'}); }
                        catch (error) {
                          if (!String(error).includes('Receiving end does not exist') || attempt===29) throw error;
                          await new Promise(resolve => setTimeout(resolve,100));
                        }
                      }
                    }''')
                    page.wait_for_selector('#takeover-discovery-files', state='attached')
                open_panel(worker)
                product_url = 'https://us.chantelle.com/product/fixture'
                source = {'format':'page-image-saver-discovery/v1', 'schema_version':1,
                          'mode':'discovery', 'site':'us.chantelle.com', 'listings':[{
                              'url':'https://us.chantelle.com/list', 'final_url':'https://us.chantelle.com/list',
                              'products':[{'url':product_url, 'card_text':'Fixture'}]}]}
                file_payload = {'name':'discovery.json', 'mimeType':'application/json', 'buffer':json.dumps(source).encode()}
                page.set_input_files('#takeover-discovery-files', file_payload)
                page.wait_for_function('''() => /Fixed queue ready|Discovery import failed/.test(
                  document.querySelector('#takeover-feedback').textContent)''')
                self.assertIn('Reload the extension', page.locator('#takeover-feedback').text_content())
                self.assertIsNone(worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x=>x.catalogTakeoverRun || null)"))

                # The explicit extension reload models the owner's Reload action. Never auto-reload a run.
                worker.evaluate('() => { chrome.runtime.reload(); }')
                # Command-line unpacked extension reload need not emit another Playwright
                # serviceworker event in this context. Reopen the same profile after reload.
                context.close()
                context = launch()
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                page = context.new_page()
                page.route('**/*', route_fixture)
                page.goto('https://us.chantelle.com/list')
                open_panel(worker)
                page.set_input_files('#takeover-discovery-files', file_payload)
                page.wait_for_function('''() => /Fixed queue ready|Discovery import failed/.test(
                  document.querySelector('#takeover-feedback').textContent)''')
                self.assertIn('Fixed queue ready', page.locator('#takeover-feedback').text_content())
                run = worker.evaluate("chrome.storage.local.get('catalogTakeoverRun').then(x=>x.catalogTakeoverRun)")
                self.assertEqual(run['mode'], 'capture-discovery')
                self.assertEqual([row['url'] for row in run['products']], [product_url])
            finally:
                context.close()


if __name__ == '__main__':
    unittest.main()
