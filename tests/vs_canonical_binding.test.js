const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('../extension_helpers');
const queued = 'https://www.victoriassecret.com/us/pink/panties-catalog/5000005293/-/a/generic-11291842-choice-72ZS/plush-touch-boyshort-panty-green';
const canonical = queued.replace('/plush-touch-boyshort', '/plush-touch-velour-boyshort');
const source = fs.readFileSync(require.resolve('../content_script.js'), 'utf8');
function page() {
  const state = {canonical, payload: null};
  const sandbox = {URL, Map, Date, window: {location: {href: queued, hostname: 'www.victoriassecret.com'}},
    document: {querySelector: () => ({href: state.canonical})}, takeoverDocumentId: 'doc',
    loadCaptureSiteConfig: async () => ({colorVariantStrategy: 'separate-url'}),
    capturePageProduct: () => ({name: 'Plush Touch Velour Boyshort Panty'}),
    captureGallery: () => ['https://www.victoriassecret.com/p/1000x1333/png/zz/26/10/06/03/1129184272ZS_OM_F.jpg'],
    captureSwatchColor: () => null, captureSelectedColor: () => 'Pretty Mint Confetti Velour',
    previousCaptureStates: new Map(), capturePageProductEvidence: () => ({facts: {name: 'Plush Touch Velour Boyshort Panty'}}),
    PageImageSaverHelpers: {...helpers, waitForCaptureState: async read => read()},
    chrome: {runtime: {sendMessage: (message, cb) => {state.payload = message.payload; cb({success: true});}}}};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source.slice(source.indexOf('function captureCanonicalUrl('), source.indexOf('function takeoverRequest(')), sandbox);
  sandbox.capturePageHtml = () => '<html></html>';
  return {sandbox, state, binding: {documentId: 'doc', documentUrl: queued, expectedUrl: queued}};
}
test('renamed VS canonical slug captures with the original queued receiver identity', async () => {
  const {sandbox, state, binding} = page();
  const result = await sandbox.captureCurrentProduct({manual: false, binding});
  assert.equal(state.payload.identity.product_url, queued);
  assert.equal(result.identity.product_url, queued);
  assert.equal(result.identity.color_key, 'url');
});
for (const [label, changed] of [
  ['generic id', canonical.replace('generic-11291842', 'generic-99999999')],
  ['host', canonical.replace('www.victoriassecret.com', 'evil.test')],
  ['catalog id', canonical.replace('5000005293', '5000000000')],
  ['query', canonical + '?choice=OTHER'],
  ['protocol', canonical.replace('https:', 'http:')],
]) test(`reject changed canonical ${label}`, () => {
  const {sandbox, state, binding} = page(); state.canonical = changed;
  assert.throws(() => sandbox.assertTakeoverBinding(binding), /URL changed/);
});
test('renamed canonical does not relax the bound window URL or document id', () => {
  const {sandbox, binding} = page();
  sandbox.window.location.href = canonical;
  assert.throws(() => sandbox.assertTakeoverBinding(binding), /URL changed/);
  sandbox.window.location.href = queued;
  assert.throws(() => sandbox.assertTakeoverBinding({...binding, documentId: 'other'}), /URL changed/);
});
test('non-VS canonical slug changes remain rejected', () => {
  const {sandbox, state, binding} = page();
  const other = queued.replace('www.victoriassecret.com', 'shop.example.test');
  sandbox.window.location = {href: other, hostname: 'shop.example.test'};
  state.canonical = canonical.replace('www.victoriassecret.com', 'shop.example.test');
  assert.throws(() => sandbox.assertTakeoverBinding({...binding, expectedUrl: other, documentUrl: other}), /URL changed/);
});

for (const fixture of require('./fixtures/vs-unavailable-choices.json')) {
  test(`unavailable saved choice ${fixture.alert} never captures its substitute`, async () => {
    const {sandbox, state, binding} = page();
    sandbox.window.location.href = fixture.queued;
    state.canonical = fixture.canonical;
    binding.expectedUrl = binding.documentUrl = fixture.queued;
    await assert.rejects(sandbox.captureCurrentProduct({manual: false, binding}), /choice unavailable in region:/);
    assert.equal(state.payload, null);
  });
}
test('binding diagnostics distinguish document, location, and canonical with observed values', () => {
  const {sandbox, state, binding} = page();
  assert.throws(() => sandbox.assertTakeoverBinding({...binding, documentId: 'old'}), /URL changed: document id doc vs old/);
  sandbox.window.location.href = canonical;
  assert.throws(() => sandbox.assertTakeoverBinding(binding), e => e.message.includes(`location ${canonical} vs ${queued}`));
  sandbox.window.location.href = queued; state.canonical = canonical.replace('11291842','99999999');
  assert.throws(() => sandbox.assertTakeoverBinding(binding), e => e.message.includes(`canonical ${state.canonical} vs ${queued}`));
});
test('unavailable alert must name the queued choice; foreign products and hosts are not gone', () => {
  const f = require('./fixtures/vs-unavailable-choices.json')[0];
  assert.match(helpers.victoriasSecretUnavailableChoice(f.queued, f.queued, f.alert), /choice unavailable in region:/);
  assert.equal(helpers.victoriasSecretUnavailableChoice(f.queued, f.queued, 'Item unavailable in OTHER'), null);
  assert.equal(helpers.victoriasSecretUnavailableChoice(f.queued, f.canonical.replace('generic-11285761','generic-99999999')), null);
  assert.equal(helpers.victoriasSecretUnavailableChoice(f.queued, f.canonical.replace('www.victoriassecret.com','evil.test')), null);
});

for (const fixture of require('./fixtures/vs-unavailable-choices.json')) test(`inspection recognizes ${fixture.alert} before waiting for gallery`, async () => {
  const {sandbox, state} = page();
  sandbox.window.location.href = fixture.queued;
  state.canonical = fixture.canonical;
  sandbox.document = {title: '', body: {innerText: fixture.alert},
    querySelector: selector => selector.includes('canonical') ? {href: fixture.canonical} : null,
    querySelectorAll: () => [{textContent: fixture.alert}]};
  sandbox.capturePageProduct = () => {throw Error('must not acquire substitute product');};
  vm.runInNewContext(source.slice(source.indexOf('async function inspectTakeoverPage('), source.indexOf('// A site must be explicitly enabled')), sandbox);
  const result = await sandbox.inspectTakeoverPage({}, 'capture', 'product');
  assert.match(result.goneReason, /choice unavailable in region:/);
  assert.equal(result.url, fixture.queued);
  assert.equal(state.payload, null);
});
