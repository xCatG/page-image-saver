# Page Image Saver Extension Fix

## Issue Summary
The Page Image Saver Chrome extension was encountering errors when attempting to upload images to Cloudflare R2 storage. The specific error was:

```
TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point.
```

This error occurred in the `uploadToR2WithToken` function when trying to upload images using the Cloudflare API token method. The error suggests that non-standard characters were present in the headers being sent with the fetch request.

## Changes Made

### 1. Fixed R2 Upload with API Token
- Modified the `uploadToR2WithToken` function to simplify headers
- Temporarily disabled metadata headers (X-Amz-Meta-*) which were likely containing non-ASCII characters
- Added proper fallback mechanisms when API token upload fails

### 2. Added Fallback Mechanisms
- Implemented a cascading fallback strategy:
  - If API token method fails, try API keys method if credentials are available
  - If R2 upload fails completely, fall back to local download if enabled
  - Automatically enable local download as a last resort if other methods fail

### 3. Enhanced Error Handling
- Improved error detection and reporting throughout the upload process
- Added more detailed logging with the `debugLog` function
- Made the code more resilient to configuration issues

### 4. Code Improvements
- Modified the `uploadToStorage` function to properly handle errors and attempt fallbacks
- Updated the image processing function to ensure local saving is tried when needed
- Added sanitization for strings used in headers to prevent encoding issues
  
### 5. Dynamic Image Discovery Enhancements
- Added a `chrome.webRequest.onCompleted` listener in the background service worker to intercept **all** image network requests (including those never inserted into the DOM) and forward each URL to the content script via a `dynamicImageLoaded` message.
- Introduced `handleDynamicImage(url)` in the content script: uses a JS `Image()` object to load transient images, extract natural dimensions, construct a full metadata object, and feed it into the existing UI if it passes domain size filters.
- Deployed a `MutationObserver` on `document.documentElement` to watch for newly added `<img>` elements and CSS `background-image` changes (including elements that appear only on hover or via dynamic scripts), routing all discovered URLs to `handleDynamicImage`.
- Implemented a global `mouseover` listener (with a short debounce) to trigger `findAllImages()` on hover events, catching pop‑up or lazy‑load widgets that inject/remove nodes too quickly for the observer alone.
- Centralized de‑duplication via a global `discoveredUrls` `Set`, ensuring no URL is processed more than once across the initial static scan, network-level intercepts, and DOM hooks.
- Wrapped all `chrome.tabs.sendMessage` calls in callback form to handle `chrome.runtime.lastError` and avoid uncaught exceptions when sending to tabs without a listener.
- Introduced a `dynamicImageObjs` cache to store images discovered *before* the UI is opened and merged this cache into the static initial scan in `findAllImages()`, ensuring pre-UI hover and lazy-loaded images appear when the picker is first displayed.

## Testing Results
The fixes allow images to be saved even if there are issues with the R2 upload process. If R2 upload fails, the extension will attempt to save locally based on the user's settings.

## Technical Notes
The root cause of the issue was non-standard characters (likely in page titles or URLs) being included in HTTP headers, which are restricted to ISO-8859-1 encoding. By simplifying the headers and adding proper fallback methods, the extension can now handle these cases gracefully.

## Future Improvements
1. Re-enable metadata with proper encoding once the basic functionality is stable
2. Add user-friendly error messages about storage issues
3. Consider implementing a queuing system for failed uploads to retry later
4. Add more detailed reporting on why specific images failed to save
