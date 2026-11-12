const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../evidence/media-probe.js'), 'utf8');

test('read-only media probe covers providers, DOM, nested JSON-LD and data attributes; redacts secrets', () => {
  const node = (tagName, attrs = {}, currentSrc) => Object.freeze({tagName, currentSrc,
    attributes: Object.entries(attrs).map(([name, value]) => Object.freeze({name, value})),
    getAttribute: name => attrs[name] || null});
  const video = node('VIDEO', {src: 'blob:private-video', poster: '/poster.jpg?private=secret'},
    'https://user:password@cdn.example/movie.mp4?token=secret#secret');
  const iframe = node('IFRAME', {src: 'https://player.vimeo.com/video/123?secret=secret'});
  const button = node('BUTTON', {'data-video-url': 'https://customer.cloudflarestream.com/id/manifest/video.m3u8?secret=secret',
    'data-video-id': 'abc_123', 'data-vimeo': '123456', 'data-unrelated': 'secret'});
  const scripts = [{textContent: JSON.stringify({'@graph': [{'@type': ['Thing', 'VideoObject'],
    contentUrl: 'https://cdn.example/a.mp4?secret=secret', embedUrl: '/embed?secret=secret',
    thumbnailUrl: ['https://cdn.example/a.jpg#secret'], description: 'secret'}]})}, {textContent: '{broken'}];
  const document = Object.freeze({baseURI: 'https://www.freyalingerie.com/us/en/p/123/',
    querySelectorAll: selector => selector === '*' ? [video, iframe, button] :
      selector === 'video, source, iframe' ? [video, iframe, node('SOURCE', {src: '/a.webm?secret=secret'})] : scripts});
  const urls = ['https://cdn.example/a.mp4?token=secret', 'https://cdn.example/a.webm',
    'https://cdn.example/a.m3u8', 'https://cdn.example/a.mpd', 'https://cdn.example/a.m4s', 'https://cdn.example/a.ts',
    'https://player.vimeo.com/video/123', 'https://a.vimeocdn.com/segment', 'https://www.youtube.com/embed/id',
    'https://i.ytimg.com/vi/id/default.jpg', 'https://players.brightcove.net/player',
    'https://res.cloudinary.com/video/upload/id', 'https://media.freyalingerie.com/medias/opaque',
    'https://customer.cloudflarestream.com/opaque', 'https://videodelivery.net/opaque',
    'https://media.freyalingerie.com/medias/photo.jpg?secret=secret', 'https://cdn.example/main.js'];
  const logs = [];
  const forbidden = () => { throw new Error('unexpected side effect'); };
  const rawReport = vm.runInNewContext(source, {URL, document, location: {href: document.baseURI + '?secret=secret'},
    performance: {getEntriesByType: type => {
      assert.equal(type, 'resource');
      return urls.map(name => ({name, initiatorType: 'video'}));
    }}, console: {log: value => logs.push(value)}, fetch: forbidden, localStorage: new Proxy({}, {get: forbidden}),
    sessionStorage: new Proxy({}, {get: forbidden})});
  const report = JSON.parse(JSON.stringify(rawReport));
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), report);
  assert.equal(report.resources.length, 15);
  assert.ok(report.resources.every(r => r.initiatorType === 'video'));
  assert.equal(report.elements.length, 3);
  assert.equal(report.elements[0].src.url, '[non-http URL]');
  assert.equal(report.elements[0].currentSrc.url, 'https://cdn.example/movie.mp4');
  assert.equal(report.elements[0].currentSrc.hasCredentials, true);
  assert.equal(report.elements[0].poster.hasQuery, true);
  assert.equal(report.jsonLd.invalidJson, 1);
  assert.equal(report.jsonLd.videoObjects.length, 1);
  assert.equal(report.jsonLd.videoObjects[0].contentUrl[0].url, 'https://cdn.example/a.mp4');
  assert.equal(report.dataAttributes.length, 3);
  assert.equal(report.dataAttributes[1].id, 'abc_123');
  assert.doesNotMatch(logs[0], /secret|password|user:|private-video/);
});
