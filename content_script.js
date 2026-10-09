// content_script.js - This gets injected into web pages

// Add a global flag that the background script can check to see if we're loaded
window.PageImageSaverLoaded = true;
const takeoverDocumentId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, '0')).join('');

// Global variables for domain-specific settings
let currentDomain = '';
let originalPageTitle = document.title; // Captured before any extension modifications
let allImagesCache = [];
let currentFilteredImages = []; // Add this line to track current filtered images
// Global set to dedupe URLs across all discovery methods
let discoveredUrls = new Set();
// Global set to track URLs that have already been sent for upload in the current session
let alreadyUploadedUrls = new Set();
// Cache for dynamic image objects discovered before UI open
let dynamicImageObjs = [];
let domainSettings = {
  minWidth: 50,
  minHeight: 50
};
let ignoredImageUrls = new Set();

function normalizeImageUrl(url) {
  try { return url.split('?')[0].split('#')[0]; } catch { return url; }
}

// Extract a clean filename from a URL (strips query, hash, path prefix)
function filenameFromUrl(url, fallback) {
  return globalThis.PageImageSaverHelpers.filenameFromUrl(url, fallback);
}

// Function to get the current domain
function getCurrentDomain() {
  return window.location.hostname;
}

// Function to save domain settings
function saveDomainSettings(domain, settings) {
  chrome.storage.sync.get('domainSizeFilters', (result) => {
    const domainFilters = result.domainSizeFilters || {};
    domainFilters[domain] = settings;
    chrome.storage.sync.set({ domainSizeFilters: domainFilters });
  });
}

// Function to load domain settings
function loadDomainSettings(domain, callback) {
  chrome.storage.sync.get('domainSizeFilters', (result) => {
    const domainFilters = result.domainSizeFilters || {};
    const settings = domainFilters[domain] || { minWidth: 50, minHeight: 50 };
    if (!settings.folderName) settings.folderName = domain;
    callback(settings);
  });
}

// Load ignored image URLs from storage at startup
chrome.storage.sync.get('ignoredImageUrls', (result) => {
  ignoredImageUrls = new Set((result.ignoredImageUrls || []).map(normalizeImageUrl));
});

// Filter images by size
function filterImagesBySize(images, minWidth, minHeight) {
  const filtered = images.filter(img => img.width >= minWidth && img.height >= minHeight);
  console.log(`Size filter ${minWidth}x${minHeight}: ${filtered.length}/${images.length} passed`);
  return filtered;
}

/**
 * Helper function to parse srcset attribute and find the best (highest width) URL.
 * Handles cases with and without 'w' descriptors.
 * @param {string} srcsetValue The srcset string.
 * @returns {{url: string, width: number} | null} The best source object found or null.
 */
function parseSrcset(srcsetValue) {
    if (!srcsetValue) return null;

    try {
        const sources = srcsetValue.split(',').map(s => s.trim());
        let bestSource = { url: '', width: -1 }; // Use -1 to indicate nothing found yet
        let firstValidUrl = null; // Track the first valid URL for fallback

        sources.forEach(item => {
            const parts = item.split(/\s+/); // Split URL and potential descriptor
            const url = parts[0];
            let width = 0; // Default width if no 'w' descriptor

            // Basic URL validation (skip empty, data, blob)
            if (!url || url.trim() === '' || url.startsWith('data:') || url.startsWith('blob:')) {
                return; // Skip this source candidate
            }

            // Additional path validation - accept absolute URLs, protocol-relative URLs (//) 
            // and reject relative URLs that start with a single slash
            if (!(url.startsWith('http://') || url.startsWith('https://') || 
                   url.startsWith('//') || !url.startsWith('/'))) {
                return; // Skip invalid URLs
            }

            // Track the first *valid* URL found in the list as a fallback
            if (firstValidUrl === null) {
                firstValidUrl = url;
            }

            // Check if a width descriptor ('w') exists
            if (parts.length > 1 && parts[1].endsWith('w')) {
                const parsedWidth = parseInt(parts[1].replace('w', ''), 10);
                // Use the parsed width if valid, otherwise keep width = 0
                if (!isNaN(parsedWidth)) {
                    width = parsedWidth;
                }
            }

            // --- Logic to select the best source ---
            // If the current source's width is greater than the best one found so far,
            // update bestSource.
            if (width > bestSource.width) {
                bestSource = { url: url, width: width };
            }
            // --- End selection logic ---
        });

        // --- Determine final result ---
        // If we found at least one source with a valid width descriptor (even 0w),
        // 'bestSource.width' will be >= 0. Return that best source.
        if (bestSource.width > -1) {
            return bestSource;
        }

        // Otherwise, if no width descriptors were found at all, but we did find
        // at least one valid URL, return the *first* valid URL encountered.
        if (firstValidUrl !== null) {
            return { url: firstValidUrl, width: 0 }; // Indicate width is unknown/default
        }

        // If the srcset was empty or contained no valid sources
        return null;

    } catch (error) {
        console.warn('Error parsing srcset:', srcsetValue, error);
        return null; // Return null on any parsing error
    }
}

// Helper function for extension recognition
function getExtensionFromContentType(contentType) {
    if (!contentType) return '.jpg';
    const typeMap = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff',
    };
    return typeMap[contentType.toLowerCase()] || '.jpg'; // Default to .jpg
}
/**
 * Handle a dynamically loaded image URL (from network or DOM),
 * create an Image object to extract metadata, and update UI.
 */
function handleDynamicImage(url) {
  // Avoid duplicates using global discoveredUrls set
  if (discoveredUrls.has(url)) {
    return;
  }
  
  // Skip tracking pixels, analytics URLs, and other non-image resources
  if (shouldSkipImage(url)) {
    return;
  }
  
  // Claim the URL immediately so concurrent MutationObserver/network callbacks
  // for the same URL don't spawn parallel Image() retry chains.
  discoveredUrls.add(url);

  // Load image for metadata. Use an explicit attempt counter so the error
  // handler doesn't accidentally loop: after removeAttribute('crossorigin'),
  // imgEl.crossOrigin returns null again, which would restart the cycle.
  const imgEl = new Image();
  let loadAttempt = 0;

  imgEl.onload = () => {
    if (imgEl.naturalWidth < 10 || imgEl.naturalHeight < 10) return;

    const imageObj = {
      url: url,
      alt: filenameFromUrl(url) || '',
      width: imgEl.naturalWidth,
      height: imgEl.naturalHeight,
      naturalWidth: imgEl.naturalWidth,
      naturalHeight: imgEl.naturalHeight,
      type: 'dynamic',
      filename: filenameFromUrl(url),
      title: '',
      loading: '',
      dataAttributes: {},
      sourceAttribute: 'dynamic',
      isLoaded: true
    };
    dynamicImageObjs.push(imageObj);
    if (imageObj.width >= domainSettings.minWidth && imageObj.height >= domainSettings.minHeight) {
      currentFilteredImages.push(imageObj);
      scheduleUpdateImageList();
    }
  };

  imgEl.onerror = () => {
    loadAttempt++;
    if (loadAttempt === 1) {
      // Retry with crossOrigin=anonymous (handles CORS-blocked images)
      imgEl.crossOrigin = 'anonymous';
      imgEl.src = url;
    } else if (loadAttempt === 2) {
      // Final retry with no crossorigin attribute
      imgEl.removeAttribute('crossorigin');
      imgEl.src = url;
    }
    // loadAttempt >= 3: all attempts failed, stop — URL already in discoveredUrls
  };

  imgEl.src = url;
}

/**
 * Handle a dynamically loaded video stream (.m3u8) from the network
 */
function handleDynamicStream(url) {
  if (discoveredUrls.has(url)) {
    return;
  }
  
  discoveredUrls.add(url);
  
  const streamObj = {
    url: url,
    alt: 'HLS Video Stream (.m3u8)',
    width: 1920, // Dummy high resolution to bypass filters
    height: 1080,
    naturalWidth: 1920,
    naturalHeight: 1080,
    type: 'stream',
    filename: filenameFromUrl(url, 'stream.m3u8'),
    title: 'HLS Video Stream',
    loading: '',
    dataAttributes: {},
    sourceAttribute: 'dynamic',
    isLoaded: true
  };
  
  dynamicImageObjs.push(streamObj);
  // Add to current filter list unconditionally
  currentFilteredImages.push(streamObj);
  
  if (document.getElementById('image-selector-container')) {
    updateImageList(currentFilteredImages);
  }
}

/**
 * Helper function to determine if an image URL should be skipped
 * (tracking pixels, analytics, etc)
 */
function shouldSkipImage(url) {
  try {
    // Skip URLs with certain patterns that are commonly used for tracking
    const trackingPatterns = [
      '/fd/ls/l?', // Bing tracking
      '/pagead/', // Google ads
      '/ga-audiences', // Google Analytics
      '/pixel', // Generic pixel trackers
      '/beacon', // Beacons
      '/track', // Generic tracking
      '/analytics', // Analytics
      '/collect', // Collection endpoints
      '/metric', // Metrics
      '/p.gif', // Tracking pixels with p.gif
      '/ping', // Ping endpoints
      '/stats', // Stats collection
      '/impression', // Ad impressions
      '/piwik', // Piwik/Matomo analytics
      '/counter', // Counters
      '/B?BF=', // Specific Bing format
      '/ClientInst', // Microsoft client instrumentation
      '/FilterFlare', // More Bing tracking
    ];
    
    // Additional patterns for common error-generating resources
    const problemPatterns = [
      'sprite.f55edc3f843fb93ad5d4941d30a666e9f3cac204.svg', // TrustedShops sprite
      'widgets.trustedshops.com/assets/images/sprite', // Any TrustedShops sprites
      '.svg#', // SVG fragments which often cause CORS issues
      '/widget/', // Widget resources often have CORS restrictions
      '/badge/', // Badges/emblems from third parties
      '/seal/', // Trust/security seals
      '/trustmark', // Trust marks
      '/_/set_cookie', // Imperva/Incapsula CDN bot-protection cookie endpoints (not images)
      '/_/fp/', // Imperva fingerprinting endpoints
    ];
    
    // Check if URL contains any of the tracking patterns
    if (trackingPatterns.some(pattern => url.includes(pattern))) {
      return true;
    }
    
    // Check if URL contains any of the problem patterns
    if (problemPatterns.some(pattern => url.includes(pattern))) {
      // Suppress log for common third-party elements
      console.debug(`Skipping problematic resource: ${url.substring(0, 50)}...`);
      return true;
    }
    
    // Skip favicons
    if (url.toLowerCase().includes('.ico')) {
      return true;
    }

    // Check for small GIF images that end with a 1x1 or have a query string
    if (url.toLowerCase().endsWith('.gif') &&
        (url.includes('1x1') || url.includes('?'))) {
      return true;
    }
    
    return false;
  } catch (error) {
    console.warn('Error in shouldSkipImage:', error);
    return false;
  }
}

function findAllImages() {
    allImagesCache = [];

    const imgElements = Array.from(document.querySelectorAll('img'));

    const elementsWithBgImages = Array.from(document.querySelectorAll(
        '*:not(script):not(style):not(input):not(textarea):not(select):not(button):not(link):not(meta)'
    )).filter(el => {
        const style = window.getComputedStyle(el);
        const bgImage = style.backgroundImage;
        return bgImage && bgImage !== 'none' && bgImage.startsWith('url(');
    });

    const imageUrls = imgElements.map(img => {
        let potentialUrl = '';
        let sourceAttribute = '';
        let bestSrcsetSource = null;

        // 1. Prioritize srcset (parse for highest resolution)
        bestSrcsetSource = parseSrcset(img.srcset);
        if (bestSrcsetSource) {
            potentialUrl = bestSrcsetSource.url;
            sourceAttribute = 'srcset';
        }

        // 2. Fallback to data-srcset (parse for highest resolution)
        if (!potentialUrl) {
            bestSrcsetSource = parseSrcset(img.dataset.srcset);
            if (bestSrcsetSource) {
                potentialUrl = bestSrcsetSource.url;
                sourceAttribute = 'data-srcset';
            }
        }

        // 3. Fallback to data-src (common lazy-load attribute)
        if (!potentialUrl && img.dataset.src) {
            potentialUrl = img.dataset.src;
            sourceAttribute = 'data-src';
        }

        // 4. Fallback to data-lazy-src (another common lazy-load attribute)
        if (!potentialUrl && img.dataset.lazySrc) {
             potentialUrl = img.dataset.lazySrc;
             sourceAttribute = 'data-lazy-src';
        }
         // Add more data-* attributes here if needed (e.g., data-lazy, data-original)
         if (!potentialUrl && img.dataset.lazy) {
             potentialUrl = img.dataset.lazy;
             sourceAttribute = 'data-lazy';
         }
         if (!potentialUrl && img.dataset.original) {
             potentialUrl = img.dataset.original;
             sourceAttribute = 'data-original';
         }


        // 5. Final fallback to src
        if (!potentialUrl && img.src) {
            potentialUrl = img.src;
            sourceAttribute = 'src';
        }

        // Skip if no URL found or it's a data URI or clearly invalid
        if (!potentialUrl || potentialUrl.startsWith('data:') || potentialUrl.trim() === '' || potentialUrl.startsWith('blob:')) {
             // console.log('Skipping image element with no valid src/srcset/data-* or data/blob URI:', img);
             return null;
        }

        // Resolve relative URLs to absolute
        let resolvedUrl = '';
        try {
            // Handle protocol-relative URLs (starting with //)
            if (potentialUrl.startsWith('//')) {
                resolvedUrl = new URL(`${window.location.protocol}${potentialUrl}`).href;
            }
            // Check if potentialUrl is already absolute with protocol
            else if (potentialUrl.startsWith('http://') || potentialUrl.startsWith('https://')) {
                resolvedUrl = new URL(potentialUrl).href; // Validate and normalize absolute URL
            } else {
                // Handle all other relative URLs
                resolvedUrl = new URL(potentialUrl, window.location.href).href; // Resolve relative URL
            }
        } catch (e) {
            console.warn(`Could not create URL object for potential URL "${potentialUrl}" derived from ${sourceAttribute}:`, e);
            return null; // Skip invalid URLs
        }

        // Check if image has loaded its intrinsic dimensions
        const isLoaded = img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;

        // --- Alt Text Logic (remains the same) ---
        let altText = img.alt || '';
        if (!altText) {
            const figure = img.closest('figure');
            if (figure) {
                const figcaption = figure.querySelector('figcaption');
                if (figcaption) altText = figcaption.textContent.trim();
            }
            if (!altText) {
                const parent = img.parentElement;
                if (parent) {
                    const caption = parent.querySelector('div[class*="caption"], .caption, [class*="Caption"], [id*="caption"]');
                    if (caption) altText = caption.textContent.trim();
                }
            }
        }
        if (!altText) altText = img.title || 'No description';
        // --- End Alt Text ---


        // --- Filename Extraction Logic (using resolvedUrl) ---
        const filename = filenameFromUrl(resolvedUrl, `image_${Date.now()}${getExtensionFromContentType(img.type || 'image/jpeg')}`);
        // --- End Filename ---

        // Data Attributes
        const dataAttributes = {};
        for (const attr of img.attributes) {
            if (attr.name.startsWith('data-')) {
                dataAttributes[attr.name] = attr.value;
            }
        }

        // If the URL came from a srcset 'w' descriptor that is larger than what the browser
        // loaded (e.g. Glamuse serves 460w in the viewport but has a 1050w original), use
        // the descriptor width and estimate height proportionally from the loaded aspect ratio.
        const srcsetDescriptorWidth = bestSrcsetSource && bestSrcsetSource.width > 0
            ? bestSrcsetSource.width : 0;
        const loadedW = isLoaded ? img.naturalWidth : img.width;
        const loadedH = isLoaded ? img.naturalHeight : img.height;
        const effectiveW = srcsetDescriptorWidth > loadedW ? srcsetDescriptorWidth : loadedW;
        const effectiveH = srcsetDescriptorWidth > loadedW && loadedW > 0
            ? Math.round(srcsetDescriptorWidth * (loadedH / loadedW))
            : loadedH;

        return {
            url: resolvedUrl,
            alt: altText,
            width: effectiveW,
            height: effectiveH,
            naturalWidth: effectiveW,
            naturalHeight: effectiveH,
            type: 'img',
            filename: filename,
            title: img.title || '',
            loading: img.loading || '', // e.g., "lazy"
            dataAttributes: dataAttributes,
            sourceAttribute: sourceAttribute, // Track source for debugging
            isLoaded: isLoaded // Track if browser has decoded it
        };
    }).filter(img => img !== null); // Filter out skipped elements

    // --- Background Image Logic (mostly same, added URL resolution/validation) ---
    const bgImageUrls = elementsWithBgImages.map(el => {
        const style = window.getComputedStyle(el);
        const bgMatch = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);

        if (!bgMatch || !bgMatch[1] || bgMatch[1].startsWith('data:') || bgMatch[1].trim() === '' || bgMatch[1].startsWith('blob:')) {
            return null;
        }
        const bgImageUrl = bgMatch[1];

        let resolvedBgUrl = '';
        try {
            // Handle protocol-relative URLs (starting with //)
            if (bgImageUrl.startsWith('//')) {
                resolvedBgUrl = new URL(`${window.location.protocol}${bgImageUrl}`).href;
            }
            // Check if URL is already absolute with protocol
            else if (bgImageUrl.startsWith('http://') || bgImageUrl.startsWith('https://')) {
                resolvedBgUrl = new URL(bgImageUrl).href;
            } else {
                // Handle all other relative URLs
                resolvedBgUrl = new URL(bgImageUrl, window.location.href).href;
            }
        } catch (e) {
            console.warn(`Could not create URL object for background image "${bgImageUrl}":`, e);
            return null;
        }

        // Filename extraction
        const filename = filenameFromUrl(resolvedBgUrl, `background_image_${Date.now()}.jpg`);


        // Alt text logic (same as before)
        let altText = el.getAttribute('aria-label') || el.title || '';
        if (!altText && el.textContent && el.textContent.trim().length < 100) {
            altText = el.textContent.trim();
        }
        if (!altText) {
            const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
            if (heading) altText = heading.textContent.trim();
        }
        if (!altText) altText = `Background image for ${el.tagName.toLowerCase()} element`;

        // Data Attributes
        const dataAttributes = {};
        for (const attr of el.attributes) {
            if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
        }

        const bgSize = style.backgroundSize;
        const bgPosition = style.backgroundPosition;
        const bgRepeat = style.backgroundRepeat;

        return {
            url: resolvedBgUrl,
            alt: altText,
            width: el.offsetWidth, // Background uses element dimensions
            height: el.offsetHeight,
            naturalWidth: 0, // N/A for background
            naturalHeight: 0,
            type: 'background',
            element: el.tagName,
            filename: filename,
            className: el.className || '',
            id: el.id || '',
            bgSize: bgSize,
            bgPosition: bgPosition,
            bgRepeat: bgRepeat,
            dataAttributes: dataAttributes,
            sourceAttribute: 'background-image',
            isLoaded: true // Assume background images controlled by CSS are 'loaded' contextually
        };
    }).filter(img => img !== null);
    // --- End Background ---

    // Combine static image list
    let allImages = [...imageUrls, ...bgImageUrls];

    // Merge in any dynamic images discovered before UI open
    if (dynamicImageObjs.length > 0) {
      dynamicImageObjs.forEach(imgObj => {
        if (imgObj && imgObj.url && !allImages.some(i => i.url === imgObj.url)) {
          allImages.push(imgObj);
        }
      });
    }

    // Filter out small SVGs likely used as icons
    allImages = allImages.filter(img => {
        const isSvg = img.url.toLowerCase().includes('.svg'); // Check extension or mime type if available later
        const isSmall = (img.width || 0) < 100 && (img.height || 0) < 100;
        if (isSvg && isSmall) {
            console.debug(`Filtering out small SVG icon: ${img.url}`);
            return false;
        }
        return true;
    });

    // Remove duplicates and problematic URLs
    const uniqueUrls = new Set();
    allImages = allImages.filter(img => {
        if (!img || !img.url) return false;
        
        // Skip duplicates
        if (uniqueUrls.has(img.url)) {
            return false;
        }
        
        // Check if it's a problematic URL that causes CORS errors
        if (shouldSkipImage(img.url)) {
            return false;
        }
        
        // It passed all filters
        uniqueUrls.add(img.url);
        return true;
    });

    allImagesCache = [...allImages];

    // Filter by size using domain settings
    const filteredImages = filterImagesBySize(allImages, domainSettings.minWidth, domainSettings.minHeight);
    currentFilteredImages = filteredImages; // Update the currently displayed/filtered list

    return filteredImages;
}

// Function to check image file size before saving
async function checkImagesFileSizes(images) {
  const MIN_FILE_SIZE = 5 * 1024; // 5KB minimum size
  const TIMEOUT_MS = 5000; // 5 second timeout for each request
  const BATCH_SIZE = 10; // Process 10 images at a time to avoid too many concurrent requests
  let validImages = [];
  
  // Skip images that have already been sent for upload this session
  let imagesToCheck = images.filter(image => !alreadyUploadedUrls.has(image.url));
  
  // If all images were already uploaded, return the original array for UI feedback
  if (imagesToCheck.length === 0 && images.length > 0) {
    console.debug(`[CONTENT LOG] All ${images.length} images have already been sent for upload`);
    
    // Show a message in the UI if it's open
    const statusDiv = document.getElementById('status-message');
    if (statusDiv) {
      statusDiv.innerHTML = `<div class="alert alert-info">All ${images.length} selected images have already been sent for upload in this session.</div>`;
    }
    
    return images; // Return original images so UI can proceed normally
  }
  
  // Continue checking the new images
  console.debug(`[CONTENT LOG] Checking file sizes for ${imagesToCheck.length} new images (${images.length - imagesToCheck.length} already uploaded)`);
  
  // If we filtered any previously uploaded images, update the status message
  const statusDiv = document.getElementById('status-message');
  if (statusDiv && imagesToCheck.length < images.length) {
    statusDiv.innerHTML = `<div class="alert alert-info">Checking ${imagesToCheck.length} new images (${images.length - imagesToCheck.length} were already uploaded)</div>`;
  }
  
  // Function to check a single image with timeout
  async function checkImage(image) {
    try {
      // First, try a more reliable method to check if the image is valid
      // by using the Image constructor which works with cross-origin images
      const prevalidateImage = () => {
        return new Promise((resolve) => {
          // Create temporary image element to verify the URL is a valid image
          const img = new Image();
          
          // Set a timeout in case the image doesn't load
          const imgTimeout = setTimeout(() => {
            // Use debug level for timeouts to reduce console spam
            console.debug(`[CORS] Image prevalidation timed out`);
            resolve(true); // Continue anyway, let the server handle it
          }, 2000);
          
          // Image loaded successfully with crossOrigin
          img.onload = () => {
            clearTimeout(imgTimeout);
            // Success doesn't need to be logged to avoid console spam
            resolve(true);
          };
          
          // Image failed to load with crossOrigin
          img.onerror = () => {
            clearTimeout(imgTimeout);
            // Use debug level for less console spam
            console.debug(`[CORS] Prevalidation retry: ${image.url.substring(0, 40)}...`);
            
            // Try loading without crossOrigin as a fallback
            const fallbackImg = new Image();
            
            // Set a new timeout for the fallback
            const fallbackTimeout = setTimeout(() => {
              // Only log timeouts at debug level
              console.debug(`[CORS] Fallback prevalidation timed out`);
              resolve(true); // Continue anyway
            }, 2000);
            
            // Handle fallback success - no logging needed
            fallbackImg.onload = () => {
              clearTimeout(fallbackTimeout);
              resolve(true);
            };
            
            // Handle fallback failure - no logging needed
            fallbackImg.onerror = () => {
              clearTimeout(fallbackTimeout);
              // No logging to reduce console spam
              resolve(true);
            };
            
            // Load without crossOrigin
            fallbackImg.src = image.url;
          };
          
          // Set crossOrigin to anonymous to avoid tainting the canvas
          img.crossOrigin = "anonymous";
          img.src = image.url;
        });
      };
      
      // Always prevalidate, but don't fail if it doesn't work
      await prevalidateImage();
      
      try {
        // Create an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        
        // Try a fetch with 'no-cors' mode first to handle cross-origin requests
        try {
          const response = await fetch(image.url, { 
            method: 'HEAD', 
            credentials: 'include',
            mode: 'no-cors', // Use no-cors mode to avoid CORS issues
            signal: controller.signal 
          });
          
          // Clear the timeout
          clearTimeout(timeoutId);
          
          // If using no-cors mode, we can't actually read the headers
          // But if we got here without an error, the image is probably valid
          return image;
        } catch (corsError) {
          // If no-cors mode failed, try a normal request
          console.debug(`No-cors request failed for ${image.url}, trying regular request`);
          
          // Create a new AbortController for the second attempt
          const controller2 = new AbortController();
          const timeoutId2 = setTimeout(() => controller2.abort(), TIMEOUT_MS);
          
          const response = await fetch(image.url, { 
            method: 'HEAD', 
            credentials: 'include',
            signal: controller2.signal 
          });
          
          // Clear the timeout
          clearTimeout(timeoutId2);
          
          // If we can get content-length, use it to filter small files
          const contentLength = response.headers.get('Content-Length');
          
          if (contentLength && parseInt(contentLength) < MIN_FILE_SIZE) {
            console.debug(`Skipping small image (${contentLength} bytes): ${image.url}`);
            return null; // Skip this image
          } else {
            // Check content type to ensure it's actually an image or video stream
            const contentType = response.headers.get('Content-Type');
            if (contentType && (contentType.startsWith('image/') || contentType.includes('mpegurl') || image.type === 'stream')) {
              return image; // Keep this image
            } else {
              console.debug(`Skipping non-image content type (${contentType}): ${image.url}`);
              return null;
            }
          }
        }
      } catch (fetchError) {
        // If both fetch attempts failed, but the image loaded in the browser,
        // let's trust that it's valid and include it
        console.debug(`All fetch attempts failed for ${image.url}, but proceeding anyway`);
        return image;
      }
    } catch (error) {
      // If the error is due to timeout, log appropriately
      if (error.name === 'AbortError') {
        console.warn(`Timeout checking image: ${image.url}`);
      } else {
        console.warn(`Error checking image size for ${image.url}:`, error);
      }
      
      // For errors, we'll keep the image and let the background script handle failures
      // This prevents the UI from getting stuck on problematic images
      return image;
    }
  
  }
  
  // Use image dimensions as a quick local filter first before making network requests
  // This can quickly eliminate tiny images
  const preFilteredImages = imagesToCheck.filter(img => {
    // Make sure the image object is valid
    if (!img) return false;
    
    // For img elements with natural dimensions
    if (img.type && img.type === 'img' && img.naturalWidth && img.naturalHeight) {
      return img.naturalWidth >= 50 && img.naturalHeight >= 50;
    }
    // Otherwise keep it for server-side checking
    return true;
  });
  
  // Process images in batches to limit concurrent requests
  for (let i = 0; i < preFilteredImages.length; i += BATCH_SIZE) {
    const batch = preFilteredImages.slice(i, i + BATCH_SIZE);
    
    // Create a promise for each image in the batch
    const batchPromises = batch.map(image => checkImage(image));
    
    // Wait for the current batch to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Add valid images from this batch
    validImages = validImages.concat(batchResults.filter(image => image !== null));
    
    // Update the status message to show progress
    const processed = Math.min(i + BATCH_SIZE, preFilteredImages.length);
    const statusDiv = document.getElementById('status-message');
    if (statusDiv) {
      statusDiv.innerHTML = `<div class="alert alert-info">Checking images: ${processed}/${preFilteredImages.length} (${validImages.length} valid so far)...</div>`;
    }
  }
  
  // Add any previously uploaded images to the valid images list for UI feedback
  if (images.length > imagesToCheck.length) {
    const previouslyUploaded = images.filter(image => alreadyUploadedUrls.has(image.url));
    console.debug(`[CONTENT LOG] Adding ${previouslyUploaded.length} previously uploaded images to UI selection`);
    validImages = [...previouslyUploaded, ...validImages];
  }
  
  return validImages;
}

// UI to show found images
function createImageSelectionUI(images) {
  console.log('Creating UI for', images.length, 'images');
  
  // Initialize currentFilteredImages with the images being displayed
  currentFilteredImages = images;
  
  // Make sure allImagesCache is properly set if it's empty
  if (allImagesCache.length === 0) {
    allImagesCache = [...images];
  }
  
  // Remove any existing UI to prevent duplicates
  const existingContainer = document.getElementById('image-selector-container');
  if (existingContainer) {
    document.body.removeChild(existingContainer);
    // Return early if there's already a UI open and we're clicking the button again with the same images
    // This prevents duplicate image display when clicking the button multiple times
    if (currentFilteredImages === images && existingContainer.getAttribute('data-images-count') === images.length.toString()) {
      return;
    }
  }

  // Create a container for our UI
  const container = document.createElement('div');
  container.id = 'image-selector-container';
  // Add a data attribute to track how many images are being displayed
  container.setAttribute('data-images-count', images.length.toString());
  container.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 380px;
    max-width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    background: white;
    box-shadow: -2px 0 5px rgba(0,0,0,0.2);
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    padding: 10px;
    overflow: hidden;
    font-family: Arial, sans-serif;
    font-size: 12px;
    line-height: 18px;
    color: #222;
  `;
  
  // Create header
  const header = document.createElement('div');
  header.style.flexShrink = '0';
  header.innerHTML = `
    <div id="takeover-status-line" role="status" hidden style="font-weight: bold; padding: 8px; margin-bottom: 6px; background: #eef4ff; overflow-wrap: anywhere;"></div>
    <h2 style="margin: 0 0 4px; font: bold 16px/20px Arial, sans-serif;">Images Found (${images.length})</h2>
    <p style="margin: 0 0 6px; font: 12px/18px Arial, sans-serif;">Select images to save to your storage</p>
    <div style="display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap;">
      <button id="save-selected-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #34A853; color: white; cursor: pointer;">Save Selected</button>
      <button id="select-all-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #4285F4; color: white; cursor: pointer;">Select All</button>
      <button id="deselect-all-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer;">Deselect All</button>
      <button id="save-page-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #34A853; color: white; cursor: pointer;">Save Page Images</button>
      <button id="take-screenshot-btn" title="Take screenshot of the visible page" style="border-radius: 4px; border: none; background: #EA4335; color: white; cursor: pointer;">Visible screenshot</button>
      <button id="take-full-screenshot-btn" title="Take screenshot of the full page" style="border-radius: 4px; border: none; background: #EA4335; color: white; cursor: pointer;">Full-page screenshot</button>
      <button id="close-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer;">Close</button>
    </div>
    <details id="catalog-capture-section" style="margin-bottom: 4px; max-height: 35vh; overflow-y: auto; font-size: 12px;">
      <summary style="cursor: pointer; padding: 4px 0; font-weight: bold;">Catalog capture</summary>
      <label>Run mode <select id="takeover-mode"><option value="capture">Product capture</option><option value="discovery">Listing discovery only</option><option value="capture-discovery">Capture discovery queue</option></select></label>
      <label style="display:block;">Discovery exports <input id="takeover-discovery-files" type="file" multiple accept=".json,application/json" style="width:100%;"></label>
      <button id="takeover-reuse-discovery-btn" type="button">Reuse current discovery</button>
      <button id="shopify-feed-btn" type="button" hidden>Save Shopify feed</button>
      <div id="takeover-start-url" style="overflow-wrap:anywhere;">Start URL: no preview yet</div>
      <div style="display: flex; gap: 4px; margin: 4px 0; flex-wrap: wrap;">
        <button id="capture-product-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #6b46a0; color: white; cursor: pointer;">Capture Product Locally</button>
        <button id="takeover-preview-btn" type="button">Preview catalog</button>
        <button id="takeover-start-btn" type="button">Take over</button>
        <button id="takeover-pause-btn" type="button">Pause</button>
        <button id="takeover-resume-btn" type="button">Resume</button>
        <button id="takeover-stop-btn" type="button">Stop</button>
        <button id="takeover-export-btn" type="button">Export run JSON</button>
      </div>
      <div style="display: grid; gap: 5px; margin-bottom: 8px;">
        <label>Capture images <select id="capture-image-mode"><option value="selected">Selected checkboxes</option><option value="site">Site product selectors</option></select></label>
        <label>Color identity <select id="capture-color-policy"><option value="color">Color on this URL</option><option value="url">Each color has its own URL</option></select></label>
        <label>Selected color <input id="capture-color" type="text" placeholder="Required for same-URL colors"></label>
        <label>Scope <select id="capture-scope"><option value="review">Review</option><option value="include">Include</option><option value="exclude">Exclude</option></select></label>
        <label>Scope reason <input id="capture-scope-reason" type="text" placeholder="Why this scope decision?"></label>
        <label><input id="capture-same-color-selection" type="checkbox"> I changed only the image selection, not the product/color (one capture only)</label>
        <label><input id="capture-auto-site" type="checkbox"> Auto capture product pages on this site as review</label>
      </div>
      <div id="capture-failures" style="margin: 8px 0; overflow-wrap: anywhere;"></div>
      <div id="takeover-feedback" role="status" style="font-size: 12px; overflow-wrap: anywhere;"></div>
      <div id="takeover-progress" role="status" style="font-size: 12px; white-space: pre-wrap;"></div>
    </details>
    <div id="size-filter" style="margin-top: 4px; padding: 6px; background: #f5f5f5; border-radius: 4px;">
      <div style="font-weight: bold; margin-bottom: 4px; overflow-wrap: anywhere;">Settings for ${currentDomain}</div>
      <div id="folder-name-row" style="display: flex; gap: 4px; align-items: center; margin-bottom: 4px;">
        <div style="flex-grow: 1;">
          <label for="folder-name" style="display: block; font-size: 12px; margin-bottom: 2px;">Local Folder Name</label>
          <input type="text" id="folder-name" value="${domainSettings.folderName || currentDomain}" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
        </div>
      </div>
      <div style="display: flex; gap: 4px; align-items: end; flex-wrap: wrap;">
        <div>
          <label for="min-width" style="display: block; font-size: 12px; margin-bottom: 2px;">Min Width (px)</label>
          <input type="number" id="min-width" value="${domainSettings.minWidth}" min="0" style="width: 70px; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
        <div>
          <label for="min-height" style="display: block; font-size: 12px; margin-bottom: 2px;">Min Height (px)</label>
          <input type="number" id="min-height" value="${domainSettings.minHeight}" min="0" style="width: 70px; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
        <button id="apply-filter-btn" style="padding: 5px 10px; border-radius: 4px; border: none; background: #4285F4; color: white; cursor: pointer; margin-top: 15px;">Apply</button>
        <button id="save-filter-btn" style="padding: 5px 10px; border-radius: 4px; border: none; background: #34A853; color: white; cursor: pointer; margin-top: 15px;">Save</button>
      </div>
    </div>
    <div id="status-message" style="margin-top: 4px;"></div>
  `;
  // Assign properties directly: storefront CSP can block inserted <style> elements.
  // Scope to our header so host controls and thumbnail sizing stay untouched.
  const compactControlStyle = {
    'box-sizing': 'border-box', font: '12px/18px Arial, sans-serif',
    'min-width': '0', 'max-width': '100%', height: '26px', 'min-height': '26px',
    margin: '0',
  };
  for (const control of header.querySelectorAll('button, input:not([type="checkbox"]), select')) {
    for (const [property, value] of Object.entries(compactControlStyle)) {
      control.style.setProperty(property, value, 'important');
    }
    control.style.setProperty('padding', '2px 5px', 'important');
  }
  for (const button of header.querySelectorAll('button')) {
    const buttonStyle = {
      display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center',
      'letter-spacing': 'normal', 'text-transform': 'none', 'white-space': 'nowrap',
      width: 'auto', padding: '3px 6px', 'border-width': '1px',
    };
    for (const [property, value] of Object.entries(buttonStyle)) {
      button.style.setProperty(property, value, 'important');
    }
  }
  for (const control of header.querySelectorAll('button, input, select, summary')) {
    // Restore the browser's keyboard focus indicator even if the host removes it.
    control.style.setProperty('outline', 'revert', 'important');
    control.style.setProperty('outline-offset', '2px', 'important');
  }
  container.appendChild(header);
  
  //

// Create scrollable image list
const imageList = document.createElement('div');
imageList.id = 'image-list';
imageList.style.cssText = `
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 6px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  align-items: start;
`;

// Add each image item to the list
images.forEach((image, index) => {
  const imgContainer = _createImageItemElement(image, index);
  imageList.appendChild(imgContainer);
});

container.appendChild(imageList);
document.body.appendChild(container);

  const catalogSection = container.querySelector('#catalog-capture-section');
  const catalogOpenKey = `catalogCaptureOpen:${currentDomain}`;
  const catalogDomain = currentDomain;
  let catalogStateLoaded = false;
  let catalogToggledBeforeLoad = false;
  function refreshCaptureFailures() {
    const box = container.querySelector('#capture-failures');
    try {
      chrome.storage.local.get({captureFailures: []}, result => {
        if (chrome.runtime.lastError) {
          box.textContent = 'Recent capture failures unavailable.';
          return;
        }
        const failures = (Array.isArray(result?.captureFailures) ? result.captureFailures : [])
          .filter(row => {
            try { return new URL(row.url).hostname === catalogDomain; }
            catch { return false; }
          }).slice(-5).reverse();
        box.replaceChildren();
        if (failures.length === 0) return;
        const title = document.createElement('strong');
        title.textContent = 'Recent capture failures';
        const list = document.createElement('ol');
        list.style.cssText = 'padding-left: 20px; margin: 4px 0;';
        for (const failure of failures) {
          const item = document.createElement('li');
          item.textContent = `${failure.at || 'Unknown time'} — ${failure.reason || 'Unknown error'} (${failure.url})`;
          list.appendChild(item);
        }
        box.append(title, list);
      });
    } catch (error) {
      box.textContent = 'Recent capture failures unavailable.';
    }
  }
  catalogSection.querySelector('summary').addEventListener('click', () => {
    if (!catalogStateLoaded) catalogToggledBeforeLoad = true;
  });
  catalogSection.addEventListener('toggle', () => {
    if (!catalogStateLoaded) catalogToggledBeforeLoad = true;
    try { chrome.storage.local.set({[catalogOpenKey]: catalogSection.open}); }
    catch (error) { console.warn('Could not save catalog panel state:', error); }
    if (catalogSection.open) refreshCaptureFailures();
  });
  try {
    chrome.storage.local.get(catalogOpenKey, result => {
      if (!catalogToggledBeforeLoad && !chrome.runtime.lastError) {
        catalogSection.open = result?.[catalogOpenKey] === true;
      }
      catalogStateLoaded = true;
    });
  } catch (error) {
    catalogStateLoaded = true;
    console.warn('Could not restore catalog panel state:', error);
  }
  refreshCaptureFailures();

  loadCaptureSiteConfig().then(config => {
    container.querySelector('#shopify-feed-btn').hidden = config?.platform !== 'shopify';
    if (config) {
      document.getElementById('capture-image-mode').value = 'site';
      document.getElementById('capture-color-policy').value =
        config.colorVariantStrategy === 'separate-url' ? 'url' : 'color';
    }
    document.getElementById('capture-color').value = capturePageProduct().color || '';
  });
  chrome.storage.local.get({captureAutoDomains: {}}, result => {
    document.getElementById('capture-auto-site').checked = !!result.captureAutoDomains[currentDomain];
  });
  document.getElementById('capture-auto-site').addEventListener('change', event => {
    chrome.storage.local.get({captureAutoDomains: {}}, result => {
      const domains = result.captureAutoDomains;
      domains[currentDomain] = event.target.checked;
      chrome.storage.local.set({captureAutoDomains: domains});
    });
  });
  document.getElementById('capture-product-btn').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await captureCurrentProduct({manual: true});
      showStatusMessage(globalThis.PageImageSaverHelpers.captureResultMessage(result), 'success');
    } catch (error) {
      await recordCaptureFailure(error);
      refreshCaptureFailures();
      showStatusMessage(`Product capture failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  });
  const previewButton = container.querySelector('#takeover-preview-btn');
  container.querySelector('#shopify-feed-btn').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    const feedback = container.querySelector('#takeover-feedback');
    let acquired = false;
    try {
      await takeoverRequest('shopifyFeedAcquire');
      acquired = true;
      if (/verify you are human|unusual traffic|access denied|captcha|bot challenge/i.test(
          `${document.title} ${document.body?.innerText?.slice(0, 2000) || ''}`))
        throw new Error('Page challenge detected; feed not requested');
      feedback.textContent = 'Saving Shopify feed… Keep this tab open and do not navigate.';
      const config = await loadCaptureSiteConfig();
      const report = await globalThis.PageImageSaverHelpers.collectShopifyFeed(config, window.location.href, {
        progress: (pages, products) => { feedback.textContent = `Shopify feed: ${pages} pages, ${products} products…`; }
      });
      await takeoverRequest('saveShopifyFeedDownload', {report});
      feedback.textContent = `Shopify feed saved to Downloads (${report.pages.length} pages).`;
      showStatusMessage(feedback.textContent, 'success');
    } catch (error) {
      feedback.textContent = `Shopify feed failed: ${error.message}. No automatic retry or partial export.`;
      showStatusMessage(feedback.textContent, 'error');
    } finally {
      if (acquired) {
        try { await takeoverRequest('shopifyFeedRelease'); }
        catch (error) { showStatusMessage(`Feed reservation not released: ${error.message}. Close this tab before restarting.`, 'error'); }
      }
      button.disabled = false;
    }
  });
  const takeoverFeedback = container.querySelector('#takeover-feedback');
  const takeoverProgress = container.querySelector('#takeover-progress');
  const modeControl = container.querySelector('#takeover-mode');
  modeControl.addEventListener('change', () => { modeControl.dataset.userChanged = 'true'; });
  const discoveryFiles = container.querySelector('#takeover-discovery-files');
  const reuseDiscovery = container.querySelector('#takeover-reuse-discovery-btn');
  async function prepareDiscoveryCapture(files) {
    discoveryFiles.disabled = reuseDiscovery.disabled = true;
    takeoverProgress.dataset.previewPending = 'true';
    takeoverRefreshSequence++;
    takeoverFeedback.textContent = 'Preparing discovery capture…';
    try {
      const config = await loadCaptureSiteConfig();
      if (!config) throw new Error('No site config for discovery capture');
      const sources = [];
      for (const file of files || []) {
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        sources.push({sha256, report: JSON.parse(new TextDecoder().decode(bytes))});
      }
      await takeoverRequest('takeoverImportDiscovery', {config, sources, reuse: files === null});
      modeControl.value = 'capture-discovery';
      modeControl.dataset.userChanged = 'true';
      delete takeoverProgress.dataset.previewPending;
      await refreshTakeoverProgress();
      takeoverFeedback.textContent = 'Fixed queue ready. Take over starts at the URL shown.';
    } catch (error) {
      const reloadHint = /message port closed|message channel closed|Receiving end does not exist/i.test(error.message) ?
        ' Reload the extension in chrome://extensions, then refresh this page and import again.' : '';
      takeoverFeedback.textContent = `Discovery import failed: ${error.message}${reloadHint}`;
    } finally {
      delete takeoverProgress.dataset.previewPending;
      discoveryFiles.disabled = reuseDiscovery.disabled = false;
      discoveryFiles.value = '';
    }
  }
  discoveryFiles.addEventListener('change', () => {
    if (discoveryFiles.files.length) void prepareDiscoveryCapture(Array.from(discoveryFiles.files));
  });
  reuseDiscovery.addEventListener('click', () => { void prepareDiscoveryCapture(null); });
  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true;
    takeoverProgress.dataset.previewPending = 'true';
    takeoverRefreshSequence++;
    takeoverFeedback.textContent = `Previewing ${catalogDomain}…`;
    try {
      const config = await loadCaptureSiteConfig();
      if (!config) throw new Error('No site config for catalog preview');
      const mode = container.querySelector('#takeover-mode').value;
      if (mode === 'capture-discovery') throw new Error('Load discovery exports or reuse current discovery to prepare this queue');
      const page = await inspectTakeoverPage(config, mode);
      await takeoverRequest('takeoverPreview', {config, page, mode});
      delete takeoverProgress.dataset.previewPending;
      await refreshTakeoverProgress();
      takeoverFeedback.textContent = `Preview ready for ${catalogDomain}.`;
    } catch (error) {
      takeoverFeedback.textContent = `Catalog preview failed: ${error.message}`;
      showStatusMessage(takeoverFeedback.textContent, 'error');
    } finally {
      delete takeoverProgress.dataset.previewPending;
      previewButton.disabled = false;
    }
  });
  for (const [button, action] of [['takeover-start-btn', 'takeoverStart'],
    ['takeover-pause-btn', 'takeoverPause'], ['takeover-resume-btn', 'takeoverResume'],
    ['takeover-stop-btn', 'takeoverStop'], ['takeover-export-btn', 'takeoverExport']]) {
    document.getElementById(button).addEventListener('click', async () => {
      try {
        await takeoverRequest(action, {domain: catalogDomain,
          mode: container.querySelector('#takeover-mode').value});
        if (action === 'takeoverExport') showStatusMessage('Catalog run JSON saved to Downloads.', 'success');
        await refreshTakeoverProgress();
      }
      catch (error) { showStatusMessage(`Catalog take-over: ${error.message}`, 'error'); }
    });
  }
  void refreshTakeoverProgress();
  const takeoverRefresh = setInterval(() => {
    if (!document.contains(container)) clearInterval(takeoverRefresh);
    else void refreshTakeoverProgress();
  }, 2000);

  // Hide the local folder row if local saving is disabled in settings
  chrome.storage.sync.get('imageUploaderSettings', (result) => {
    const localEnabled = result.imageUploaderSettings?.local?.enabled;
    if (!localEnabled) {
      const row = document.getElementById('folder-name-row');
      if (row) row.style.display = 'none';
    }
  });

  // Add event listeners
  document.getElementById('select-all-btn').addEventListener('click', () => {
    const checkboxes = imageList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      const idx = parseInt(cb.dataset.index);
      const img = currentFilteredImages[idx];
      if (img && !ignoredImageUrls.has(normalizeImageUrl(img.url))) cb.checked = true;
    });
  });
  
  document.getElementById('deselect-all-btn').addEventListener('click', () => {
    const checkboxes = imageList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
  });
  
  document.getElementById('save-page-btn').addEventListener('click', async () => {
    const btn = document.getElementById('save-page-btn');
    const origText = btn.textContent;
    const origBg = '#34A853';

    const setStatus = (text, isError = false) => {
      btn.textContent = text;
      btn.style.background = isError ? '#EA4335' : origBg;
    };

    try {
      btn.disabled = true;
      setStatus('Scrolling...');

      const MAX_SCROLL_ROUNDS = 20;
      const MAX_SCROLL_MS = 30_000;
      const scrollStart = Date.now();
      let prevH = 0, rounds = 0;

      while (rounds < MAX_SCROLL_ROUNDS && Date.now() - scrollStart < MAX_SCROLL_MS) {
        const totalH = document.documentElement.scrollHeight;
        if (totalH === prevH) break;
        prevH = totalH;
        const step = globalThis.PageImageSaverHelpers.getScrollStep(window.innerHeight);
        for (let y = window.scrollY; y < totalH; y += step) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 400));
        }
        rounds++;
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 500));

      setStatus('Scanning...');
      const allImages = findAllImages().filter(
        img => !ignoredImageUrls.has(normalizeImageUrl(img.url))
      );

      setStatus('Validating...');
      const valid = await checkImagesFileSizes(allImages);

      if (!valid || valid.length === 0) {
        setStatus('No images found', true);
        setTimeout(() => {
          btn.textContent = origText;
          btn.style.background = origBg;
          btn.disabled = false;
        }, 3000);
        return;
      }

      setStatus(`Saving ${valid.length}...`);
      saveImagesToStorage(valid);
      // Button stays disabled to prevent duplicate saves
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      setTimeout(() => {
        btn.textContent = origText;
        btn.style.background = origBg;
        btn.disabled = false;
      }, 5000);
    }
  });

  document.getElementById('save-selected-btn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('save-selected-btn');
    const selectedImages = [];
    const checkboxes = imageList.querySelectorAll('input[type="checkbox"]:checked');
    
    checkboxes.forEach(cb => {
      try {
        const index = parseInt(cb.dataset.index);
        // Use currentFilteredImages instead of images
        if (!isNaN(index) && index >= 0 && index < currentFilteredImages.length) {
          const image = currentFilteredImages[index];
          if (image && image.url) {
            selectedImages.push(image);
          }
        }
      } catch (error) {
        console.error("Error processing selected image:", error);
      }
    });
    
    if (selectedImages.length > 0) {
      // Show saving indicator
      showStatusMessage(`Checking ${selectedImages.length} image${selectedImages.length > 1 ? 's' : ''}...`, 'info');
      
      // Disable save button to prevent multiple clicks
      saveBtn.disabled = true;
      saveBtn.textContent = 'Checking...';
      saveBtn.style.backgroundColor = '#cccccc';
      
      try {
        // Check file sizes before saving
        const validImages = await checkImagesFileSizes(selectedImages);
        
        if (!validImages || validImages.length === 0) {
          showStatusMessage('No valid images found to save (images may be too small).', 'error');
          
          // Re-enable the button
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Selected';
          saveBtn.style.backgroundColor = '#34A853';
          return;
        }
        
        // Update message with valid image count
        showStatusMessage(`Saving ${validImages.length} image${validImages.length > 1 ? 's' : ''}...`, 'info');
        saveBtn.textContent = 'Saving...';
        
        await saveImagesToStorage(validImages);
      } catch (error) {
        console.error("Error during image checking:", error);
        showStatusMessage(`Error checking images: ${error.message}`, 'error');
        
        // Re-enable the button
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Selected';
        saveBtn.style.backgroundColor = '#34A853';
      }
    } else {
      showStatusMessage('Please select at least one image to save.', 'error');
    }
  });
  
  document.getElementById('take-screenshot-btn').addEventListener('click', () => {
    // Close the current UI
    document.body.removeChild(container);
    // Initialize screenshot flow
    if (window.PageScreenshot) {
      window.PageScreenshot.initiateScreenshot(false); // pass false for visible area
    } else {
      console.error('Screenshot module not found');
      alert('Screenshot module not found. Please try reloading the page.');
    }
  });

  document.getElementById('take-full-screenshot-btn').addEventListener('click', () => {
    // Close the current UI
    document.body.removeChild(container);
    // Initialize screenshot flow
    if (window.PageScreenshot) {
      window.PageScreenshot.initiateScreenshot(true); // pass true for full page
    } else {
      console.error('Screenshot module not found');
      alert('Screenshot module not found. Please try reloading the page.');
    }
  });
  
  document.getElementById('close-btn').addEventListener('click', () => {
    document.body.removeChild(container);
  });
  
  // Add event listeners for the size filter
  document.getElementById('apply-filter-btn').addEventListener('click', () => {
    applyImageSizeFilter();
  });
  
  document.getElementById('save-filter-btn').addEventListener('click', () => {
    saveImageSizeFilter();
  });
}

// Apply size filter to images
function applyImageSizeFilter() {
  // Get filter values
  const minWidth = parseInt(document.getElementById('min-width').value) || 0;
  const minHeight = parseInt(document.getElementById('min-height').value) || 0;
  
  
  // Ensure we have images to filter
  if (allImagesCache.length === 0) {
    console.error('Error: No images in cache to filter');
    showStatusMessage('Error: No images available to filter', 'error');
    return;
  }
  
  // Update domain settings (but don't save to storage yet)
  domainSettings.minWidth = minWidth;
  domainSettings.minHeight = minHeight;
  
  // Filter images with new values
  const filteredImages = filterImagesBySize(allImagesCache, minWidth, minHeight);
  
  
  // Update the UI to show filtered images
  updateImageList(filteredImages);
  
  // Show status message
  showStatusMessage(`Filter applied: ${filteredImages.length} images match the criteria.`, 'info');
}

// Save size filter for domain
function saveImageSizeFilter() {
  // Get filter values
  const minWidth = parseInt(document.getElementById('min-width').value) || 0;
  const minHeight = parseInt(document.getElementById('min-height').value) || 0;
  const folderName = document.getElementById('folder-name') ? document.getElementById('folder-name').value.trim() : currentDomain;
  
  // Update domain settings
  domainSettings.minWidth = minWidth;
  domainSettings.minHeight = minHeight;
  domainSettings.folderName = folderName || currentDomain;
  
  // Save to storage
  saveDomainSettings(currentDomain, domainSettings);
  
  // Show status message
  showStatusMessage(`Settings saved for ${currentDomain}`, 'success');
}

// Helper function to create an image item element
function _createImageItemElement(image, index) {
  const imgContainer = document.createElement('div');
  imgContainer.style.cssText = `
    border: 1px solid #ddd;
    padding: 10px;
    border-radius: 4px;
    position: relative;
    height: 185px;
    display: flex;
    flex-direction: column;
    cursor: pointer;
  `;
  
  // Add data attribute for tracking
  imgContainer.dataset.index = index;
  
  // Check if this image URL has already been uploaded during this session
  const alreadyUploaded = alreadyUploadedUrls.has(image.url);
  
  // If already uploaded, add visual indicator
  if (alreadyUploaded) {
    imgContainer.style.borderColor = '#4CAF50'; // Green border for uploaded images
    imgContainer.style.borderWidth = '2px';

    // Add an "uploaded" badge
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: absolute;
      top: 5px;
      left: 5px;
      background-color: #4CAF50;
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      z-index: 2;
    `;
    badge.textContent = 'Uploaded';
    imgContainer.appendChild(badge);
  }

  // Check if this image URL is ignored
  const isIgnored = ignoredImageUrls.has(normalizeImageUrl(image.url));

  if (isIgnored) {
    imgContainer.style.opacity = '0.45';

    const ignoredBadge = document.createElement('div');
    ignoredBadge.style.cssText = `
      position: absolute;
      top: ${alreadyUploaded ? '26px' : '5px'};
      left: 5px;
      background-color: #888;
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      z-index: 2;
    `;
    ignoredBadge.textContent = 'Ignored';
    imgContainer.appendChild(ignoredBadge);
  }

  // Create checkbox for selection
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `img-${index}`;
  checkbox.dataset.index = index;
  checkbox.checked = !isIgnored;
  checkbox.style.cssText = `
    position: absolute;
    top: 5px;
    right: 5px;
    width: 20px;
    height: 20px;
    z-index: 2;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    appearance: auto !important;
    -webkit-appearance: checkbox !important;
  `;
  
  // Create thumbnail container with fixed height
  const thumbnailContainer = document.createElement('div');
  thumbnailContainer.style.cssText = `
    flex: 1;
    position: relative;
    overflow: hidden;
    margin-bottom: 5px;
    background-color: #f5f5f5;
  `;
  
  // Create thumbnail using IMG element instead of background-image to handle CORS better
  const thumbnail = document.createElement('div');
  thumbnail.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  `;
  
  // Function to show placeholder without loading image
  const showPlaceholder = (message = "Image Preview Unavailable") => {
    thumbnail.style.backgroundColor = "#f5f5f5";
    thumbnail.style.color = "#666";
    thumbnail.style.display = "flex";
    thumbnail.style.alignItems = "center";
    thumbnail.style.justifyContent = "center";
    thumbnail.style.padding = "5px";
    thumbnail.style.textAlign = "center";
    thumbnail.style.fontSize = "10px";
    thumbnail.textContent = message;
    return; // Return early to prevent image loading
  };
  
  // Check if the image URL is problematic before trying to load it
  if (image.url && typeof image.url === 'string') {
    // If it's a stream, don't try to load it as an image
    if (image.type === 'stream' || image.url.includes('.m3u8')) {
      showPlaceholder("🎥 HLS Video Stream");
      
      imgContainer.appendChild(checkbox);
      imgContainer.appendChild(thumbnailContainer);
      thumbnailContainer.appendChild(thumbnail);
      
      const info = document.createElement('div');
      info.style.cssText = `
        font-size: 12px;
        max-height: 32px;
        word-break: break-all;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        margin-bottom: 2px;
        pointer-events: none;
      `;
      
      info.textContent = image.alt || 'Video Stream';
      
      const dimensionsInfo = document.createElement('div');
      dimensionsInfo.style.cssText = `
        font-size: 11px;
        color: #666;
        margin-top: 2px;
        pointer-events: none;
      `;
      
      let displayText = image.filename ? image.filename.substring(0, 20) + '...' : 'stream.m3u8';
      dimensionsInfo.textContent = displayText;
      
      imgContainer.appendChild(info);
      imgContainer.appendChild(dimensionsInfo);
      
      imgContainer.addEventListener('click', (event) => {
        if (event.target !== checkbox) {
          event.preventDefault();
          event.stopPropagation();
          checkbox.checked = !checkbox.checked;
        }
      });
      
      return imgContainer;
    }

    // Known problematic patterns that cause CORS errors
    const knownProblematicPatterns = [
      'trustedshops.com/assets/images/sprite',
      '.svg#',
      'widgets.trustpilot.com',
      '/widget/',
      '/badge/',
      '/seal/',
      '/trustmark'
    ];
    
    // Check if URL matches any of the problematic patterns
    if (knownProblematicPatterns.some(pattern => image.url.includes(pattern))) {
      // Don't even try to load it - just show placeholder
      showPlaceholder("Widget image (skipped)");
      
      // Continue with the rest of the function to create the container
      imgContainer.appendChild(checkbox);
      imgContainer.appendChild(thumbnailContainer);
      thumbnailContainer.appendChild(thumbnail);
      
      // Add info and other elements
      const info = document.createElement('div');
      info.style.cssText = `
        font-size: 12px;
        max-height: 32px;
        word-break: break-all;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        margin-bottom: 2px;
        pointer-events: none;
      `;
      
      // Set description text - only show alt text if it's meaningful
      const hasAltText = image.alt && image.alt !== 'No description';
      info.textContent = hasAltText ? image.alt : '';
      
      // Add dimensions info
      const dimensionsInfo = document.createElement('div');
      dimensionsInfo.style.cssText = `
        font-size: 11px;
        color: #666;
        margin-top: 2px;
        pointer-events: none;
      `;
      
      const dimensions = (image.naturalWidth && image.naturalHeight) 
        ? `${image.naturalWidth}x${image.naturalHeight}`
        : `${image.width}x${image.height}`;
      
      let displayText = dimensions;
      if (!hasAltText && image.filename) {
        const shortName = `${image.filename.substring(0, 15)}${image.filename.length > 15 ? '...' : ''}`;
        displayText = `${shortName} | ${dimensions}`;
      }
      
      dimensionsInfo.textContent = displayText;
      
      imgContainer.appendChild(info);
      imgContainer.appendChild(dimensionsInfo);
      
      // Add click event
      imgContainer.addEventListener('click', (event) => {
        if (event.target !== checkbox) {
          event.preventDefault();
          event.stopPropagation();
          checkbox.checked = !checkbox.checked;
        }
      });
      
      return imgContainer;
    }
  }
  
  // If we get here, it's not a known problematic URL, so we can try to load the image
  const imgEl = document.createElement('img');
  
  // Set crossOrigin attribute before setting the src
  // Use null initially for sites with preloaded images since 
  // that will match the default credentials mode of 'same-origin'
  imgEl.crossOrigin = null;
  
  imgEl.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    overflow: hidden;
  `;
  
  // Add error handling to show placeholder if image fails to load
  imgEl.onerror = () => {
    // If initial load fails (with null crossOrigin), try with anonymous
    if (imgEl.crossOrigin === null) {
      // Use debug level to reduce console noise
      console.debug(`[CORS] Thumbnail retry with anonymous: ${image.url.substring(0, 30)}...`);
      imgEl.crossOrigin = "anonymous";
      imgEl.src = image.url;
      
      // Set up a second error handler for the fallback attempt
      imgEl.onerror = () => {
        // No attribution - final fallback
        console.debug(`[CORS] Final thumbnail fallback attempt: ${image.url.substring(0, 30)}...`);
        imgEl.removeAttribute('crossorigin');
        imgEl.src = image.url;
        
        // Set up a third error handler for the last attempt
        imgEl.onerror = () => {
          // No logging for complete failure to avoid console spam
          // Use our helper function to show placeholder
          if (imgEl.parentNode) {
            imgEl.parentNode.removeChild(imgEl);
          }
          showPlaceholder();
        };
      };
      return;
    }
    
    // If we've already tried fallbacks - no logging and show placeholder
    if (imgEl.parentNode) {
      imgEl.parentNode.removeChild(imgEl);
    }
    showPlaceholder();
  };
  
  // Set the src after setting up error handlers
  imgEl.src = image.url;
  
  // Append the image to the thumbnail container
  thumbnail.appendChild(imgEl);
  
  thumbnailContainer.appendChild(thumbnail);
  
  // Add description
  const info = document.createElement('div');
  info.style.cssText = `
    font-size: 12px;
    max-height: 32px;
    word-break: break-all;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    margin-bottom: 2px;
    pointer-events: none;
  `;
  
  // Set description text - only show alt text if it's meaningful
  const hasAltText = image.alt && image.alt !== 'No description';
  info.textContent = hasAltText ? image.alt : '';
  
  // Add dimensions as a separate line
  const dimensionsInfo = document.createElement('div');
  dimensionsInfo.style.cssText = `
    font-size: 11px;
    color: #666;
    margin-top: 2px;
    pointer-events: none;
  `;
  
  // Format image dimensions
  const dimensions = image.naturalWidth && image.naturalHeight 
    ? `${image.naturalWidth}x${image.naturalHeight}` 
    : `${image.width}x${image.height}`;
  
  // Always show dimensions
  let displayText = dimensions;
  
  // If alt text is missing, add filename before dimensions
  if (!hasAltText && image.filename) {
    const shortName = `${image.filename.substring(0, 15)}${image.filename.length > 15 ? '...' : ''}`;
    displayText = `${shortName} | ${dimensions}`;
  }
  
  dimensionsInfo.textContent = displayText;
  
  // Add a tooltip with complete metadata
  let tooltipContent = `Dimensions: ${dimensions}\n`;
  
  if (image.filename) {
    tooltipContent += `Filename: ${image.filename}\n`;
  }
  
  if (image.alt && image.alt !== 'No description') {
    tooltipContent += `Alt text: ${image.alt}\n`;
  }
  
  if (image.type === 'background') {
    tooltipContent += `Element: ${image.element}\n`;
    if (image.className) tooltipContent += `Class: ${image.className}\n`;
    if (image.bgSize) tooltipContent += `Background size: ${image.bgSize}\n`;
  }
  
  dimensionsInfo.title = tooltipContent;
  
  imgContainer.appendChild(checkbox);
  imgContainer.appendChild(thumbnailContainer);
  imgContainer.appendChild(info);
  imgContainer.appendChild(dimensionsInfo);

  // Ignore/Unignore button
  const ignoreBtn = document.createElement('button');
  ignoreBtn.textContent = isIgnored ? '↩ Unignore' : '✕ Ignore';
  ignoreBtn.style.cssText = `
    font-size: 10px; color: #999; background: none; border: none;
    cursor: pointer; padding: 2px 0; text-align: left;
    display: block !important; visibility: visible !important; width: 100%;
  `;
  ignoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const normalized = normalizeImageUrl(image.url);
    chrome.storage.sync.get('ignoredImageUrls', (result) => {
      let list = result.ignoredImageUrls || [];
      if (ignoredImageUrls.has(normalized)) {
        list = list.filter(u => u !== normalized);
        ignoredImageUrls.delete(normalized);
      } else {
        if (!list.includes(normalized)) list.push(normalized);
        ignoredImageUrls.add(normalized);
      }
      chrome.storage.sync.set({ ignoredImageUrls: list });
      updateImageList(currentFilteredImages);
    });
  });
  imgContainer.appendChild(ignoreBtn);

  // Add click event to the container - toggle checkbox when clicking anywhere on the item
  imgContainer.addEventListener('click', (event) => {
    // Don't toggle if clicking directly on the checkbox (let the checkbox handle itself)
    if (event.target !== checkbox && event.target !== ignoreBtn) {
      // Prevent event bubbling
      event.preventDefault();
      event.stopPropagation();

      // Toggle the checkbox
      checkbox.checked = !checkbox.checked;
    }
  });

  return imgContainer;
}

// Debounced UI update for dynamic image discovery — batches rapid additions
let _updateImageListTimer = null;
function scheduleUpdateImageList() {
  if (!document.getElementById('image-selector-container')) return;
  clearTimeout(_updateImageListTimer);
  _updateImageListTimer = setTimeout(() => {
    updateImageList(currentFilteredImages);
  }, 150);
}

// Update image list with filtered images
function updateImageList(filteredImages) {
  try {
    // Ensure the UI container and title element exist before updating
    const container = document.getElementById('image-selector-container');
    if (!container) return;
    const titleElement = container.querySelector('h2');
    if (!titleElement) return;

    // Store the filtered images in our global variable
    currentFilteredImages = filteredImages;
    // Update title count
    titleElement.textContent = `Images Found (${filteredImages.length})`;

    // Clear existing image list
    const imageList = document.getElementById('image-list');
    if (!imageList) return;
    imageList.innerHTML = '';

    // Populate with new filtered images using the helper function
    filteredImages.forEach((image, index) => {
      const imgContainer = _createImageItemElement(image, index);
      imageList.appendChild(imgContainer);
    });
  } catch (error) {
    // UI may not be ready; silently ignore update errors
  }
}

// Function to show status message
function showStatusMessage(message, type = 'info') {
  const statusDiv = document.getElementById('status-message');
  if (!statusDiv) return;

  // Set background color based on message type
  let bgColor = '#e2f3eb'; // Success - light green
  let textColor = '#0f5132';
  
  if (type === 'error') {
    bgColor = '#f8d7da'; // Error - light red
    textColor = '#721c24';
  } else if (type === 'info') {
    bgColor = '#cff4fc'; // Info - light blue
    textColor = '#055160';
  } else if (type === 'warning') {
    bgColor = '#fff3cd'; // Warning - light yellow
    textColor = '#856404';
  }

  statusDiv.style.cssText = `
    padding: 10px;
    border-radius: 4px;
    margin-top: 10px;
    background-color: ${bgColor};
    color: ${textColor};
    text-align: center;
  `;
  statusDiv.innerHTML = message;

  // Clear success/info messages after 5 seconds
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      if (statusDiv && statusDiv.parentNode) {
        statusDiv.innerHTML = '';
        statusDiv.style.padding = '0';
      }
    }, 5000);
  }
}

// Function to create a progress indicator overlay
function createProgressIndicator(count) {
  // Check if an indicator already exists
  const existingIndicator = document.getElementById('save-progress-indicator');
  if (existingIndicator) {
    console.debug(`[CONTENT LOG] Reusing existing progress indicator`);
    return existingIndicator;
  }
  
  // Create the progress container - position it directly in the body for maximum independence
  const progressContainer = document.createElement('div');
  progressContainer.id = 'save-progress-indicator';
  progressContainer.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 9999999; /* Extra high z-index */
    font-family: Arial, sans-serif;
    display: flex;
    align-items: center;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    transition: opacity 0.3s ease-in-out;
    pointer-events: all; /* Ensure it can receive mouse events */
  `;
  
  // This important flag will prevent the indicator from being removed when the main UI is closed
  progressContainer.setAttribute('data-persistent', 'true');
  
  // Add a spinner
  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-radius: 50%;
    border-top-color: white;
    animation: spin 1s linear infinite;
    margin-right: 15px;
  `;
  
  // Add a keyframe animation for the spinner
  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleSheet);
  
  // Create message
  const message = document.createElement('div');
  message.textContent = `Saving ${count} image${count > 1 ? 's' : ''} to your storage...`;
  
  // Add elements to container
  progressContainer.appendChild(spinner);
  progressContainer.appendChild(message);
  
  // Add directly to the document body - independent of any other UI
  document.body.appendChild(progressContainer);
  
  // Store a reference to the indicator element in a global property
  window.PageImageSaverProgressIndicator = progressContainer;
  
  console.debug(`[CONTENT LOG] Created persistent progress indicator with ID: ${progressContainer.id}`);
  return progressContainer;
}

// Function to update progress indicator
function updateProgressIndicator(completed, total, successCount) {
  // Get the indicator - or recreate it if it doesn't exist
  let indicator = document.getElementById('save-progress-indicator');
  if (!indicator) {
    console.debug(`[CONTENT LOG] Progress indicator not found, recreating it`);
    indicator = createProgressIndicator(total);
  }
  
  const messageEl = indicator.lastChild;
  if (messageEl) {
    // If we have a success count and it's different from completed, show both stats
    if (typeof successCount !== 'undefined' && successCount !== completed) {
      messageEl.innerHTML = `Processed ${completed} of ${total} image${total > 1 ? 's' : ''}<br>` +
                            `<span style="color: #98FB98">${successCount} successful</span>, ` +
                            `<span style="color: #FFA07A">${completed - successCount} failed/skipped</span>`;
    } else {
      messageEl.textContent = `Saved ${completed} of ${total} image${total > 1 ? 's' : ''}...`;
    }
    
    // Add a progress percentage
    if (total > 0) {
      const percent = Math.round((completed / total) * 100);
      // Update the title with the percentage for quick glance info
      document.title = `(${percent}%) ${originalPageTitle}`;
      
      // Also update the indicator to show the percentage
      indicator.setAttribute('data-progress-percent', `${percent}%`);
    }
  }
  
  // Make sure the indicator is visible
  indicator.style.opacity = '1';
  
  return indicator;
}

// Function to show completion notification
function showCompletionNotification(count, success = true, errorMessage = null, localFolder = null, skipped = 0, skipReasons = []) {
  // Check if we need to keep the progress indicator for partial uploads
  const keepProgressIndicator = !success && currentProgressInfo && 
                               (currentProgressInfo.completed < currentProgressInfo.total);
  
  if (keepProgressIndicator) {
    console.debug(`[CONTENT LOG] Keeping progress indicator visible because upload is still in progress`);
    // Update the indicator with the current state
    if (document.getElementById('save-progress-indicator')) {
      updateProgressIndicator(currentProgressInfo.completed, currentProgressInfo.total, currentProgressInfo.successCount);
    }
  } else {
    // It's safe to remove the progress indicator
    removeProgressIndicator();
  }
  
  // Restore original title only when we're done or on success
  if (success || !keepProgressIndicator) {
    document.title = originalPageTitle;
  }
  
  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'save-completion-notification';
  
  // Set styles based on success or failure
  const bgColor = success ? '#34A853' : '#EA4335';
  const icon = success ? '✓' : '✗';
  
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: ${bgColor};
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 999999;
    font-family: Arial, sans-serif;
    display: flex;
    align-items: center;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
    max-width: 90%;
    overflow: hidden;
  `;
  
  // Add icon
  const iconEl = document.createElement('div');
  iconEl.style.cssText = `
    font-size: 20px;
    margin-right: 15px;
    font-weight: bold;
    flex-shrink: 0;
  `;
  iconEl.textContent = icon;
  
  // Add message
  const message = document.createElement('div');
  message.style.cssText = `
    flex-grow: 1;
    overflow-wrap: break-word;
  `;
  
  if (success) {
    if (count === 0) {
      if (skipped > 0) {
        const reasonText = skipReasons.length > 0 ? skipReasons.join('; ') : 'file too small or not a valid image type';
        message.textContent = `No images were saved — ${skipped} image${skipped > 1 ? 's were' : ' was'} filtered out: ${reasonText}.`;
      } else {
        message.textContent = 'No images were saved. Images may have been filtered out due to size or content type.';
      }
    } else {
      const base = `Successfully saved ${count} image${count > 1 ? 's' : ''} to your storage`;
      message.textContent = localFolder ? `${base} · Local: Downloads/${localFolder}` : base;
    }
  } else {
    if (count > 0) {
      // Partial success
      message.innerHTML = `Partial success: saved ${count} image${count > 1 ? 's' : ''}<br>` +
                          `Some images failed to upload.`;
      if (errorMessage) {
        message.innerHTML += `<br><small>${errorMessage}</small>`;
      }
    } else {
      // Complete failure
      message.textContent = errorMessage ? 
        `Failed to save images: ${errorMessage}` :
        'Failed to save images. Please check your settings.';
    }
  }
  
  // Add elements to container
  notification.appendChild(iconEl);
  notification.appendChild(message);
  
  // Add to body
  document.body.appendChild(notification);
  
  // Show with animation
  setTimeout(() => {
    notification.style.opacity = '1';
  }, 10);
  
  // Remove after a few seconds - longer for error messages
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (notification.parentNode) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, success ? 5000 : 8000); // Show errors longer
}

// Function to remove progress indicator
function removeProgressIndicator() {
  const indicator = document.getElementById('save-progress-indicator');
  if (indicator && indicator.parentNode) {
    document.body.removeChild(indicator);
  }
}

// Variable to track if the progress listener is active
let progressListenerActive = false;
// Variable to track upload process timeout
let uploadTimeoutId = null;
// Variable to store the latest progress information
let currentProgressInfo = {
  completed: 0,
  total: 0,
  successCount: 0,
  lastUpdate: 0
};

// Register the progress update listener only once
function ensureProgressListener() {
  if (!progressListenerActive) {
    progressListenerActive = true;
    
    console.debug('[CONTENT LOG] Registering progress update listener');
    
    // Listen for progress updates and completion
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Handle regular progress updates
      if (message.action === 'uploadProgress') {
        console.debug(`[CONTENT LOG] Progress update received: ${message.completed}/${message.total} (success: ${message.successCount})`);
        
        // Update our tracking object
        currentProgressInfo = {
          completed: message.completed,
          total: message.total,
          successCount: message.successCount || 0,
          lastUpdate: Date.now()
        };
        
        // Reset timeout if there's an existing one
        if (uploadTimeoutId) {
          clearTimeout(uploadTimeoutId);
        }
        
        // Set a new timeout to detect stalled uploads (30 seconds without updates)
        uploadTimeoutId = setTimeout(() => {
          const timeSinceLastUpdate = Date.now() - currentProgressInfo.lastUpdate;
          console.debug(`[CONTENT LOG] Checking for stalled upload. Time since last update: ${Math.floor(timeSinceLastUpdate/1000)}s`);
          
          if (timeSinceLastUpdate > 30000) {
            console.debug(`[CONTENT LOG] Upload appears stalled after ${Math.floor(timeSinceLastUpdate/1000)}s without updates`);
            // Show a notification if upload appears to be stalled
            const indicator = document.getElementById('save-progress-indicator');
            if (indicator) {
              const messageEl = indicator.lastChild;
              if (messageEl) {
                messageEl.textContent = `Upload may be stalled (${currentProgressInfo.completed}/${currentProgressInfo.total}). Please wait...`;
              }
            }
          }
        }, 30000);
        
        // Update the visual indicator
        updateProgressIndicator(message.completed, message.total, message.successCount);
        
        // Always respond immediately to prevent message channel issues
        try {
          const response = {received: true, timestamp: Date.now()};
          sendResponse(response);
          console.debug(`[CONTENT LOG] Sent response to progress update:`, response);
        } catch (error) {
          console.warn('[CONTENT ERROR] Error sending response to progress update:', error);
        }
      }
      // Handle upload completion message (final result after all processing)
      else if (message.action === 'uploadComplete') {
        console.debug(`[CONTENT LOG] Upload completion message received: success=${message.success}, count=${message.count || 0}/${message.total || '?'}`);
        
        // Clear any pending timeout
        if (uploadTimeoutId) {
          clearTimeout(uploadTimeoutId);
          uploadTimeoutId = null;
          console.debug(`[CONTENT LOG] Cleared timeout after receiving completion message`);
        }
        
        // Now we can safely remove the UI
        const container = document.getElementById('image-selector-container');
        if (container) {
          console.debug(`[CONTENT LOG] Removing image selector UI after confirmation of completion`);
          document.body.removeChild(container);
        }
        
        // Capture the final progress state for debugging
        console.debug(`[CONTENT LOG] Final progress state: ${currentProgressInfo.completed}/${currentProgressInfo.total}, ${currentProgressInfo.successCount} successful`);
        
        // Remove failed (non-skipped) URLs from the dedup set so they can be retried
        if (message.failedUrls && message.failedUrls.length > 0) {
          message.failedUrls.forEach(url => alreadyUploadedUrls.delete(url));
          console.debug(`[CONTENT LOG] Removed ${message.failedUrls.length} failed URLs from dedup set (retryable)`);
        }

        if (message.success) {
          // Show success notification
          console.debug(`[CONTENT LOG] Showing success notification for ${message.count} images`);
          showCompletionNotification(message.count, true, null, message.localFolder, message.skipped || 0, message.skipReasons || []);
          console.debug(`[CONTENT LOG] Successfully saved ${message.count} images.`);
        } else {
          // Show error notification
          console.error(`[CONTENT ERROR] Showing error notification: ${message.error}`);
          showCompletionNotification(currentProgressInfo.successCount || 0, false, message.error);
          console.error(`[CONTENT ERROR] ${message.error || 'Unknown error occurred'}`);
        }
        
        // Always respond to the message
        try {
          sendResponse({received: true, timestamp: Date.now()});
        } catch (error) {
          console.warn('[CONTENT ERROR] Failed to respond to completion message:', error);
        }
      }
      // Do NOT return true here - we're responding synchronously, not async
    });
    
    console.debug('[CONTENT LOG] Progress update listener registered successfully');
  } else {
    console.debug('[CONTENT LOG] Progress listener already active, not registering again');
  }
}

// Function to save images to your storage (S3/R2)
function saveImagesToStorage(images) {
  console.debug(`[CONTENT LOG] Starting save process for ${images.length} images`);
  
  // Filter out images that have already been uploaded in this session
  const newImages = images.filter(image => {
    // Skip if we've already sent this image for upload
    if (alreadyUploadedUrls.has(image.url)) {
      console.debug(`[CONTENT LOG] Skipping already uploaded image: ${image.url.substring(0, 40)}...`);
      return false;
    }
    return true;
  });
  
  // Add all the current images to the alreadyUploadedUrls set
  // so we don't upload them again, even if the upload fails
  images.forEach(image => {
    if (image && image.url) {
      alreadyUploadedUrls.add(image.url);
    }
  });
  
  // If all images have already been uploaded, show a message
  if (newImages.length === 0) {
    console.debug(`[CONTENT LOG] All ${images.length} images have already been sent for upload in this session`);
    showStatusMessage(`All ${images.length} selected images have already been sent for upload in this session.`, 'info');
    return;
  }
  
  console.debug(`[CONTENT LOG] After filtering already uploaded images: ${newImages.length} of ${images.length} images are new`);
  
  // Make sure the progress listener is registered BEFORE we start
  ensureProgressListener();
  
  // Reset progress tracking
  currentProgressInfo = {
    completed: 0,
    total: newImages.length,
    successCount: 0,
    lastUpdate: Date.now()
  };
  console.debug(`[CONTENT LOG] Reset progress tracking`);
  
  // Show progress indicator
  const progressIndicator = createProgressIndicator(newImages.length);
  console.debug(`[CONTENT LOG] Created progress indicator UI`);
  
  // Set a timeout to detect if the upload is taking too long
  if (uploadTimeoutId) {
    clearTimeout(uploadTimeoutId);
    console.debug(`[CONTENT LOG] Cleared existing timeout`);
  }
  
  uploadTimeoutId = setTimeout(() => {
    console.debug(`[CONTENT LOG] Initial timeout check (10s) - progress: ${currentProgressInfo.completed}/${currentProgressInfo.total}`);
    // If no progress updates have been received for 10 seconds at the start, show a message
    if (currentProgressInfo.completed === 0) {
      console.debug(`[CONTENT LOG] No progress after 10s, showing waiting message`);
      const indicator = document.getElementById('save-progress-indicator');
      if (indicator) {
        const messageEl = indicator.lastChild;
        if (messageEl) {
          messageEl.textContent = 'Starting upload, please wait...';
        }
      }
    }
  }, 10000);
  
  console.debug(`[CONTENT LOG] Sending saveImages message to background script with ${newImages.length} images`);
  
  // Get the current folder name if UI is open, otherwise fall back to settings or domain
  const folderInput = document.getElementById('folder-name');
  const folderName = folderInput ? folderInput.value.trim() : (domainSettings.folderName || currentDomain);

  // This would send the selected images to your background script
  chrome.runtime.sendMessage({
    action: 'saveImages',
    images: newImages,
    sourceUrl: window.location.href,
    pageTitle: originalPageTitle,
    folderName: folderName || currentDomain
  }, response => {
    console.debug(`[CONTENT LOG] Received initial response from background script:`, response);
    
    // Check if this is a provisional response
    if (response && response.provisional) {
      console.debug(`[CONTENT LOG] This is a provisional response, not showing completion notification yet`);
      
      // Just hide the selector UI instead of removing it
      // This will keep the progress indicator visible until the upload finishes
      const container = document.getElementById('image-selector-container');
      if (container) {
        console.debug(`[CONTENT LOG] Hiding image selector UI but keeping progress indicator`);
        container.style.display = 'none';
      }
      
      // Don't show any completion notification yet - wait for the uploadComplete message
      return;
    }
    
    // If we got here, it's a final response (not provisional)
    // This might happen with legacy background scripts that don't use the two-phase approach
    
    // Clear any pending timeout
    if (uploadTimeoutId) {
      clearTimeout(uploadTimeoutId);
      uploadTimeoutId = null;
      console.debug(`[CONTENT LOG] Cleared timeout after receiving final response`);
    }
    
    // Just hide the selector UI instead of removing it
    const container = document.getElementById('image-selector-container');
    if (container) {
      console.debug(`[CONTENT LOG] Hiding image selector UI but keeping progress indicator`);
      container.style.display = 'none';
    }
    
    // Capture the final progress state for debugging
    console.debug(`[CONTENT LOG] Final progress state: ${currentProgressInfo.completed}/${currentProgressInfo.total}, ${currentProgressInfo.successCount} successful`);
    
    if (response && response.success) {
      // Show success notification
      // Use the higher of response.count or currentProgressInfo.successCount
      const finalCount = Math.max(response.count || 0, currentProgressInfo.successCount || 0);
      console.debug(`[CONTENT LOG] Showing success notification for ${finalCount} images`);
      showCompletionNotification(finalCount, true);
      console.debug(`[CONTENT LOG] Successfully saved ${finalCount} images.`);
    } else {
      // Show error notification
      console.error(`[CONTENT ERROR] Showing error notification with ${currentProgressInfo.successCount} successful: ${response?.error}`);
      showCompletionNotification(currentProgressInfo.successCount || 0, false, response?.error);
      console.error(`[CONTENT ERROR] ${response?.error || 'Unknown error occurred'}`);
    }
  });
  
  console.debug(`[CONTENT LOG] SaveImagesToStorage function completed, waiting for async responses`);
}

const previousCaptureStates = new Map();
const captureConfigCache = new Map();

function showAutoCaptureToast(message, success) {
  document.getElementById('auto-capture-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'auto-capture-toast';
  toast.setAttribute('role', success ? 'status' : 'alert');
  toast.textContent = message;
  toast.style.cssText = `position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    max-width: 90%; padding: 12px 16px; border-radius: 5px; color: white;
    background: ${success ? '#34A853' : '#EA4335'}; font: 14px Arial, sans-serif;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), success ? 5000 : 8000);
}

async function loadCaptureSiteConfig() {
  const domain = window.location.hostname.toLowerCase();
  if (!captureConfigCache.has(domain)) {
    captureConfigCache.set(domain, (async () => {
      let response;
      try { response = await fetch(chrome.runtime.getURL(`site_config/${domain}.json`)); }
      catch (_) { response = null; } // A missing packaged extension resource rejects in Chromium.
      if (response?.ok) {
        try {
          const config = await response.json();
          return config?.domain === domain ? config : null;
        } catch (_) { return null; }
      }
      if ((response && response.status !== 404) || !domain.startsWith('www.')) return null;
      const bare = domain.slice(4);
      if (!bare || bare.startsWith('www.')) return null;
      let fallback;
      try { fallback = await fetch(chrome.runtime.getURL(`site_config/${bare}.json`)); }
      catch (_) { return null; }
      if (!fallback?.ok) return null;
      try {
        const config = await fallback.json();
        return config?.domain === bare ? {...config, domain} : null;
      } catch (_) { return null; }
    })());
  }
  return captureConfigCache.get(domain);
}

function captureJsonLd() {
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(node => { try { return JSON.parse(node.textContent); } catch (_) { return null; } })
    .filter(value => value !== null);
}

function capturePageProductEvidence() {
  const readItem = selector => {
    const node = document.querySelector(selector);
    return node?.getAttribute?.('content') || node?.textContent?.trim() || null;
  };
  let microdata = null;
  if (document.querySelector('[itemscope][itemtype*="Product"]')) {
    const sku = document.querySelector('form[data-product-sku]')?.getAttribute('data-product-sku') || null;
    const productID = document.querySelector('input[name="product"]')?.value || null;
    const color = document.querySelector('.product-colors .current-color img[alt]')?.getAttribute('alt') || null;
    microdata = {name: readItem('[itemprop="name"]'), sku, productID, color,
      offers: {price: readItem('[itemprop="price"]'),
        priceCurrency: readItem('[itemprop="priceCurrency"]')},
      field_sources: {sku: 'form[data-product-sku]', productID: 'input[name=product]',
        color: '.product-colors .current-color img[alt]'}};
  }
  const meta = {};
  for (const node of document.querySelectorAll('meta[property]')) {
    const property = node.getAttribute('property');
    if (['og:type', 'og:title', 'og:image', 'product:price:amount',
      'product:price:currency'].includes(property)) meta[property] = node.getAttribute('content');
  }
  if (window.location.hostname === 'www.victoriassecret.com' &&
      document.querySelector('img[id^="primaryProductAltImages-"]')) {
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const path = canonical && new URL(canonical, window.location.href).pathname;
    const id = path?.match(/^\/us\/(?:vs|pink)\/[^/]+-catalog\/(\d+)(?:\/|$)/)?.[1];
    if (id) {
      const priceNode = document.querySelector('[data-testid="ProductPrice"] [itemprop="price"]');
      const display = priceNode?.getAttribute('content') || priceNode?.textContent || '';
      const price = display.trim().match(/^\$(\d+(?:\.\d{2})?)$/)?.[1] || null;
      const rendered = {name: readItem('[data-testid="ProductInfo-shortDescription"]'),
        productID: id, sku: readItem('[data-testid="ProductInfo-genericId"]')?.replace(/^Product SKU\s*/, '') || null,
        color: readItem('[data-testid="SelectedChoiceLabel"]')?.replace(/^\|\s*/, '') || null,
        offers: {price, priceCurrency: price ? 'USD' : null},
        field_sources: {name:'[data-testid="ProductInfo-shortDescription"]',
          productID:'link[rel="canonical"] US catalog path', sku:'[data-testid="ProductInfo-genericId"]',
          color:'[data-testid="SelectedChoiceLabel"]', price:'[data-testid="ProductPrice"] [itemprop="price"]',
          priceCurrency:'US market path and dollar price'}};
      const evidence = globalThis.PageImageSaverHelpers.captureProductEvidence([], rendered, null);
      evidence.jsonld = captureJsonLd();
      evidence.meta = Object.keys(meta).length ? meta : null;
      return evidence;
    }
  }
  return globalThis.PageImageSaverHelpers.captureProductEvidence(captureJsonLd(), microdata,
    Object.keys(meta).length ? meta : null);
}

function capturePageProduct() {
  return capturePageProductEvidence().facts;
}

function captureProductSeen(config, product = capturePageProduct()) {
  if (config?.product?.pageSelector) return !!document.querySelector(config.product.pageSelector);
  return !!(product.name || product.sku || product.product_id || product.color ||
    document.querySelector('meta[property="og:type"][content="product"]'));
}

function captureGallery(config, mode) {
  if (mode === 'site' && config?.product?.renditionResolver === 'victoriassecret' &&
      window.location.hostname === 'www.victoriassecret.com') {
    const candidates = document.documentElement.innerHTML.match(/(?:https:\/\/)?www\.victoriassecret\.com\/p\/\d+x\d+\/[^\s"<>\\]+/g) || [];
    return [...new Set(Array.from(document.querySelectorAll(config.product.allImagesSelector), node =>
      globalThis.PageImageSaverHelpers.victoriasSecretImage(node.getAttribute('src') || node.currentSrc, candidates)))];
  }
  let urls;
  if (mode === 'site') {
    const selector = config?.product?.allImagesSelector || config?.allImagesSelector || config?.product?.imageSelector;
    if (!selector) throw new Error('No product image selector in this site config');
    urls = Array.from(document.querySelectorAll(selector), node => config?.product?.lazyLoad ?
      node.getAttribute('src') || node.currentSrc :
      node.getAttribute('data-src') || node.currentSrc || node.getAttribute('src') || node.getAttribute('href'));
  } else {
    const checked = document.querySelectorAll('#image-selector-container input[type="checkbox"]:checked');
    urls = Array.from(checked, node => currentFilteredImages[Number(node.dataset.index)]?.url);
  }
  if (mode === 'site' && config?.product?.originalImageUrlPattern) {
    const resolved = Array.from(document.querySelectorAll(config.product.allImagesSelector),
      node => globalThis.PageImageSaverHelpers.galleryNodeOriginal(node, config, document));
    urls = resolved.map(item => item.url).filter(Boolean);
    if (!urls.length) throw resolved.find(item => item.error)?.error || new Error('gallery original: no image nodes');
  }
  const unique = new Set();
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') unique.add(url.href);
    } catch (_) { /* Ignore non-image or malformed discovered URLs. */ }
  }
  if (!unique.size) throw new Error('No selected product images');
  return Array.from(unique);
}

function captureSwatchColor() {
  const swatch = document.querySelector('[aria-selected="true"][data-color], [aria-checked="true"][data-color]');
  return swatch?.getAttribute('data-color') || null;
}

function captureSelectedColor(product) {
  return product.color || captureSwatchColor() || document.getElementById('capture-color')?.value.trim() || null;
}

function captureCanonicalUrl() {
  const candidate = document.querySelector('link[rel="canonical"]')?.href;
  try {
    if (candidate && new URL(candidate).hostname === window.location.hostname) return candidate;
  } catch (_) { /* Use the visited URL. */ }
  return window.location.href;
}

function capturePageHtml() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelector('#image-selector-container')?.remove();
  return '<!doctype html>\n' + clone.outerHTML;
}

async function recordCaptureFailure(error) {
  return globalThis.PageImageSaverHelpers.recordCaptureFailure(chrome, window.location.href, error);
}

function assertTakeoverBinding(binding) {
  if (!binding) return;
  const same = globalThis.PageImageSaverHelpers.sameDocumentUrl;
  if (binding.documentId !== takeoverDocumentId ||
      !same(window.location.href, binding.documentUrl || binding.expectedUrl) ||
      (!same(captureCanonicalUrl(), binding.expectedUrl) && !same(captureCanonicalUrl(), binding.documentUrl))) {
    throw new Error('take-over document or product URL changed');
  }
}

function rescanCaptureImages() {
  const displayedImages = currentFilteredImages;
  try { findAllImages(); }
  finally {
    // A rescan updates discovery, but does not rebuild the panel's indexed checkboxes.
    if (document.getElementById('image-selector-container')) currentFilteredImages = displayedImages;
  }
}

async function captureCurrentProduct({manual, scopeOverride = null, binding = null, autoPageLoad = false}) {
  assertTakeoverBinding(binding);
  const config = await loadCaptureSiteConfig();
  const mode = manual ? document.getElementById('capture-image-mode').value : 'site';
  const selectedGallery = config?.product?.lazyLoad && mode === 'selected' ? captureGallery(config, mode) : null;
  if (config?.product?.lazyLoad) {
    await globalThis.PageImageSaverHelpers.prepareLazyGallery(config, document);
    rescanCaptureImages();
  }
  const sameColorControl = manual ? document.getElementById('capture-same-color-selection') : null;
  const allowSameColorGalleryChange = !!sameColorControl?.checked;
  if (sameColorControl) sameColorControl.checked = false;
  if (allowSameColorGalleryChange && mode !== 'selected') {
    throw new Error('Same-color image reselection requires selected checkboxes');
  }
  const policy = manual ? document.getElementById('capture-color-policy').value :
    config?.colorVariantStrategy === 'separate-url' ? 'url' : 'color';
  const readState = () => {
    const product = capturePageProduct();
    const gallery = selectedGallery || captureGallery(config, mode);
    const swatchColor = captureSwatchColor();
    return {color: policy === 'url' ? captureCanonicalUrl() : captureSelectedColor(product), gallery,
      colorConflict: !!(product.color && swatchColor && product.color !== swatchColor)};
  };
  const url = binding?.expectedUrl || captureCanonicalUrl();
  const previous = previousCaptureStates.get(url);
  const state = await globalThis.PageImageSaverHelpers.waitForCaptureState(readState, previous,
    {timeoutMs: 8000, pollMs: 200, allowSameColorGalleryChange: manual && allowSameColorGalleryChange});
  const evidence = capturePageProductEvidence();
  const product = evidence.facts;
  const color = policy === 'url' ? captureSelectedColor(product) : state.color;
  const identity = globalThis.PageImageSaverHelpers.captureIdentity(url, policy, color);
  const decision = scopeOverride?.decision || (manual ? document.getElementById('capture-scope').value : 'review');
  const customReason = manual ? document.getElementById('capture-scope-reason').value.trim() : '';
  const scope = {decision, reason: scopeOverride?.reason || customReason ||
    (manual ? `user-selected ${decision}` : 'automatic page-load capture; scope unclassified')};
  const transform = config?.product?.highResTransform;
  const images = state.gallery.map(url => globalThis.PageImageSaverHelpers.captureImageUrls(url, transform));
  const payload = {identity, captured_at: new Date().toISOString(), scope, product,
    html: capturePageHtml(), jsonld: evidence, images};
  assertTakeoverBinding(binding); // Guard before background image acquisition.
  const result = await new Promise((resolve, reject) => chrome.runtime.sendMessage(
    {action: 'captureProductLocal', payload, runBinding: binding, autoPageLoad}, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.success) reject(new Error(response?.error || 'local capture failed'));
      else resolve(response);
    }));
  previousCaptureStates.set(url, state);
  return binding ? {...result, identity} : result;
}

function takeoverRequest(action, data = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({action, ...data}, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.success) reject(new Error(response?.error || 'catalog request failed'));
    else resolve(response);
  }));
}

let takeoverRefreshSequence = 0;
async function refreshTakeoverProgress() {
  const box = document.getElementById('takeover-progress');
  if (!box || box.dataset.previewPending === 'true') return;
  const refreshSequence = ++takeoverRefreshSequence;
  try {
    const {run, summary} = await takeoverRequest('takeoverStatus');
    if (refreshSequence !== takeoverRefreshSequence || box.dataset.previewPending === 'true') return;
    const currentHost = window.location.hostname.toLowerCase();
    const foreignRun = !!run && run.domain !== currentHost;
    const statusLine = document.getElementById('takeover-status-line');
    statusLine.hidden = !run;
    statusLine.textContent = !run ? '' : foreignRun ?
      `Saved run belongs to ${run.domain} — ${run.status}` :
      PageImageSaverHelpers.takeoverStatusText(run, summary);
    const startUrl = document.getElementById('takeover-start-url');
    startUrl.textContent = `Start URL: ${!foreignRun && run?.seedUrl || 'preview a listing or load a discovery queue'}`;
    const modeControl = document.getElementById('takeover-mode');
    if (run && !foreignRun && !modeControl.dataset.userChanged) modeControl.value = run.mode || 'capture';
    for (const id of ['takeover-start-btn', 'takeover-pause-btn', 'takeover-resume-btn',
      'takeover-stop-btn', 'takeover-export-btn']) {
      document.getElementById(id).disabled = foreignRun;
    }
    if (!run) { box.textContent = 'Preview a listing or load discovery exports to prepare a run.'; return; }
    if (foreignRun) {
      box.textContent = `Saved catalog ${run.status} belongs to ${run.domain}. This page is ${currentHost}. ` +
        (['running', 'paused'].includes(run.status) ?
          `That run must stop or finish before previewing this site.` :
          `Preview this page to start a catalog preview here.`);
      return;
    }
    const samples = (run.previews || []).map(page => `${page.kind}: ${page.url}` +
      (page.products == null ? ` — ${page.product?.name || 'unknown product'}, ` +
        `${page.imageCount || 0} gallery images, ${page.colorLinks || 0} color links, ` +
        `${page.scope?.decision || 'review'} (${page.scope?.reason || 'unclassified'})` :
        ` — ${page.products} product links, next ${page.next || 'absent'}, ` +
        `end ${JSON.stringify(page.end || 'unverified')}`));
    const pacing = summary.pacing;
    const pacingText = pacing ? `Pacing ${pacing.minMs / 1000}–${pacing.maxMs / 1000} s between navigation starts.\n` : '';
    if (run.mode === 'capture-discovery') {
      box.textContent = `Fixed discovery queue ${run.status}${run.reason ? ` — ${run.reason}` : ''}\n` +
        pacingText + `Targets ${summary.productsFound}; captured ${summary.productsCaptured}; gone ${summary.gone || 0}; receiver-verified skips ${summary.skipped || 0}; ` +
        `failed ${summary.failed}; pending ${summary.pending}; exported/unverified ${summary.exportedUnverified}.\n` +
        'Only these product URLs will be visited. Gone products are skipped without capture. All other skips require receiver verification; Downloads are unverified.';
      return;
    }
    if (run.mode === 'discovery') {
      box.textContent = `Listing discovery ${run.status}${run.reason ? ` — ${run.reason}` : ''}\n` +
        pacingText + `${samples.join('\n')}\nListings ${summary.listingPagesVisited}; unique product URLs ${summary.productsFound}.\n` +
        (run.preview?.endCheckConfigured ? 'Positive end check configured.' :
          'No positive end check configured; missing next link will finish with gaps.');
      return;
    }
    const end = run.preview?.endCheckConfigured ? 'Positive end check configured.' :
      'No verified positive end check configured; discovered products will capture, then finish with gaps.';
    box.textContent = `Catalog ${run.status}${run.reason ? ` — ${run.reason}` : ''}\n${end}\n` +
      pacingText + `${samples.join('\n')}\nListings ${summary.listingPagesVisited}; found ${summary.productsFound}; ` +
      `captured products ${summary.productsCaptured}; captured colors ${summary.colorsCaptured}; ` +
      `size options traversed ${summary.sizeOptionsTraversed} (size cycling is not part of this run); ` +
      `excluded ${summary.excluded}; gone ${summary.gone || 0}; failed ${summary.failed}; pending ${summary.pending}; ` +
      `exported/unverified ${summary.exportedUnverified}.\n` +
      (run.products || []).filter(row => row.status === 'failed').map(row => `${row.url}: ${row.reason}`).join('\n') +
      '\nVerified skips require the local receiver. Downloads exports are unverified until imported.';
  } catch (error) {
    if (refreshSequence === takeoverRefreshSequence && box.dataset.previewPending !== 'true') {
      box.textContent = `Catalog status unavailable: ${error.message}`;
      const statusLine = document.getElementById('takeover-status-line');
      statusLine.hidden = false;
      statusLine.textContent = box.textContent;
    }
  }
}

function takeoverCategory() {
  for (const raw of captureJsonLd()) {
    const candidates = Array.isArray(raw) ? raw : raw?.['@graph'] || [raw];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (types.some(type => typeof type === 'string' && /Product$/i.test(type)) && item.category) {
        return Array.isArray(item.category) ? item.category.join(' / ') : String(item.category);
      }
    }
  }
  return document.querySelector('[itemprop="category"], nav.breadcrumbs, .breadcrumbs')?.textContent?.trim() || '';
}

async function inspectTakeoverPage(config, mode = 'capture', expect = null) {
  const challengeText = `${document.title} ${document.body?.innerText?.slice(0, 2000) || ''}`;
  if (/verify you are human|unusual traffic|access denied|captcha|bot challenge/i.test(challengeText) ||
      document.querySelector('iframe[src*="captcha"], .g-recaptcha, [data-sitekey]')) {
    return {kind: 'challenge', url: window.location.href};
  }
  let product = capturePageProduct();
  let productSeen = captureProductSeen(config, product);
  // A product URL from a fixed queue may still be hydrating at tab "complete"; give it time
  // before reading the page as a listing (which the runner treats as a structure mismatch).
  for (const deadline = Date.now() + 8000; expect === 'product' && !productSeen && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 250));
    product = capturePageProduct();
    productSeen = captureProductSeen(config, product);
  }
  if (productSeen) {
    if (mode === 'discovery') throw new Error('Listing discovery needs a listing page');
    if (config?.product?.lazyLoad) {
      await globalThis.PageImageSaverHelpers.prepareLazyGallery(config, document);
      rescanCaptureImages();
    }
    await globalThis.PageImageSaverHelpers.waitForAutoCaptureReady(() => {
      let gallery = [];
      try { gallery = captureGallery(config, 'site'); } catch (_) { /* Still loading. */ }
      return {productSeen: true, gallery};
    }, {timeoutMs: 8000, pollMs: 200});
    const selector = config.product?.colorLinkSelector ||
      config.product?.variantTriggers?.find(trigger => trigger.label === 'color')?.selector;
    const colorLinks = selector ? Array.from(document.querySelectorAll(selector), node => node.href)
      .filter(Boolean) : [];
    return {kind: 'product', url: window.location.href, documentId: takeoverDocumentId,
      product: {...product, category: takeoverCategory()}, colorLinks,
      imageCount: captureGallery(config, 'site').length};
  }
  const selector = config.listing?.productLinkSelector;
  const nextSelector = config.listing?.pagination?.nextSelector;
  if (!selector || !nextSelector) throw new Error('listing selectors are missing');
  let products = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    products = Array.from(document.querySelectorAll(selector), node => node.href).filter(Boolean);
    if (products.length) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const next = document.querySelector(nextSelector)?.href || null;
  const cards = mode === 'discovery' ? Array.from(document.querySelectorAll(selector), node => ({
    url: node.href,
    card_text: (node.closest('.product-card, [data-testid="ProductCard"], article') || node)
      .textContent.replace(/\s+/g, ' ').trim()
  })).filter(card => card.url) : undefined;
  const check = config.listing?.endCheck;
  const node = check?.selector ? document.querySelector(check.selector) : null;
  let end = null;
  if (check?.type === 'explicit') end = {type: 'explicit', present: !!node};
  if (check?.type === 'page-count') {
    const match = node?.textContent?.match(/\bpage\s+(\d+)\s+(?:of|\/)\s+(\d+)\b/i);
    if (match) end = {type: 'page-count', current: Number(match[1]), total: Number(match[2])};
  }
  if (check?.type === 'result-total') {
    const match = node?.textContent?.match(/\b(\d+)\s+(?:results?|items?|products?)\b/i);
    if (match) end = {type: 'result-total', total: Number(match[1])};
  }
  return {kind: 'listing', url: window.location.href,
    documentId: takeoverDocumentId, products, cards, locale: document.documentElement.lang || null, next, end};
}

// A site must be explicitly enabled in the panel, and must have a product
// selector config. Unknown sites remain a manual, user-selected workflow.
setTimeout(async () => {
  const config = await loadCaptureSiteConfig();
  if (!config?.product?.allImagesSelector) return;
  chrome.storage.local.get({captureAutoDomains: {}}, async result => {
    if (!result.captureAutoDomains[window.location.hostname]) return;
    try {
      if (!(await takeoverRequest('autoCaptureAllowed')).allowed) return;
      const ready = await globalThis.PageImageSaverHelpers.waitForAutoCaptureReady(() => {
        const product = capturePageProduct();
        let gallery = [];
        try { gallery = captureGallery(config, 'site'); } catch (_) { /* Gallery may render later. */ }
        return {productSeen: captureProductSeen(config, product), gallery};
      }, {timeoutMs: 8000, pollMs: 200,
        prepare: config.product.lazyLoad ? async () => {
          await globalThis.PageImageSaverHelpers.prepareLazyGallery(config, document);
          rescanCaptureImages();
        } : null});
      if (!ready) return;
      if (!(await takeoverRequest('autoCaptureAllowed')).allowed) return;
      const capture = await captureCurrentProduct({manual: false, autoPageLoad: true});
      if (capture?.storage === 'receiver' &&
          ['published', 'reused', 'already'].includes(capture.status)) {
        showAutoCaptureToast('Product capture verified locally.', true);
      } else if (capture?.storage === 'downloads') {
        showAutoCaptureToast('Product exported to Downloads; import to verify.', true);
      } else {
        throw new Error('local capture returned an unverified result');
      }
    } catch (error) {
      showAutoCaptureToast(`Automatic product capture failed: ${String(error?.message || error)}`, false);
      await recordCaptureFailure(error);
      console.warn('Automatic local product capture failed:', error);
    }
  });
}, 1000);

// Share the panel entry point between Chrome's toolbar and a page-level shortcut.
function openImageSelector(sendResponse = () => {}) {
  const existingContainer = document.getElementById('image-selector-container');
  if (existingContainer) {
    sendResponse({success: true, count: parseInt(existingContainer.getAttribute('data-images-count') || '0')});
    return true;
  }

  currentDomain = getCurrentDomain();
  loadDomainSettings(currentDomain, (settings) => {
    domainSettings = settings;
    const images = findAllImages();
    createImageSelectionUI(images);
    sendResponse({success: true, count: images.length});
  });
  return true;
}

// Browser automation can send this shortcut to the page even when it cannot
// operate Chrome's extension toolbar or its browser-level shortcut.
document.addEventListener('keydown', (event) => {
  if (!globalThis.PageImageSaverHelpers.isFindImagesPageShortcut(event)) return;
  event.preventDefault();
  openImageSelector();
}, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'takeoverInspect') {
    loadCaptureSiteConfig().then(config => {
      if (!config) throw new Error('site config unavailable');
      return inspectTakeoverPage(config, message.mode, message.expect || null);
    }).then(page => sendResponse({success: true, page}))
      .catch(error => sendResponse({success: false, error: String(error?.message || error)}));
    return true;
  } else if (message.action === 'takeoverDocumentCheck') {
    sendResponse({success: true, documentId: takeoverDocumentId, url: window.location.href});
    return false;
  } else if (message.action === 'takeoverCapture') {
    try { assertTakeoverBinding(message.binding); }
    catch (error) { sendResponse({success: false, error: error.message}); return false; }
    captureCurrentProduct({manual: false, scopeOverride: message.scope,
      binding: message.binding})
      .then(result => sendResponse({success: true, result}))
      .catch(error => sendResponse({success: false, error: String(error?.message || error)}));
    return true;
  } else if (message.action === 'findImages') {
    return openImageSelector(sendResponse);
  } else if (message.action === 'takeScreenshot') {
    if (window.PageScreenshot) {
      window.PageScreenshot.initiateScreenshot();
      sendResponse({success: true});
    } else {
      console.error('Screenshot module not found');
      sendResponse({success: false, error: 'Screenshot module not found'});
    }
    return true;
  } else if (message.action === 'dynamicImageLoaded') {
    handleDynamicImage(message.url);
    try { sendResponse({received: true}); } catch (e) {}
    return true;
  } else if (message.action === 'dynamicStreamLoaded') {
    handleDynamicStream(message.url);
    try { sendResponse({received: true}); } catch (e) {}
    return true;
  }
});

// Log that the content script has loaded
console.log('Page Image Saver content script loaded.');

// ================= Dynamic Image Capture (network & DOM & hover) =================
(function() {
  // 2. MutationObserver to catch transient DOM additions/removals
  // Attribute changes (style/class) are collected and processed in a debounced batch
  // to avoid expensive getComputedStyle calls on every CSS transition frame.
  let _attrMutationTimer = null;
  const _pendingAttrNodes = new Set();

  function flushAttrMutations() {
    _attrMutationTimer = null;
    for (const node of _pendingAttrNodes) {
      try {
        const style = window.getComputedStyle(node);
        const bg = style.backgroundImage;
        if (bg && bg.startsWith('url(')) {
          const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
          if (m && m[1] && !shouldSkipImage(m[1])) {
            handleDynamicImage(m[1]);
          }
        }
      } catch (error) {
        // Ignore style computation errors on invalid nodes
      }
    }
    _pendingAttrNodes.clear();
  }

  const mo = new MutationObserver(records => {
    records.forEach(record => {
      record.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;

        // Process IMG elements
        if (node.tagName === 'IMG' && node.src) {
          // Skip tiny images likely to be tracking pixels
          if (node.width > 10 && node.height > 10 && !shouldSkipImage(node.src)) {
            handleDynamicImage(node.src);
          }
        }

        // Process background images
        try {
          const style = window.getComputedStyle(node);
          const bg = style.backgroundImage;
          if (bg && bg.startsWith('url(')) {
            const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
            if (m && m[1] && !shouldSkipImage(m[1])) {
              handleDynamicImage(m[1]);
            }
          }
        } catch (error) {
          // Ignore style computation errors on invalid nodes
        }
      });

      // Collect attribute-changed nodes and flush in a debounced batch (300ms idle)
      if (record.type === 'attributes' && record.target.nodeType === 1) {
        _pendingAttrNodes.add(record.target);
        clearTimeout(_attrMutationTimer);
        _attrMutationTimer = setTimeout(flushAttrMutations, 300);
      }
    });
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });

  // 3. Hover listener to catch pop-up or lazy-loaded content on mouseover
  // Debounced: only runs if the sidebar is open, and at most once per 500ms of idle
  let hoverTimer;
  document.addEventListener('mouseover', () => {
    if (!document.getElementById('image-selector-container')) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      findAllImages();
    }, 500);
  }, true);
})();
// =======================================================================
