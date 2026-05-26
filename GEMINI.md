# Page Image Saver

## Project Overview
Page Image Saver is a Chrome extension designed to extract images from web pages and save them directly to AWS S3 or Cloudflare R2 storage. It also features the ability to capture full-page or visible-area screenshots with customizable DPI settings (up to 288 DPI).

The extension is built using **Manifest V3** and relies on **Vanilla JavaScript** (ES Modules), HTML, and CSS. The architecture consists of:
- `background.js`: A service worker that handles network requests, downloads, and extension state.
- `content_script.js`: Injected into web pages to scan the DOM for images (including background images and `srcset` parsing) and inject the UI sidebar.
- `screenshot.js`: Handles the logic for capturing and processing screenshots.
- `settings.html` / `settings.js`: The options page for users to configure their AWS/R2 credentials and preferences.

## Building and Running

Since this is a vanilla JavaScript extension, there is no complex build process required for development.

### Running Locally (Development)
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the root directory of this project (`page-image-saver`).
4. Any changes to HTML/CSS/JS (except `background.js`) usually reflect upon reloading the extension or refreshing the page. For `background.js` changes, click the refresh icon on the extension card in `chrome://extensions/`.

### Packaging for Distribution
To create a zip file for the Chrome Web Store, run the package script defined in `package.json`:
```bash
npm run package
```
This will create a `dist/page-image-saver.zip` file.

## Development Conventions

- **Vanilla Web Technologies:** The codebase avoids heavy frameworks or bundlers, relying on native DOM manipulation and modern JavaScript features.
- **Chrome Extension APIs:** Heavy reliance on `chrome.storage.sync` for settings, `chrome.tabs.sendMessage` for background-to-content communication, and `chrome.webRequest` for intercepting dynamic image loads.
- **Permissions:** The extension requires broad host permissions (`<all_urls>`) and specific API permissions (`activeTab`, `storage`, `downloads`, `webRequest`, etc.) as defined in `manifest.json`.
- **Modularity:** Keep logic separated based on the extension architecture (UI logic in content scripts/settings, background tasks and API calls in the service worker).
