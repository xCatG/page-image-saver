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
test('AP malformed candidate reports gallery step and truncated offending input', () => {
  assert.throws(() => h.resolveGalleryOriginal('https://[bad/' + 'x'.repeat(500), pattern, base), error =>
    /gallery original/.test(error.message) && /https:\/\/\[bad/.test(error.message) && error.message.length < 250);
});
test('AP proxy resolves encoded and scheme-less originals against the page origin', () => {
  for (const value of [encodeURIComponent(original), original.replace('https:', ''), original.replace('https://', '')]) {
    assert.equal(h.resolveGalleryOriginal('/tco-images/unsafe/0x0/' + value, pattern, base), original);
  }
  assert.equal(h.resolveGalleryOriginal(original.replace('https:', ''), pattern, base), original);
  assert.equal(h.resolveGalleryOriginal(new URL(original).pathname, pattern, base), original);
});
