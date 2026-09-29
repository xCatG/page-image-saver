/* Durable, single-run catalog navigation. Browser operations are injected so the
 * same state machine can be exercised without a vendor or receiver connection. */
(function(root) {
  'use strict';
  const KEY_VERSION = 1;
  const MAX_LISTINGS = 1000;
  const MAX_PRODUCTS = 10000;
  let inFlight = null;

  function canonical(value, domain) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== domain ||
        url.username || url.password) throw new Error('URL is outside the configured site');
    url.hash = '';
    return url.href;
  }

  function classifyTakeoverScope(product) {
    const name = String(product?.name || '').trim();
    const category = String(product?.category || '').trim();
    const evidence = category.toLowerCase();
    const title = name.toLowerCase();
    const excluded = /\b(swimwear|bikini|maillot de bain|sleepwear|nightwear|pyjamas?|pajamas?|menswear|men's|men’s|ready.to.wear|apparel)\b/i.test(evidence);
    const intimate = /\b(lingerie|bras?|sports? bras?|panties|briefs|thongs|corsets?|bodies|bodysuits?|culottes?|soutiens?.gorge)\b/i.test(`${evidence} ${title}`);
    if (excluded && !intimate) return {decision: 'exclude', reason: `category evidence: ${category}`};
    if (excluded) return {decision: 'review', reason: `mixed category and product evidence: ${category}; ${name}`};
    if (intimate) return {decision: 'include', reason: `product evidence: ${category || name}`};
    return {decision: 'review', reason: 'insufficient product/category evidence'};
  }

  function summarizeTakeover(run) {
    const products = run?.products || [];
    const captured = products.filter(item => item.status === 'captured').length;
    return {listingPagesVisited: run?.listings?.visited?.length || 0,
      productsFound: products.length, productsCaptured: captured,
      colorsCaptured: captured, sizeOptionsTraversed: 0,
      excluded: products.filter(item => item.status === 'excluded').length,
      failed: products.filter(item => item.status === 'failed').length,
      pending: products.filter(item => item.status === 'pending').length,
      exportedUnverified: products.filter(item => item.status === 'failed' && item.reason === 'exported_unverified').length};
  }

  function exportTakeoverReport(run) {
    if (!run || run.version !== KEY_VERSION) throw new Error('no saved catalog run to export');
    return {...run, schema_version: 1, format: 'page-image-saver-takeover-run/v1',
      accounting: summarizeTakeover(run)};
  }

  function endCheckPasses(config, page, visited, productCount) {
    const expected = config.listing?.endCheck;
    const observed = page.end;
    if (!expected || !observed || observed.type !== expected.type) return false;
    if (expected.type === 'explicit') return observed.present === true;
    if (expected.type === 'page-count') return Number.isSafeInteger(observed.total) &&
      observed.total > 0 && visited.length === observed.total &&
      visited.every((entry, index) => entry.end?.type === 'page-count' &&
        entry.end.current === index + 1 && entry.end.total === observed.total);
    if (expected.type === 'result-total') return Number.isSafeInteger(observed.total) &&
      observed.total > 0 && productCount === observed.total &&
      visited.every(entry => entry.end?.type === 'result-total' && entry.end.total === observed.total);
    return false;
  }

  function createTakeoverRunner(io) {
    async function save(run) { await io.save(run); return run; }
    async function read() { return io.read(); }
    async function preview(config, page) {
      if (!config?.domain || !config.listing?.productLinkSelector || !config.listing?.pagination?.nextSelector)
        throw new Error('site needs explicit listing selectors');
      if (config.colorVariantStrategy !== 'separate-url')
        throw new Error('take-over currently requires separate-URL color identity');
      if (page?.kind !== 'listing' && page?.kind !== 'product') throw new Error('preview needs a listing or product page');
      const existing = await read();
      if (['running', 'paused'].includes(existing?.status))
        throw new Error('stop or finish the current run before previewing a new one');
      const domain = config.domain.toLowerCase();
      const url = canonical(page.url, domain);
      const previews = existing?.status === 'preview' && existing.domain === domain ? existing.previews : [];
      const entry = {url, kind: page.kind, products: page.kind === 'listing' ? page.products.length : undefined,
        next: page.next || null, end: page.end || null, product: page.product || null,
        imageCount: page.kind === 'product' ? page.imageCount : undefined,
        colorLinks: page.kind === 'product' ? (page.colorLinks || []).length : undefined,
        scope: page.kind === 'product' ? classifyTakeoverScope(page.product) : undefined};
      const run = {version: KEY_VERSION, generation: (existing?.generation || 0) + 1,
        status: 'preview', domain, config, previews: [...previews.filter(x => x.url !== url), entry],
        preview: {endCheckConfigured: !!config.listing.endCheck,
          receiverRequired: 'Verified skip and catalog completion require a configured reachable local receiver.'},
        seedUrl: page.kind === 'listing' ? url :
          existing?.status === 'preview' && existing.domain === domain ? existing.seedUrl : null,
        listings: {queue: [], visited: [], discoveryComplete: false}, products: [],
        current: null, lastNavigationStarted: null, loadFailures: {}, reason: null};
      return save(run);
    }
    async function start() {
      const run = await read();
      if (!run || run.status !== 'preview' || !run.seedUrl) throw new Error('preview a listing before Take over');
      if (!run.previews.some(page => page.kind === 'product' && page.imageCount > 0))
        throw new Error('preview a product page with gallery images before Take over');
      run.status = 'running';
      run.listings.queue = [run.seedUrl];
      run.startedAt = new Date(io.now()).toISOString();
      await save(run);
      await io.alarm(io.now() + 30000);
      return run;
    }
    async function pause(reason = 'paused by user') {
      const run = await read();
      if (run?.status === 'running') {
        run.status = 'paused'; run.reason = reason; await save(run); await io.clearAlarm?.();
      }
      return run;
    }
    async function stop() {
      const run = await read();
      if (run && ['running', 'paused', 'preview'].includes(run.status)) {
        run.status = 'stopped'; run.reason = 'stopped by user'; await save(run);
        await io.clearAlarm?.();
      }
      return run;
    }
    async function resume() {
      const run = await read();
      if (run?.status !== 'paused') throw new Error('only a paused run can resume');
      run.status = 'running'; run.reason = null;
      await save(run);
      await io.alarm(io.now() + 30000);
      return run;
    }
    async function interrupt(run, status, reason) {
      const current = await read();
      if (current?.status !== 'running' || current.generation !== run.generation) return current;
      run.status = status; run.reason = reason; run.current = null;
      await save(run);
      await io.clearAlarm?.();
      await io.notify(reason);
      return run;
    }
    async function tickUnlocked() {
      const run = await read();
      if (!run || run.status !== 'running') return run;
      const interval = Number.isFinite(run.config.takeover?.intervalMs) ?
        run.config.takeover.intervalMs : 10000;
      if (interval < 0 || interval > 300000) return interrupt(run, 'paused', 'invalid site pacing interval');
      const due = (run.lastNavigationStarted || 0) + interval;
      if (run.lastNavigationStarted !== null && io.now() < due) {
        await io.alarm(due); return run;
      }
      const listingUrl = run.listings.queue[0];
      const item = !listingUrl ? run.products.find(row => row.status === 'pending') : null;
      if (!listingUrl && !item) {
        run.status = run.listings.discoveryComplete && !run.products.some(row => row.status === 'failed') ?
          'complete' : 'finished_with_gaps';
        run.reason = run.status === 'complete' ? null : 'unverified or failed products remain';
        run.current = null;
        await save(run);
        await io.clearAlarm?.();
        return run;
      }
      const url = listingUrl || item.url;
      run.current = {phase: listingUrl ? 'listing' : 'product', url};
      run.lastNavigationStarted = io.now();
      await save(run); // Intent and pace precede browser navigation.
      await io.alarm(io.now() + 30000); // Repeating alarm revives a terminated MV3 worker.
      let page;
      try { page = await io.load(url); }
      catch (error) { page = {status: 0, error: String(error?.message || error)}; }
      const afterLoad = await read();
      if (afterLoad?.status !== 'running' || afterLoad.generation !== run.generation) return afterLoad;
      if (page?.status === 403 || page?.status === 429 || page?.kind === 'challenge') {
        return interrupt(run, 'paused', `challenge or HTTP ${page?.status || 'unknown'} at ${url}`);
      }
      if (!page || page.status === 0 || page.status >= 400 || !['listing', 'product'].includes(page.kind)) {
        run.loadFailures[url] = (run.loadFailures[url] || 0) + 1;
        run.current = null;
        await save(run);
        if (run.loadFailures[url] >= 3) return interrupt(run, 'paused', `repeated page load failure at ${url}`);
        await io.alarm(run.lastNavigationStarted + interval);
        return run;
      }
      if (listingUrl) {
        if (page.kind !== 'listing' || !Array.isArray(page.products))
          return interrupt(run, 'paused', `listing structure mismatch at ${url}`);
        let found;
        try { found = [...new Set(page.products.map(link => canonical(link, run.domain)))]; }
        catch (_) { return interrupt(run, 'paused', `listing structure mismatch at ${url}`); }
        if (!found.length && !run.listings.visited.length)
          return interrupt(run, 'paused', `product-link selector found no products on first listing: ${url}`);
        if (!found.length) return interrupt(run, 'discovery_incomplete', `listing structure mismatch at ${url}`);
        if (run.listings.visited.length >= MAX_LISTINGS || run.products.length + found.length > MAX_PRODUCTS)
          return interrupt(run, 'discovery_incomplete', 'catalog safety bound reached');
        run.listings.queue.shift();
        run.listings.visited.push({url, found: found.length, end: page.end || null});
        const known = new Set(run.products.map(row => row.url));
        for (const productUrl of found) if (!known.has(productUrl)) {
          run.products.push({url: productUrl, status: 'pending'}); known.add(productUrl);
        }
        let next = null;
        try { if (page.next) next = canonical(page.next, run.domain); }
        catch (_) { return interrupt(run, 'discovery_incomplete', `invalid next page at ${url}`); }
        if (next) {
          if (run.listings.visited.some(row => row.url === next) || run.listings.queue.includes(next))
            return interrupt(run, 'discovery_incomplete', `pagination cycle at ${url}`);
          run.listings.queue.push(next);
        } else if (endCheckPasses(run.config, page, run.listings.visited, run.products.length)) {
          run.listings.discoveryComplete = true;
        } else {
          return interrupt(run, 'discovery_incomplete', `missing next page without passing end check at ${url}`);
        }
      } else {
        if (page.kind !== 'product' || !page.product)
          return interrupt(run, 'paused', `product structure mismatch at ${url}`);
        if (run.config.colorVariantStrategy === 'separate-url' && Array.isArray(page.colorLinks)) {
          let links;
          try { links = [...new Set(page.colorLinks.map(link => canonical(link, run.domain)))]; }
          catch (_) { return interrupt(run, 'paused', `invalid color link at ${url}`); }
          const known = new Set(run.products.map(row => row.url));
          for (const link of links) if (!known.has(link)) {
            if (run.products.length >= MAX_PRODUCTS) return interrupt(run, 'paused', 'product safety bound reached');
            run.products.push({url: link, status: 'pending'}); known.add(link);
          }
        }
        const scope = classifyTakeoverScope(page.product);
        item.scope = scope;
        if (scope.decision === 'exclude') {
          item.status = 'excluded'; item.reason = scope.reason;
        } else {
          try {
            const result = await io.capture(url, scope);
            if (result.storage === 'receiver' && ['published', 'reused', 'already'].includes(result.status)) {
              item.status = 'captured'; item.captureStatus = result.status;
            } else if (result.storage === 'downloads') {
              item.status = 'failed'; item.reason = 'exported_unverified';
            } else { throw new Error('invalid capture result'); }
          } catch (error) {
            const reason = String(error?.message || error);
            if (/\b(403|429|captcha|challenge)\b/i.test(reason)) return interrupt(run, 'paused', reason);
            item.status = 'failed'; item.reason = reason;
          }
        }
      }
      run.current = null;
      const beforeSave = await read();
      if (beforeSave?.status !== 'running' || beforeSave.generation !== run.generation) return beforeSave;
      await save(run);
      await io.alarm(run.lastNavigationStarted + interval);
      return run;
    }
    function tick() {
      if (inFlight) return inFlight;
      inFlight = tickUnlocked().finally(() => { inFlight = null; });
      return inFlight;
    }
    return {preview, start, pause, stop, resume, tick, read};
  }
  const api = {createTakeoverRunner, classifyTakeoverScope, summarizeTakeover,
    exportTakeoverReport, endCheckPasses};
  root.PageImageSaverTakeover = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
