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

  function getSafeCanvasSize(totalWidth, totalHeight, dpr, maxCanvasEdge = 16384, maxCanvasPixels = 67108864) {
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const width = Math.round(totalWidth * safeDpr);
    if (!Number.isFinite(width) || width < 1 || width > maxCanvasEdge) {
      throw new Error(`Full-page screenshot canvas width exceeds the supported ${maxCanvasEdge}-pixel limit. Use visible-area capture instead.`);
    }
    const height = Math.round(totalHeight * safeDpr);
    if (!Number.isFinite(height) || height < 1 || height > maxCanvasEdge) {
      throw new Error(`Full-page screenshot canvas height exceeds the supported ${maxCanvasEdge}-pixel limit. Use visible-area capture instead.`);
    }
    if (width * height > maxCanvasPixels) {
      throw new Error('Full-page screenshot canvas pixel area exceeds the supported limit. Use visible-area capture instead.');
    }
    return { width, height };
  }

  function* getElementsForFixedCheck(node, seen = new WeakSet()) {
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (!current || current.nodeType !== 1 || seen.has(current)) continue;
      seen.add(current);
      yield current;
      if (current.children) {
        for (let i = current.children.length - 1; i >= 0; i--) {
          stack.push(current.children[i]);
        }
      }
    }
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
    filenameFromUrl,
    getScrollStep,
    getSafeCanvasSize,
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
