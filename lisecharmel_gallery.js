// Magento may remove x-magento-init scripts while hydrating its gallery.
// Retain only this page's primary gallery evidence in the extension's isolated world.
(() => {
  if (globalThis.PageImageSaverLiseGallery) return;
  const saved = globalThis.PageImageSaverLiseGallery = [];
  const selector = 'script[type="text/x-magento-init"]';
  function remember(node) {
    const nodes = node.matches?.(selector) ? [node] : Array.from(node.querySelectorAll?.(selector) || []);
    for (const script of nodes) {
      const text = script.textContent;
      if (text.length > 2 * 1024 * 1024 || saved.length >= 4 || saved.includes(text)) continue;
      try {
        const init = JSON.parse(text);
        if (init?.['[data-gallery-role=gallery-placeholder]']?.['mage/gallery/gallery']) saved.push(text);
      } catch (_) { /* A streaming script may not yet have its complete text. */ }
    }
  }
  remember(document);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      remember(record.target);
      for (const node of record.addedNodes) remember(node);
    }
  });
  observer.observe(document, {childList: true, subtree: true});
  // A full colour navigation creates a new document/cache. No persistent storage.
  addEventListener('pagehide', () => observer.disconnect(), {once: true});
})();
