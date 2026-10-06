const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../extension_helpers.js');
const pattern = 'https://www\\.agentprovocateur\\.com/static/media/catalog/product/[^\\s"<>?#]+\\.(?:jpg|jpeg|png|webp)';
const base = 'https://www.agentprovocateur.com/us_en/example-1';
const original = 'https://www.agentprovocateur.com/static/media/catalog/product/2/8/106604_ecom_1.jpg';
const proxy = 'https://www.agentprovocateur.com/tco-images/unsafe/0x0/filters:quality(80)/' + original;
test('AP originals: direct and proxy use the original without inventing sizes', () => {
  for (const raw of [original, proxy]) assert.equal(h.resolveGalleryOriginal(raw, pattern, base), original);
});
test('AP saved local gallery src resolves only by exact filename evidence', () => {
  assert.equal(h.resolveGalleryOriginal('./Davinah_files/106604_ecom_1.jpg', pattern, base, [proxy]), original);
  assert.throws(() => h.resolveGalleryOriginal('./Davinah_files/missing.jpg', pattern, base, [proxy]), /original/);
  assert.throws(() => h.resolveGalleryOriginal('./Davinah_files/106604_ecom_1.jpg', pattern, base,
    [original, original.replace('/2/8/', '/a/b/')]), /ambiguous/);
});
test('AP resolver rejects unrelated hosts and non-gallery URLs', () => {
  for (const raw of ['https://evil.test/' + original, 'https://www.agentprovocateur.com/logo.svg', 'data:image/png,x'])
    assert.throws(() => h.resolveGalleryOriginal(raw, pattern, base), /original/);
});
