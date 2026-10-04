"""Real IntersectionObserver regression: no hover or synthetic mouse events."""
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class LazyGalleryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def fixture(self):
        page = self.browser.new_page(viewport={"width": 900, "height": 600})
        page.set_content(''.join('<div class="frame--blurring" style="height:900px">'
                                '<img class="gallery" width="300" height="400"></div>' for _ in range(4)))
        page.add_script_tag(path=str(ROOT / 'extension_helpers.js'))
        page.evaluate('''() => {
          window.mouseEvents = 0;
          document.addEventListener('mouseover', () => mouseEvents++);
          window.config = {product: {lazyLoad: true, allImagesSelector: 'img.gallery',
            imageUrlPattern: 'imagedelivery\\\\.net/'}};
          const observer = new IntersectionObserver(entries => entries.forEach(entry => {
            if (entry.isIntersecting) {
              entry.target.src = 'https://imagedelivery.net/image/' + [...document.images].indexOf(entry.target);
              entry.target.parentElement.classList.remove('frame--blurring');
            }
          }));
          window.fixtureObserver = observer;
          document.querySelectorAll('img').forEach(img => observer.observe(img));
        }''')
        return page

    def test_scroll_prepares_every_frame_without_mouse(self):
        page = self.fixture()
        try:
            result = page.evaluate('''async () => {
              if (!PageImageSaverHelpers.prepareLazyGallery) return {missing: true};
              await PageImageSaverHelpers.prepareLazyGallery(config, document, {timeoutMs: 2500, pollMs: 40});
              return {ready: [...document.images].filter(img => img.src.includes('imagedelivery.net')).length,
                blurred: document.querySelectorAll('[class*="--blurring"]').length, mouse: mouseEvents};
            }''')
            self.assertEqual(result, {"ready": 4, "blurred": 0, "mouse": 0})
        finally:
            page.close()

    def test_loaded_image_in_frame_that_keeps_blurring_is_ready(self):
        # Chantelle leaves --blurring on some frames after their image has loaded.
        page = self.browser.new_page(viewport={"width": 900, "height": 600})
        try:
            pixel = ("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            page.set_content(''.join(f'<div class="frame--blurring"><img class="gallery" src="{pixel}"></div>'
                                     for _ in range(2)))
            page.add_script_tag(path=str(ROOT / 'extension_helpers.js'))
            page.wait_for_function("[...document.images].every(i => i.complete && i.naturalWidth > 0)")
            result = page.evaluate("""async () => {
              await PageImageSaverHelpers.prepareLazyGallery({product: {lazyLoad: true,
                allImagesSelector: 'img.gallery', imageUrlPattern: '^data:image/gif'}}, document,
                {timeoutMs: 1500, pollMs: 40});
              return document.querySelectorAll('[class*="--blurring"]').length;
            }""")
            self.assertEqual(result, 2)  # resolved without waiting for the class to go
        finally:
            page.close()

    def test_shortfall_rejects_and_nonlazy_is_untouched(self):
        page = self.fixture()
        try:
            result = page.evaluate('''async () => {
              if (!PageImageSaverHelpers.prepareLazyGallery) return 'missing';
              config.product.lazyLoad = false;
              await PageImageSaverHelpers.prepareLazyGallery(config, document);
              if (scrollY !== 0) return 'nonlazy scrolled';
              config.product.lazyLoad = true;
              config.product.imageUrlPattern = 'never-matches';
              try { await PageImageSaverHelpers.prepareLazyGallery(config, document, {timeoutMs: 250, pollMs: 20}); }
              catch (error) { return error.message; }
              return 'silently accepted partial gallery';
            }''')
            self.assertRegex(result, r'Lazy gallery shortfall: 0/4')
        finally:
            page.close()

    def test_manual_and_takeover_capture_rescan_after_preparation(self):
        source = (ROOT / 'content_script.js').read_text()
        capture = source[source.index('function rescanCaptureImages('):source.index('function takeoverRequest(')]
        for manual in [True, False]:
            page = self.fixture()
            try:
                page.add_script_tag(content='''
                  const assertTakeoverBinding = () => {};
                  const loadCaptureSiteConfig = async () => config;
                  let currentFilteredImages = [];
                  let rescanned = 0;
                  const findAllImages = () => { rescanned = [...document.images].filter(img => img.src.includes('imagedelivery.net')).length; };
                  PageImageSaverHelpers.waitForCaptureState = async () => { throw new Error('ready:' + rescanned); };
                  const captureCanonicalUrl = () => 'https://example.test/product';
                  const previousCaptureStates = new Map();
                ''' + capture)
                page.evaluate('''() => {
                  const control = document.createElement('select'); control.id = 'capture-image-mode';
                  control.innerHTML = '<option value="site">site</option>'; document.body.append(control);
                  const policy = control.cloneNode(true); policy.id = 'capture-color-policy'; document.body.append(policy);
                }''')
                result = page.evaluate('''async manual => {
                  try { await captureCurrentProduct({manual}); } catch (error) { return error.message; }
                }''', manual)
                self.assertEqual(result, 'ready:4')
            finally:
                page.close()

    def test_lazy_site_capture_uses_the_validated_source_not_stale_data_src(self):
        page = self.fixture()
        source = (ROOT / 'content_script.js').read_text()
        page.add_script_tag(content=source[source.index('function captureGallery('):source.index('function captureSwatchColor(')])
        try:
            urls = page.evaluate('''async () => {
              document.querySelectorAll('img').forEach(img => img.dataset.src = 'https://example.test/placeholder');
              await PageImageSaverHelpers.prepareLazyGallery(config, document, {pollMs: 40});
              return captureGallery(config, 'site');
            }''')
            self.assertEqual(urls, [f'https://imagedelivery.net/image/{i}' for i in range(4)])
        finally:
            page.close()

    def test_selected_urls_survive_rescan_reordering(self):
        page = self.fixture()
        source = (ROOT / 'content_script.js').read_text()
        begin = source.find('function rescanCaptureImages(')
        if begin < 0:
            begin = source.index('async function captureCurrentProduct(')
        capture = source[begin:source.index('function takeoverRequest(')]
        gallery = source[source.index('function captureGallery('):source.index('function captureSwatchColor(')]
        try:
            page.add_script_tag(content='''
              let currentFilteredImages = [{url:'https://example.test/chosen'}, {url:'https://example.test/other'}];
              const assertTakeoverBinding = () => {};
              const loadCaptureSiteConfig = async () => config;
              const findAllImages = () => { currentFilteredImages = [{url:'https://example.test/new'}, ...currentFilteredImages]; };
              const capturePageProduct = () => ({color:'Black'});
              const captureSwatchColor = () => 'Black';
              const captureSelectedColor = () => 'Black';
              const captureCanonicalUrl = () => 'https://example.test/product';
              const previousCaptureStates = new Map();
              PageImageSaverHelpers.waitForCaptureState = async read => { throw new Error(read().gallery.join(',')); };
            ''' + gallery + capture)
            page.evaluate('''() => {
              const panel = document.createElement('div'); panel.id = 'image-selector-container';
              panel.innerHTML = '<select id="capture-image-mode"><option value="selected">selected</option></select>' +
                '<select id="capture-color-policy"><option value="url">url</option></select>' +
                '<input type="checkbox" data-index="0" checked>';
              document.body.append(panel);
            }''')
            result = page.evaluate('''async () => {
              try { await captureCurrentProduct({manual:true}); }
              catch (error) { return {captured: error.message, displayed: captureGallery(config, 'selected')}; }
            }''')
            self.assertEqual(result, {'captured': 'https://example.test/chosen', 'displayed': ['https://example.test/chosen']})
        finally:
            page.close()

    def test_stable_src_wins_over_responsive_candidate_for_readiness_and_high_res(self):
        page = self.fixture()
        source = (ROOT / 'content_script.js').read_text()
        page.add_script_tag(content=source[source.index('function captureGallery('):source.index('function captureSwatchColor(')])
        page.route('https://imagedelivery.net/**', lambda route: route.fulfill(
            content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))
        try:
            page.evaluate('''() => {
              fixtureObserver.disconnect();
              document.querySelectorAll('img').forEach((img, i) => {
                img.src = 'https://imagedelivery.net/stable/' + i + '/w=1024';
                img.srcset = 'https://imagedelivery.net/responsive/' + i + '/w=640 1x';
                img.parentElement.classList.remove('frame--blurring');
              });
              config.product.imageUrlPattern = '/w=1024$';
            }''')
            page.wait_for_function("[...document.images].every(img => img.currentSrc.endsWith('/w=640'))")
            result = page.evaluate('''async () => {
              try {
                await PageImageSaverHelpers.prepareLazyGallery(config, document, {timeoutMs:250, pollMs:20});
                return captureGallery(config, 'site').map(url => PageImageSaverHelpers.captureImageUrls(
                  url, {find:'/w=1024', replace:'/w=2048'}));
              } catch (error) { return error.message; }
            }''')
            self.assertEqual(result, [{'original_url': f'https://imagedelivery.net/stable/{i}/w=1024',
                                       'fetched_url': f'https://imagedelivery.net/stable/{i}/w=2048'} for i in range(4)])
        finally:
            page.close()

if __name__ == '__main__':
    unittest.main()
