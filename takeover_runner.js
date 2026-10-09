/* Durable, single-run catalog navigation. Browser operations are injected so the
 * same state machine can be exercised without a vendor or receiver connection. */
(function(root) {
  'use strict';
  const {comparableUrl, sameDocumentUrl} = root.PageImageSaverHelpers || require('./extension_helpers.js');
  const KEY_VERSION = 1;
  const MAX_LISTINGS = 1000;
  const MAX_PRODUCTS = 10000;
  const DEFAULT_PACING = Object.freeze({minMs: 9000, maxMs: 12000});
  const LEGACY_INTERVAL_MS = 10000;

  function pacingFor(config) {
    const interval = config?.takeover?.intervalMs;
    // Preserve explicit non-default overrides, including zero in offline fixtures.
    return Number.isFinite(interval) && interval !== LEGACY_INTERVAL_MS
      ? {minMs: interval, maxMs: interval} : {...DEFAULT_PACING};
  }
  let inFlight = null;

  function canonical(value, domain) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== domain ||
        url.username || url.password) throw new Error('URL is outside the configured site');
    url.hash = '';
    return url.href;
  }

  function addedQueryOnly(actual, expected) {
    const a = new URL(comparableUrl(actual)), e = new URL(comparableUrl(expected));
    if (a.origin !== e.origin || a.pathname !== e.pathname || a.username || a.password) return false;
    for (const key of new Set(e.searchParams.keys())) {
      if (JSON.stringify(a.searchParams.getAll(key)) !== JSON.stringify(e.searchParams.getAll(key))) return false;
    }
    return true;
  }

  // Used only to avoid calling locale/canonical spellings a different product.
  // This does not grant capture permission or change existing URL binding rules.
  function productPath(value) {
    return decodeURI(new URL(value).pathname)
      .replace(/^\/[a-z]{2}(?:[-_][a-z]{2})?(?=\/)/i, '')
      .replace(/\/+$/, '');
  }

  function classifyTakeoverScope(product) {
    const name = String(product?.name || '').trim();
    const category = String(product?.category || '').trim();
    const evidence = category.toLowerCase();
    const title = name.toLowerCase();
    const excluded = /\b(swimwear|swimsuits?|swim|bikini|maillot de bain|sleepwear|nightwear|nightdress(?:es)?|pyjamas?|pajamas?|menswear|mens?|men's|men’s|ready.to.wear|apparel)\b/i.test(`${evidence} ${title}`);
    const intimate = /\b(lingerie|bras?|sports? bras?|panties|briefs|thongs|corsets?|bodies|bodysuits?|culottes?|soutiens?.gorge)\b/i.test(`${evidence} ${title}`);
    if (excluded && !intimate) return {decision: 'exclude', reason: `product/category evidence: ${category || name}`};
    if (excluded) return {decision: 'review', reason: `mixed category and product evidence: ${category}; ${name}`};
    if (intimate) return {decision: 'include', reason: `product evidence: ${category || name}`};
    return {decision: 'review', reason: 'insufficient product/category evidence'};
  }

  function summarizeTakeover(run) {
    const products = run?.products || [];
    const captured = products.filter(item => item.status === 'captured').length;
    return {pacing: pacingFor(run?.config), listingPagesVisited: run?.listings?.visited?.length || 0,
      productsFound: products.length, productsCaptured: captured,
      colorsCaptured: captured, sizeOptionsTraversed: 0,
      excluded: products.filter(item => item.status === 'excluded').length,
      gone: products.filter(item => item.status === 'skipped' && item.captureStatus === 'gone').length,
      failed: products.filter(item => item.status === 'failed').length,
      pending: products.filter(item => item.status === 'pending').length,
      ...(run?.mode === 'capture-discovery' ? {skipped: products.filter(item => item.status === 'skipped' && item.captureStatus !== 'gone').length} : {}),
      exportedUnverified: products.filter(item => item.status === 'failed' && item.reason === 'exported_unverified').length};
  }

  function exportTakeoverReport(run, context = {}) {
    if (!run || run.version !== KEY_VERSION) throw new Error('no saved catalog run to export');
    if (run.mode === 'discovery') return {
      schema_version: 1, format: 'page-image-saver-discovery/v1', mode: 'discovery',
      started_utc: run.startedAt || null,
      exported_utc: context.exportedUtc || null,
      extension_version: context.extensionVersion || null,
      site: run.domain, locale: run.locale || null, pacing: pacingFor(run.config),
      selectors: {productLinkSelector: run.config.listing.productLinkSelector,
        nextSelector: run.config.listing.pagination.nextSelector,
        endCheck: run.config.listing.endCheck || null},
      listings: run.listings.visited.map(row => ({url: row.url, final_url: row.final_url,
        products: row.products, next_url: row.next_url,
        end_check: {observed: row.end, passed: row.endPassed}})),
      totals: {listing_pages: run.listings.visited.length, product_urls: run.products.length},
      status: run.status, stop_reason: run.reason || null
    };
    return {...run, pacing: pacingFor(run.config), schema_version: 1, format: 'page-image-saver-takeover-run/v1',
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
    const verifiedHere = new Set();
    async function save(run) { await io.save(run); return run; }
    async function read() { return io.read(); }
    async function preview(config, page, mode = 'capture') {
      if (!['capture', 'discovery'].includes(mode)) throw new Error('unknown catalog mode');
      if (!config?.domain || !config.listing?.productLinkSelector || !config.listing?.pagination?.nextSelector)
        throw new Error('site needs explicit listing selectors');
      if (mode === 'capture' && config.colorVariantStrategy !== 'separate-url')
        throw new Error('take-over currently requires separate-URL color identity');
      if (page?.kind !== 'listing' && page?.kind !== 'product') throw new Error('preview needs a listing or product page');
      if (mode === 'discovery' && page.kind !== 'listing') throw new Error('discovery preview needs a listing page');
      const existing = await read();
      if (['running', 'paused'].includes(existing?.status))
        throw new Error('stop or finish the current run before previewing a new one');
      const domain = config.domain.toLowerCase();
      const url = canonical(page.url, domain);
      const entry = {url, kind: page.kind, products: page.kind === 'listing' ? page.products.length : undefined,
        next: page.next || null, end: page.end || null, product: page.product || null,
        imageCount: page.kind === 'product' ? page.imageCount : undefined,
        colorLinks: page.kind === 'product' ? (page.colorLinks || []).length : undefined,
        scope: page.kind === 'product' ? classifyTakeoverScope(page.product) : undefined};
      const run = {version: KEY_VERSION, generation: (existing?.generation || 0) + 1,
        status: 'preview', domain, mode, locale: page.locale || null, config, previews: [entry],
        preview: {endCheckConfigured: !!config.listing.endCheck,
          receiverRequired: 'Verified skip and catalog completion require a configured reachable local receiver.'},
        seedUrl: page.kind === 'listing' ? url : null,
        listings: {queue: [], visited: [], discoveryComplete: false}, products: [],
        current: null, lastNavigationStarted: null, nextNavigationAt: null,
        pacing: pacingFor(config), loadFailures: {}, reason: null};
      return save(run);
    }
    async function importDiscovery(config, sources) {
      const existing = await read();
      if (['running', 'paused'].includes(existing?.status))
        throw new Error('stop or finish the current run before importing discovery');
      if (!config?.domain || config.colorVariantStrategy !== 'separate-url' || !config.product?.allImagesSelector)
        throw new Error('capture needs a configured site with separate-URL product images');
      const domain = config.domain.toLowerCase();
      const reuse = sources === undefined;
      if (reuse) {
        if (existing?.mode !== 'discovery' || existing.domain !== domain)
          throw new Error('no current discovery run for this site');
        sources = [{report: exportTakeoverReport(existing)}];
      }
      if (!Array.isArray(sources) || !sources.length || sources.length > MAX_LISTINGS)
        throw new Error('discovery exports are missing or exceed the safety bound');
      const products = new Map();
      let listingCount = 0;
      for (const source of sources) {
        const report = source?.report;
        if (report?.format !== 'page-image-saver-discovery/v1' || report.schema_version !== 1 ||
            report.mode !== 'discovery' || report.site !== domain || !Array.isArray(report.listings))
          throw new Error('invalid or mixed-host discovery export');
        const provenance = reuse ? {run_started_utc: report.started_utc} : {file_sha256: source.sha256};
        if (reuse ? typeof report.started_utc !== 'string' || !Number.isFinite(Date.parse(report.started_utc)) :
            typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256))
          throw new Error('discovery source provenance is missing or invalid');
        for (const listing of report.listings) {
          if (++listingCount > MAX_LISTINGS) throw new Error('listing safety bound reached');
          const listingUrl = canonical(listing?.url, domain);
          canonical(listing?.final_url, domain);
          if (!Array.isArray(listing.products) || listing.products.length > MAX_PRODUCTS)
            throw new Error('invalid discovery products or product safety bound reached');
          for (const product of listing.products) {
            if (typeof product?.url !== 'string') throw new Error('invalid discovery product URL');
            const url = canonical(product.url, domain);
            if (!products.has(url)) products.set(url, {url, status: 'pending', origins: []});
            if (products.size > MAX_PRODUCTS) throw new Error('product safety bound reached');
            const origin = {...provenance, listing_url: listingUrl};
            const row = products.get(url);
            if (!row.origins.some(prior => JSON.stringify(prior) === JSON.stringify(origin))) row.origins.push(origin);
          }
        }
      }
      if (!products.size) throw new Error('discovery exports contain no product URLs');
      // Validate every source before replacing the saved run.
      const run = {version: KEY_VERSION, generation: (existing?.generation || 0) + 1,
        status: 'preview', domain, mode: 'capture-discovery', config,
        seedUrl: products.keys().next().value, previews: [], products: [...products.values()],
        preview: {fixedQueue: true}, listings: {queue: [], visited: [], discoveryComplete: true},
        current: null, lastNavigationStarted: null, nextNavigationAt: null,
        pacing: pacingFor(config), loadFailures: {}, reason: null};
      return save(run);
    }
    async function start() {
      const run = await read();
      if (!run || run.status !== 'preview' || !run.seedUrl) throw new Error('preview a listing before Take over');
      run.status = 'running';
      run.listings.queue = run.mode === 'capture-discovery' ? [] : [run.seedUrl];
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
      for (const row of run.products) {
        if (!['captured', 'skipped'].includes(row.status) ||
            row.status === 'skipped' && row.captureStatus === 'gone') continue;
        const key = `${run.generation}|${row.url}`;
        if (verifiedHere.has(key)) continue;
        try {
          if (!row.identity || row.identity.domain !== run.domain ||
              row.identity.color_key !== 'url' ||
              !sameDocumentUrl(canonical(row.identity.product_url, run.domain), row.url)) {
            throw new Error('missing or mismatched saved capture identity');
          }
          const result = await io.verify(row.identity);
          const afterVerification = await read();
          if (afterVerification?.status !== 'running' ||
              afterVerification.generation !== run.generation) return afterVerification;
          if (result?.storage !== 'receiver' || result.status !== 'already') {
            throw new Error('receiver no longer verifies published completion');
          }
          verifiedHere.add(key);
        } catch (error) {
          const afterFailure = await read();
          if (afterFailure?.status !== 'running' ||
              afterFailure.generation !== run.generation) return afterFailure;
          if (run.mode === 'capture-discovery' && /\b(403|429|captcha|challenge)\b/i.test(String(error?.message || error)))
            return interrupt(run, 'paused', String(error?.message || error));
          row.status = run.mode === 'capture-discovery' ? 'pending' : 'failed';
          row.reason = `saved completion verification failed: ${String(error?.message || error)}`;
          await save(run);
        }
      }
      const pacing = pacingFor(run.config);
      if (pacing.minMs < 0 || pacing.maxMs > 300000)
        return interrupt(run, 'paused', 'invalid site pacing interval');
      // Upgrade an older saved run without shortening its already-started wait.
      if (run.lastNavigationStarted !== null && !Number.isFinite(run.nextNavigationAt)) {
        const oldInterval = Number.isFinite(run.config.takeover?.intervalMs)
          ? run.config.takeover.intervalMs : LEGACY_INTERVAL_MS;
        run.nextNavigationAt = run.lastNavigationStarted + oldInterval;
        run.pacing = pacing;
        await save(run);
      }
      if (Number.isFinite(run.nextNavigationAt) && io.now() < run.nextNavigationAt) {
        await io.alarm(run.nextNavigationAt); return run;
      }
      const listingUrl = run.listings.queue[0];
      const item = !listingUrl && run.mode !== 'discovery' ? run.products.find(row => row.status === 'pending') : null;
      if (!listingUrl && !item) {
        run.status = run.listings.discoveryComplete && !run.products.some(row => row.status === 'failed') ?
          'complete' : 'finished_with_gaps';
        run.reason = run.status === 'complete' ? null :
          run.listings.discoveryReason || 'unverified or failed products remain';
        run.current = null;
        await save(run);
        await io.clearAlarm?.();
        return run;
      }
      const url = listingUrl || item.url;
      if (item && run.mode === 'capture-discovery') {
        const identity = {domain: run.domain, product_url: url, selected_color: null, color_key: 'url'};
        let verification;
        try { verification = await io.verify(identity); }
        catch (error) {
          if (/\b(403|429|captcha|challenge)\b/i.test(String(error?.message || error)))
            return interrupt(run, 'paused', String(error?.message || error));
          // Missing/unreachable receiver cannot grant a skip; normal capture may export Downloads.
        }
        const afterVerification = await read();
        if (afterVerification?.status !== 'running' || afterVerification.generation !== run.generation) return afterVerification;
        if (verification?.storage === 'receiver' && verification.status === 'already') {
          item.status = 'skipped'; item.identity = identity; item.captureStatus = 'already'; delete item.reason;
          run.consecutiveFailures = 0;
          verifiedHere.add(`${run.generation}|${url}`);
          run.current = null;
          await save(run); await io.alarm(io.now());
          return run;
        }
      }
      run.current = {phase: listingUrl ? 'listing' : 'product', url};
      run.lastNavigationStarted = io.now();
      const delay = pacing.minMs === pacing.maxMs ? pacing.minMs :
        pacing.minMs + Math.floor((io.random || Math.random)() * (pacing.maxMs - pacing.minMs + 1));
      run.pacing = pacing;
      run.nextNavigationAt = run.lastNavigationStarted + delay;
      await save(run); // Intent and pace precede browser navigation.
      await io.alarm(io.now() + 30000); // Repeating alarm revives a terminated MV3 worker.
      let page;
      try { page = await io.load(url, {expect: listingUrl ? 'listing' : 'product'}); }
      catch (error) { page = {status: 0, error: String(error?.message || error)}; }
      const afterLoad = await read();
      if (afterLoad?.status !== 'running' || afterLoad.generation !== run.generation) return afterLoad;
      if (page?.status === 403 || page?.status === 429 || page?.kind === 'challenge' ||
          /\b(403|429|captcha|challenge)\b/i.test(page?.error || '')) {
        return interrupt(run, 'paused', `${page?.error || `challenge or HTTP ${page?.status || 'unknown'}`} at ${url}`);
      }
      let deadProductReason = null;
      let gone = false;
      let queryEquivalent = false;
      if (item && page?.status >= 400) {
        gone = [404, 410].includes(page.status);
        deadProductReason = gone ? `gone: HTTP ${page.status}` : `HTTP ${page.status} at ${url}`;
      } else if (item && page?.url) {
        try {
          const actual = canonical(page.url, run.domain);
          queryEquivalent = run.mode === 'capture-discovery' && addedQueryOnly(actual, url);
          // Preserve same-product query/canonical rules. Only another product path is gone.
          if (page.kind === 'product' && productPath(actual) !== productPath(url)) {
            gone = true;
            deadProductReason = `gone: redirected to ${page.url}`;
          } else if (run.mode === 'capture-discovery' && !queryEquivalent) {
            deadProductReason = `redirected:${page.url}`;
          }
        } catch (_) {
          if (run.mode === 'capture-discovery') deadProductReason = `invalid inspected page URL:${page.url}`;
        }
      }
      if (!deadProductReason && item && page?.kind === 'listing') {
        try {
          canonical(page.url, run.domain);
          deadProductReason = `product structure mismatch at ${url}`;
        } catch (_) { /* Off-site redirects remain safety halts below. */ }
      }
      if (deadProductReason) {
        const beforeFailureSave = await read();
        if (beforeFailureSave?.status !== 'running' ||
            beforeFailureSave.generation !== run.generation) return beforeFailureSave;
        item.status = gone ? 'skipped' : 'failed'; item.reason = deadProductReason;
        if (gone) item.captureStatus = 'gone';
        run.current = null;
        if (!gone) run.consecutiveFailures = (run.consecutiveFailures || 0) + 1;
        if (!gone && run.consecutiveFailures >= 5) return interrupt(run, 'paused', `5 consecutive product failures: ${item.reason}`);
        await save(run);
        await io.alarm(run.nextNavigationAt);
        return run;
      }
      if (!page || page.status === 0 || page.status >= 400 || !['listing', 'product'].includes(page.kind)) {
        const reason = page?.error || `HTTP ${page?.status ?? 'unknown'}; page kind ${page?.kind || 'missing'}`;
        run.loadFailures[url] = (run.loadFailures[url] || 0) + 1;
        run.lastLoadError = {url, reason, attempts: run.loadFailures[url]};
        run.current = null;
        if (run.loadFailures[url] >= 3) {
          // Only known local readiness/timeouts can advance a product queue.
          // Unknown navigation/inspection failures retain the conservative pause.
          const plainFailure = /^(page load timeout|automatic product gallery readiness timeout|Lazy gallery shortfall:)/.test(reason);
          if (!item || !plainFailure)
            return interrupt(run, 'paused', `repeated page load failure at ${url}: ${reason}`);
          item.status = 'failed'; item.reason = `3 page load attempts failed: ${reason}`;
          run.consecutiveFailures = (run.consecutiveFailures || 0) + 1;
          if (run.consecutiveFailures >= 5)
            return interrupt(run, 'paused', `5 consecutive product failures: ${item.reason}`);
        }
        await save(run);
        await io.alarm(run.nextNavigationAt);
        return run;
      }
      try {
        if (!queryEquivalent && !sameDocumentUrl(canonical(page.url, run.domain), url)) {
          return interrupt(run, listingUrl ? 'discovery_incomplete' : 'paused',
            `inspected page URL does not match queued URL at ${url}`);
        }
      } catch (_) {
        return interrupt(run, listingUrl ? 'discovery_incomplete' : 'paused',
          `invalid inspected page URL at ${url}`);
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
        const listing = {url, found: found.length, end: page.end || null};
        if (run.mode === 'discovery') Object.assign(listing, {
          final_url: page.url, next_url: page.next || null, endPassed: false,
          products: found.map(productUrl => ({url: productUrl,
            card_text: (page.cards || []).find(card => {
              try { return canonical(card.url, run.domain) === productUrl; } catch (_) { return false; }
            })?.card_text || ''}))
        });
        run.listings.visited.push(listing);
        const known = new Set(run.products.map(row => row.url));
        for (const productUrl of found) if (!known.has(productUrl)) {
          run.products.push({url: productUrl, status: run.mode === 'discovery' ? 'discovered' : 'pending'}); known.add(productUrl);
        }
        let next = null;
        try { if (page.next) next = canonical(page.next, run.domain); }
        catch (_) { return interrupt(run, 'discovery_incomplete', `invalid next page at ${url}`); }
        if (run.mode === 'discovery') {
          listing.next_url = next;
          listing.endPassed = !next && endCheckPasses(run.config, page, run.listings.visited, run.products.length);
        }
        if (next) {
          if (run.listings.visited.some(row => row.url === next) || run.listings.queue.includes(next))
            return interrupt(run, 'discovery_incomplete', `pagination cycle at ${url}`);
          run.listings.queue.push(next);
        } else if (endCheckPasses(run.config, page, run.listings.visited, run.products.length)) {
          run.listings.discoveryComplete = true;
        } else {
          run.listings.discoveryReason = `missing next page without passing end check at ${url}`;
        }
      } else {
        if (page.kind !== 'product' || !page.product)
          return interrupt(run, 'paused', `product structure mismatch at ${url}`);
        if (run.mode !== 'capture-discovery' && run.config.colorVariantStrategy === 'separate-url' && Array.isArray(page.colorLinks)) {
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
        if (scope.decision === 'exclude' && run.mode !== 'capture-discovery') {
          item.status = 'excluded'; item.reason = scope.reason;
        } else {
          try {
            if (!Number.isInteger(page.tabId) || !page.documentId) {
              return interrupt(run, 'paused', `missing product document binding at ${url}`);
            }
            const binding = {generation: run.generation, tabId: page.tabId,
              documentId: page.documentId, expectedUrl: url};
            if (queryEquivalent && !sameDocumentUrl(canonical(page.url, run.domain), url)) binding.documentUrl = canonical(page.url, run.domain);
            run.current.binding = binding;
            await save(run); // Bind this document before any image acquisition.
            const result = await io.capture(url, scope, binding);
            if (!result.identity || result.identity.domain !== run.domain ||
                result.identity.color_key !== 'url' ||
                !sameDocumentUrl(canonical(result.identity.product_url, run.domain), url)) {
              return interrupt(run, 'paused', `capture identity does not match queued URL at ${url}`);
            }
            if (result.storage === 'receiver' && ['published', 'reused', 'already'].includes(result.status)) {
              item.status = run.mode === 'capture-discovery' && result.status === 'already' ? 'skipped' : 'captured';
              item.captureStatus = result.status; delete item.reason;
              item.identity = result.identity;
              verifiedHere.add(`${run.generation}|${item.url}`);
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
      if (item) {
        run.consecutiveFailures = item.status === 'failed' ? (run.consecutiveFailures || 0) + 1 : 0;
        if (run.consecutiveFailures >= 5) return interrupt(run, 'paused', `5 consecutive product failures: ${item.reason}`);
      }
      await save(run);
      await io.alarm(run.nextNavigationAt);
      return run;
    }
    function tick() {
      if (inFlight) return inFlight;
      inFlight = tickUnlocked().finally(() => { inFlight = null; });
      return inFlight;
    }
    return {preview, importDiscovery, start, pause, stop, resume, tick, read};
  }
  const api = {createTakeoverRunner, classifyTakeoverScope, summarizeTakeover,
    exportTakeoverReport, endCheckPasses};
  root.PageImageSaverTakeover = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
