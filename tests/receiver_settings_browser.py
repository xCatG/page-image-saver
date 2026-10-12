"""Exercise options -> installed service worker -> real, temporary local receiver.

PYTHONPATH=/home/yenchi/src/lingerie_trends python tests/receiver_settings_browser.py
"""
import os
import sys
import socket
import threading
import tempfile
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from catalog_preview_extension_browser import CHROMIUM, ROOT

sys.path.insert(0, os.environ.get('LINGERIE_TRENDS_ROOT', '/home/yenchi/src/lingerie_trends'))
from lingerie_trends.catalog_capture_receiver import CaptureReceiver, ReceiverHandler


class ReceiverOptionsBrowser(unittest.TestCase):
    def test_local_receiver_and_form(self):
        if not CHROMIUM:
            self.fail('Chromium required')
        with tempfile.TemporaryDirectory() as profile, tempfile.TemporaryDirectory() as capture_root, sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(profile, headless=True, executable_path=CHROMIUM,
                args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'])
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                origin = worker.url.split('/background.js')[0]
                seen = []
                class ObservedReceiver(ReceiverHandler):
                    def do_POST(self):
                        seen.append((self.command, self.path, self.headers.get('Origin')))
                        super().do_POST()
                server = ThreadingHTTPServer(('127.0.0.1', 0), ObservedReceiver)
                server.app = CaptureReceiver(Path(capture_root), token='browser-test-only', extension_origin=origin)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    page = context.new_page()
                    page.goto(origin + '/settings.html')
                    page.wait_for_function("() => document.querySelector('#concurrent-uploads').value !== ''")
                    page.locator('#receiver-enabled').check()
                    page.locator('#receiver-url').fill('')
                    page.locator('#receiver-token').fill('')
                    page.locator('#s3-bucket').fill('unchanged-form-value')
                    page.locator('#settings-form').evaluate("f => f.requestSubmit()")
                    self.assertIn('URL invalid', page.locator('#receiver-url-error').inner_text())
                    self.assertIn('token', page.locator('#receiver-token-error').inner_text())
                    self.assertEqual(page.locator('#s3-bucket').input_value(), 'unchanged-form-value')
                    initial = worker.evaluate("chrome.storage.sync.get('imageUploaderSettings')")
                    url = f'http://127.0.0.1:{server.server_port}'
                    def probe(address, token):
                        page.locator('#receiver-url').fill(address)
                        page.locator('#receiver-token').fill(token)
                        page.locator('#test-connection').click()
                        page.wait_for_function("() => !document.querySelector('#status-message').textContent.includes('Testing connection')")
                        return page.locator('#status-message').inner_text()
                    self.assertIn('token accepted', probe(url, 'browser-test-only'))
                    self.assertEqual(seen[-1], ('POST', '/v1/already', origin))
                    self.assertIn('token rejected', probe(url, 'wrong-test-token'))
                    server.app.origin = 'chrome-extension://' + 'a' * 32
                    msg = probe(url, 'browser-test-only')
                    self.assertTrue('origin rejected' in msg or 'CORS' in msg, msg)
                    self.assertIn('--extension-origin', msg)
                    self.assertIn(origin, msg)
                    with socket.socket() as sock:
                        sock.bind(('127.0.0.1', 0))
                        unavailable = f'http://127.0.0.1:{sock.getsockname()[1]}'
                    msg = probe(unavailable, 'browser-test-only')
                    self.assertIn('unreachable', msg)
                    self.assertIn(unavailable, msg)
                    self.assertEqual(list(Path(capture_root).rglob('*')), [])
                    self.assertEqual(worker.evaluate("chrome.storage.sync.get('imageUploaderSettings')"), initial)
                    page.locator('#receiver-enabled').uncheck()
                    page.locator('#receiver-url').fill('bad url')
                    page.locator('#receiver-token').fill('')
                    page.locator('#settings-form').evaluate("f => f.requestSubmit()")
                    page.wait_for_function("() => document.querySelector('#status-message').textContent.includes('Settings saved')")
                    self.assertFalse(worker.evaluate("chrome.storage.sync.get('imageUploaderSettings').then(x => x.imageUploaderSettings.receiver.enabled)"))
                finally:
                    server.shutdown(); server.server_close(); thread.join()
            finally:
                context.close()

if __name__ == '__main__':
    unittest.main()
