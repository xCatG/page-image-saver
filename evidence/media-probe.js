// Paste in DevTools Console on a Freya PDP after pressing play on any video.
// Read-only: no clicks, fetches, navigation, DOM writes or storage.
// Prints one JSON object; URL queries, fragments and credentials are omitted.
(() => {
  const urlInfo = raw => {
    if (!raw || typeof raw !== 'string') return null;
    try {
      const u = new URL(raw.trim(), document.baseURI);
      return {url: ['http:', 'https:'].includes(u.protocol) ? `${u.protocol}//${u.host}${u.pathname}` : '[non-http URL]',
        hasQuery: !!u.search, hasFragment: !!u.hash, hasCredentials: !!(u.username || u.password)};
    } catch { return {invalid: true}; }
  };
  const mediaLike = raw => {
    try {
      const u = new URL(raw, document.baseURI);
      return /\.(mp4|webm|m3u8|mpd|m4s|ts)$/i.test(u.pathname) ||
        /(^|\.)(vimeo\.com|vimeocdn\.com|youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|brightcove\.com|brightcove\.net|cloudinary\.com|cloudflarestream\.com|videodelivery\.net)$/i.test(u.hostname) ||
        (u.hostname === 'media.freyalingerie.com' && !/\.(jpe?g|png|gif|webp|avif|svg|ico)$/i.test(u.pathname));
    } catch { return false; }
  };
  const videoObjects = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().some(t => /(^|[/#:])VideoObject$/.test(t))) {
      const urls = key => [value[key]].flat().filter(v => typeof v === 'string').map(urlInfo);
      videoObjects.push({type: 'VideoObject', contentUrl: urls('contentUrl'), embedUrl: urls('embedUrl'),
        url: urls('url'), thumbnailUrl: urls('thumbnailUrl')});
    }
    Object.values(value).forEach(walk);
  };
  let invalidJson = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(n => {
    try { walk(JSON.parse(n.textContent)); } catch { invalidJson++; }
  });
  const dataAttributes = [];
  document.querySelectorAll('*').forEach(n => {
    [...n.attributes].filter(a => a.name.startsWith('data-')).forEach(a => {
      const raw = a.value.trim();
      if (mediaLike(raw)) dataAttributes.push({tag: n.tagName.toLowerCase(), attribute: a.name, value: urlInfo(raw)});
      else if (/(video|vimeo|youtube|brightcove|stream)(?:-?id)?$|(?:video|vimeo|youtube|brightcove|stream).*id|id.*(video|vimeo|youtube|stream)/i.test(a.name) &&
          /^[a-z0-9_-]{3,128}$/i.test(raw))
        dataAttributes.push({tag: n.tagName.toLowerCase(), attribute: a.name, id: raw});
    });
  });
  const report = {
    page: urlInfo(location.href),
    resources: performance.getEntriesByType('resource').filter(e => mediaLike(e.name))
      .map(e => ({...urlInfo(e.name), initiatorType: e.initiatorType})),
    elements: [...document.querySelectorAll('video, source, iframe')].map(n => ({tag: n.tagName.toLowerCase(),
      src: urlInfo(n.getAttribute('src')), currentSrc: urlInfo(n.currentSrc), poster: urlInfo(n.getAttribute('poster'))})),
    jsonLd: {invalidJson, videoObjects}, dataAttributes
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
