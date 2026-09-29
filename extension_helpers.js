(function(root) {
  'use strict';

  function filenameFromUrl(url, fallback) {
    if (!url || typeof url !== 'string') {
      return fallback || `image_${Date.now()}.jpg`;
    }

    try {
      const pathname = new URL(url).pathname;
      const name = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1))
        .split('?')[0].split('#')[0].replace(/[\/\\]/g, '_');
      if (name) return name;
    } catch (e) {
      // Fall through for relative or malformed URLs.
    }

    const parts = url.split('/');
    const name = parts[parts.length - 1].split('?')[0].split('#')[0].replace(/[\/\\]/g, '_');
    return name || fallback || `image_${Date.now()}.jpg`;
  }

  function getScrollStep(viewportHeight) {
    return viewportHeight > 0 ? viewportHeight : 500;
  }

  function getSafeCanvasHeight(totalHeight, dpr, maxCanvasEdge = 16384) {
    const safeDpr = dpr > 0 ? dpr : 1;
    return Math.min(totalHeight, Math.floor(maxCanvasEdge / safeDpr));
  }

  function getElementsForFixedCheck(node) {
    if (!node || node.nodeType !== 1) return [];
    const children = node.children ? Array.from(node.children) : [];
    return [node, ...children];
  }

  function buildCaptureVisibleTabResponse(lastError, dataUrl) {
    if (lastError) {
      return { error: lastError.message || 'captureVisibleTab failed' };
    }
    if (dataUrl) {
      return { dataUrl };
    }
    return { error: 'Failed to capture screenshot' };
  }

  /** Keep user folder paths relative while preserving Unicode and safe subfolders. */
  function sanitizeFolderPath(name) {
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
    return String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .map(part => {
        let safe = part.replace(/[<>:"|?*\x00-\x1f]/g, '_')
          .replace(/^[. ]+|[. ]+$/g, '')
          .substring(0, 100);
        if (reserved.test(safe)) safe = '_' + safe;
        return safe;
      })
      .filter(Boolean)
      .join('/')
      .substring(0, 240);
  }

  /** Match the page-level shortcut used when automation cannot reach Chrome's toolbar. */
  function isFindImagesPageShortcut(event) {
    const target = event.target || {};
    const tag = (target.tagName || '').toUpperCase();
    return event.key?.toLowerCase() === 'i'
      && event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey
      && !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  }

  function buildGoldCaptureSettings(settings) {
    const current = settings || {};
    const local = current.local || {};

    return {
      ...current,
      s3: {
        ...(current.s3 || {}),
        region: '',
        bucketName: '',
        folderPath: '',
        accessKeyId: '',
        secretAccessKey: '',
        makePublic: false
      },
      r2: {
        ...(current.r2 || {}),
        accountId: '',
        bucketName: '',
        folderPath: '',
        useApiToken: false,
        accessKeyId: '',
        secretAccessKey: '',
        apiToken: '',
        makePublic: false
      },
      local: {
        ...local,
        enabled: true,
        subfolderPerDomain: true,
        saveJson: true,
        baseFolder: local.baseFolder || 'PageImageSaver'
      }
    };
  }

  const helpers = {
    sanitizeFolderPath,
    isFindImagesPageShortcut,
    filenameFromUrl,
    getScrollStep,
    getSafeCanvasHeight,
    getElementsForFixedCheck,
    buildCaptureVisibleTabResponse,
    buildGoldCaptureSettings
  };

  root.PageImageSaverHelpers = helpers;
  if (root.window) {
    root.window.PageImageSaverHelpers = helpers;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
})(globalThis);
