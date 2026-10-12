# Page Image Saver - Installation Guide

This guide will walk you through setting up and configuring the Page Image Saver extension.

## Basic Installation

1. **Download the code**:
   - Clone or download this repository to your local machine

2. **Load the extension in Chrome**:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right corner
   - Click "Load unpacked" and select the extension directory
   - The extension icon should appear in your browser toolbar

3. **Test the extension**:
   - Open the included `test-page.html` file in your browser
   - Click the extension icon or press Alt+Shift+I
   - The extension should display a sidebar with images found on the page

At this point, the extension will work for finding images, but won't actually upload them until you configure a storage backend.

## Updating an unpacked installation

After updating the files, press **Reload** on the extension at `chrome://extensions/`, then
refresh existing storefront tabs. A browser restart or manifest version change alone may
leave an older service worker cached while new page scripts load. Perform the explicit
reload when no capture is in progress. See [DISCOVERY.md](DISCOVERY.md) for discovery import
recovery and persistent-profile test guidance.

## Configuring Storage Backend

### Option 1: AWS S3

1. **Create an S3 bucket**:
   - Log in to your AWS Console
   - Create a new S3 bucket or use an existing one
   - Configure CORS to allow uploads from your browser:
   ```json
   [
     {
       "AllowedHeaders": ["*"],
       "AllowedMethods": ["PUT", "POST", "GET"],
       "AllowedOrigins": ["chrome-extension://<YOUR-EXTENSION-ID>"],
       "ExposeHeaders": []
     }
   ]
   ```
   (Replace `<YOUR-EXTENSION-ID>` with your extension's ID, found on the `chrome://extensions/` page)

2. **Create a Lambda function**:
   - Create a new Lambda function using the example in `backend-examples/aws-lambda-s3-presigned.js`
   - Set up an API Gateway endpoint to trigger the Lambda function
   - Configure the necessary IAM permissions for the Lambda function to access your S3 bucket

3. **Update extension configuration**:
   - Edit `background.js` and update the CONFIG section:
   ```javascript
   const CONFIG = {
     useS3: true,
     s3: {
       apiEndpoint: 'https://your-api-gateway-url.amazonaws.com/stage',
       bucketName: 'your-bucket-name',
       folderPath: 'web-images/'
     },
     // ...other settings
   };
   ```

### Option 2: Cloudflare R2

1. **Create an R2 bucket**:
   - Log in to your Cloudflare dashboard
   - Navigate to R2 and create a new bucket

2. **Create a Cloudflare Worker**:
   - Create a new Worker using the example in `backend-examples/cloudflare-worker-r2.js`
   - Add an R2 bucket binding to connect your Worker to your R2 bucket
   - Deploy the Worker to get your endpoint URL

3. **Update extension configuration**:
   - Edit `background.js` and update the CONFIG section:
   ```javascript
   const CONFIG = {
     useS3: false,
     r2: {
       workerEndpoint: 'https://your-worker.your-subdomain.workers.dev/upload',
       authToken: 'your-optional-auth-token'
     },
     // ...other settings
   };
   ```

## Additional Configuration Options

You can customize various aspects of the extension by modifying `background.js`:

- `preserveFilenames`: Set to `true` to try to keep original filenames
- `addMetadata`: Set to `true` to include page source information with uploads
- `maxConcurrentUploads`: Limit how many files upload simultaneously

## Troubleshooting

If you encounter issues:

1. **Extension doesn't find images**:
   - Check the browser console for errors
   - Verify the content script is loading properly

2. **Uploads fail**:
   - Check your backend service logs
   - Verify your S3/R2 permissions
   - Check CORS configuration

3. **Icons not showing**:
   - Make sure the icons directory is present and contains the SVG files

## Updating

To update the extension after making changes:

1. Go to `chrome://extensions/`
2. Find the Page Image Saver extension
3. Click the refresh icon
4. If that doesn't work, remove the extension and load it again

## Security Notes

- Never include sensitive API keys or credentials directly in the extension code
- Always use a backend service to handle authenticated requests to your storage service
- Consider adding additional authentication to your backend service
# Local product capture receiver

For private product captures, open Settings and enable **Local Capture Receiver**. Enter the receiver's private LAN URL (for example `http://192.168.1.100:8765`) and the operator-provided token. Product captures use this receiver when enabled; a network outage retries briefly and then saves the complete bundle to Chrome Downloads. A receiver rejection remains an explicit capture error. Product captures never use the S3/R2 upload settings.

The receiver must be running with the exact `chrome-extension://<extension ID>` origin allowed and its NAS marker validated. After WSL starts, run `lt.py capture-index` against the mounted `artifacts/catalog-capture/` tree; Downloads fallback bundles use `lt.py capture-import`. The Python project's `docs/catalog-capture-receiver.md` has the full deployment inputs and safety boundary.

## Explicit catalog take-over (separate-URL colors)

Catalog take-over is opt-in and currently supports sites whose color variants have separate product URLs. Configure the local receiver first: verified resume skips require its `already` endpoint, which rehashes published completion evidence. A Downloads fallback is recorded as exported but unverified and leaves the run `finished_with_gaps` until it is imported and verified; it never authorizes a skip.

1. Browse a listing page and a representative product page yourself. Open the image panel on each page and click **Preview catalog**. The panel shows the matched listing links, next/end evidence, product category and scope, color links, and gallery count. No catalog navigation starts during preview.
2. Return to a listing page, review the preview and positive end-check configuration, then click **Take over**. The extension opens listing and product pages in browser tabs. **Pause**, **Resume**, and **Stop** are explicit controls. A challenge, HTTP 403/429, repeated load failure, or structural mismatch pauses the run and shows a notification; clearing the page does not resume it.
3. Watch the panel's listing/product/color/exclusion/failure/pending counts. Click **Export run JSON** to save the exact persisted run and accounting under `PageImageSaver/catalog-runs/` in Downloads. Captured product/color counts refer to separate URL identities; size swatches are not cycled and no style count is inferred.

The site config needs `listing.productLinkSelector`, `listing.pagination.nextSelector`, and a positive `listing.endCheck`: `{ "type": "explicit", "selector": ".end" }`, `{ "type": "page-count", "selector": ".pager" }` for a visible `Page N of M`, or `{ "type": "result-total", "selector": ".total" }` for a visible `N products` count. The runner requires the marker or count to pass on the final listing. A missing next link by itself yields `discovery_incomplete`. `takeover.intervalMs` defaults to 10000 milliseconds between navigation starts and can be set per site. The Lise Charmel config has the known link/color selectors but **does not yet have a currently verified positive end check**; it cannot claim complete catalog discovery until that evidence is provided. The 200 ms interval used by the synthetic browser fixture is test-only.

Clear exclusions are skipped from evidence-based category/title rules for swimwear, sleepwear, menswear, and general apparel. Mixed or uncertain products remain `review`; sports bras remain eligible. Manual capture still lets you choose scope. Take-over does not use cloud storage or bypass login/challenge pages.
