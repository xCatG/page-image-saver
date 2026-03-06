# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run package` - Create a distribution zip in `dist/` (zips manifest.json, *.js, *.md, icons/*.svg)

## Extension Loading/Testing

1. Navigate to `chrome://extensions/`, enable Developer mode
2. Click "Load unpacked" and select the extension directory
3. Test with `test-page.html` (open in browser) using Alt+Shift+I to trigger image discovery

No build step is required — the extension runs directly from source files.

## Architecture Overview

This is a **Chrome Manifest V3 extension** with no bundler or build pipeline. All JS runs directly in the browser.

### Component Roles

| File | Context | Role |
|------|---------|------|
| `background.js` | Service worker | Upload orchestration, context menus, keyboard shortcuts, webRequest monitoring |
| `content_script.js` | Injected into every page | UI sidebar, image discovery, filtering, thumbnail rendering |
| `screenshot.js` | Web-accessible resource, injected on demand | Full-page screenshot capture (canvas stitching) |
| `settings.js` + `settings.html` | Extension options page | Credentials config for S3/R2 |

### Message Flow

```
User action (click/keyboard)
  → background.js (handles chrome.commands / contextMenus)
    → content_script.js via chrome.tabs.sendMessage (action: 'findImages')
      → user selects images
        → content_script.js sends chrome.runtime.sendMessage (action: 'saveImages')
          → background.js uploads to S3/R2
            → provisional sendResponse() immediately (keeps channel open)
            → sends uploadComplete / uploadProgress messages back to tab
```

Key message actions handled in `background.js`:
- `saveImages` — upload selected images to configured storage
- `captureVisibleTab` / `processScreenshot` — screenshot pipeline
- `testConnection` — credential validation from settings page
- `debugShowDownloadPaths` — debugging helper

### Dynamic Image Discovery

`background.js` uses `chrome.webRequest.onCompleted` to detect images loaded after initial page render and forwards them to the content script via `dynamicImageLoaded` messages. The content script uses a `MutationObserver` as an additional discovery channel.

Deduplication: `discoveredUrls` (Set) prevents duplicate discovery; `alreadyUploadedUrls` (Set) prevents re-uploading across paginated pages within a session.

### AWS SDK Loading

The AWS SDK (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) is loaded via **dynamic `import()` from CDN** at upload time — not bundled. This avoids extension size limits but requires network access on first upload.

### Storage

All credentials and settings are persisted via `chrome.storage.sync`. Domain-specific size filters are stored under the `domainSizeFilters` key.

### Backend Examples

`backend-examples/` contains reference implementations for server-side upload proxies (Cloudflare Worker + R2, AWS Lambda + S3 presigned URLs) — these are not part of the extension itself.

## Key Conventions

- Background script must `return true` from `onMessage` listeners that respond asynchronously
- Two-phase upload response: send provisional `sendResponse()` immediately, then send a separate `uploadComplete` message when done (MV3 service workers time out message channels)
- CORS fallback order for image loading: no `crossOrigin` attr → `crossOrigin="anonymous"` → no attr as last resort
- Tracking pixel filtering happens in both `background.js` (`isTrackingPixel()`) and `content_script.js` (`shouldSkipImage()`)