const test = require('node:test');
const assert = require('node:assert/strict');
const {victoriasSecretImage} = require('../extension_helpers');
const root = 'https://www.victoriassecret.com/p/';
test('largest evidenced rendition of the same photo, never a recommendation', () => {
  assert.equal(victoriasSecretImage('./saved_files/photo.jpg', [
    root+'760x1013/png/zz/26/photo.jpg', root+'1000x1333/png/zz/26/photo.jpg',
    root+'1520x2026/png/zz/26/other.jpg']), root+'1000x1333/png/zz/26/photo.jpg');
});
test('local filename without URL evidence fails closed', () => {
  assert.throws(() => victoriasSecretImage('./saved_files/photo.jpg', []), /evidenced/);
});
test('foreign sources do not become same-host originals', () => {
  assert.throws(() => victoriasSecretImage('https://evil.test/photo.jpg', [root+'760x1013/png/zz/26/photo.jpg']), /host/);
});

test('Adaptive gallery accepts the evidenced tif rendition path without rewriting it', () => {
  const url = 'https://www.victoriassecret.com/p/760x1013/tif/zz/23/08/02/02/1121720633F6_OM_F.jpg';
  assert.equal(require('../extension_helpers.js').victoriasSecretImage('./saved_files/1121720633F6_OM_F.jpg', [url]), url);
});
