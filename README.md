# Page Image Saver

A Chrome extension to find and save images from web pages to your S3 or R2 storage, and capture full-page screenshots with custom DPI.

## Features

- Find all images on the current web page, including background images
- Select which images to save
- Upload to AWS S3 or Cloudflare R2
- Capture full-page screenshots with customizable settings:
  - Adjustable DPI (up to 288 DPI for high-resolution images)
  - Custom page width
  - PNG or JPEG format options
  - Full page or visible area only
- User-friendly settings UI for configuring storage credentials
- Preserve original filenames when possible
- Keyboard shortcuts:
  - Alt+Shift+I to find images
  - Alt+Shift+S to take a screenshot

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your toolbar

### Local product/color capture for lingerie_trends

For the Milestone 1 integration, load this exact unpacked directory in `chrome://extensions/`:

`/home/yenchi/src/lingerie_trends/.worktrees/page-image-saver-capture`

On a product page, press Alt+Shift+I or click the toolbar button. Select product images, choose **Capture Product Locally**, set the color identity policy and scope, then capture. Use **Color on this URL** for in-place swatches (a selected color is required) or **Each color has its own URL** only when the site really uses separate URLs. You may choose site product selectors when a packaged `site_config/<domain>.json` exists; otherwise select images by checkbox. In-place swatch changes wait for both the color and gallery to update, in either order. If you intentionally change only the checked images for the *same* color, check the one-capture **I changed only the image selection, not the product/color** confirmation; it resets immediately and never applies to automatic capture. Reopen the panel after a swatch change when using selected checkboxes. The optional site auto-capture toggle waits briefly for asynchronously rendered product galleries on pages you visit, records/notifies a recognized-product timeout, and never navigates the catalog.

Local product capture never uses S3/R2 settings. With a configured local receiver, it saves the bundle there; run `lt.py capture-index` in the Python worktree to add verified captures to the viewer. See [receiver setup and indexing](../catalog-manual-capture/docs/catalog-capture-receiver.md). Without a receiver, or when its transport is unavailable, the action exports to Chrome's local `Downloads/PageImageSaver/` folder; run `lt.py capture-import` to verify those files and add them to the viewer. The `complete.json` is written after the page HTML, JSON-LD, and image exports finish, but Chrome's download completion event is not a disk-integrity check. See [manual capture and offline import](../catalog-manual-capture/docs/catalog-manual-capture.md) for the Downloads workflow.

## Setting Up Your Storage

The extension includes a Settings page where you can configure your storage credentials:

1. Click on the extension icon in your toolbar
2. Right-click and select "Settings" from the context menu (or go to Chrome's extension settings and click "Options")
3. Configure your preferred storage option:

### AWS S3 Configuration

- **AWS Region**: The region where your S3 bucket is located (e.g., `us-east-1`)
- **S3 Bucket Name**: The name of your S3 bucket
- **Folder Path**: Optional subfolder within your bucket (e.g., `web-images/`)
- **Access Key ID**: Your AWS IAM user access key
- **Secret Access Key**: Your AWS IAM user secret key
- **Make Uploaded Files Public**: Toggle this on if you want direct access to uploaded files

### Cloudflare R2 Configuration

- **Cloudflare Account ID**: Your Cloudflare account identifier
- **R2 Bucket Name**: The name of your R2 bucket
- **Folder Path**: Optional subfolder within your bucket
- **Access Key ID**: Your R2 API token key
- **Secret Access Key**: Your R2 API token secret
- **Make Uploaded Files Public**: Toggle this on if you're using a public bucket

### General Settings

- **Preserve Original Filenames**: Attempt to keep original filenames when possible
- **Add Page Metadata**: Include source URL and other metadata with uploads
- **Maximum Concurrent Uploads**: Control how many files upload at once

### lingerie_trends Gold Capture (local only)

In **Local Download Settings**, first set **Base Folder Name** to the folder you want inside Chrome's Downloads directory, then click **Use lingerie_trends Gold Capture**. The preset is saved immediately and:

- saves each selected image locally;
- writes a same-basename JSON sidecar containing `sourceUrl`, `url`, dimensions, content type, size, and capture time;
- groups evidence under `<base-folder>/<source-domain>/`; and
- clears S3/R2 destinations and credentials and disables public uploads.

The base folder is not a system path: Chrome's Downloads API resolves it relative to the configured Downloads directory. For example, a base folder of `PageImageSaver` produces `Downloads/PageImageSaver/www.example.com/image.jpg` and the matching `image.json`.

From the `lingerie_trends` repository, hand that domain folder to the gold ingester:

```bash
python3 scripts/ingest_page_image_saver_gold.py \
  --domain www.example.com \
  --input-root /path/to/Downloads/PageImageSaver/www.example.com \
  --output /path/to/gold-run
```

Gold selection remains manual. This preset does not install or invoke `lingerie_trends`, configure cloud storage, upload publicly, or manage storage credentials.

## Usage

### Finding and Saving Images

1. Navigate to any web page
2. Click the extension icon or press Alt+Shift+I
3. A sidebar will appear showing all images found on the page
4. Select the images you want to save
5. Click "Save Selected"

### Taking Screenshots

1. Navigate to any web page
2. Click the extension icon, then click "Take Screenshot" or press Alt+Shift+S
3. Configure the screenshot options:
   - DPI Scaling: Choose from normal (96 DPI) to ultra high (288 DPI)
   - Page Width: Optionally specify a custom width in pixels
   - Image Format: Choose PNG (lossless) or JPEG (smaller file size)
   - Quality: For JPEG format, adjust the compression quality
   - Full Page: Toggle to capture the entire page or just the visible area
4. Click "Capture Screenshot"
5. The screenshot will be processed and uploaded to your configured storage

## AWS IAM Permissions

If you're using AWS S3, your IAM user or role needs these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

## Cloudflare R2 Setup

For Cloudflare R2:

1. Create an R2 bucket in your Cloudflare account
2. Create an R2 API token with write permissions for your bucket
3. If you want public access, you'll need to set up a Worker or custom domain to serve the files

## Security Notes

- Your credentials are stored securely in Chrome's storage sync API
- The extension uses ESM imports from CDNs for the AWS SDK modules to reduce the extension size
- Make sure your bucket policies and permissions are properly configured
- Consider using dedicated API keys with minimal permissions for this extension

## Testing

Included in this repository is a `test-page.html` file that contains various types of images for testing the extension. To use it:

1. Open the file in your browser (File > Open or drag it into Chrome)
2. Click the extension icon or use the Alt+Shift+I shortcut
3. Verify that the extension correctly finds and displays both regular images and CSS background images
4. Test the selection, upload, and screenshot functionality

## Troubleshooting

- **Connection test fails**: Check your credentials and bucket names
- **Images not uploading**: Verify your IAM permissions or R2 token permissions
- **Screenshot not capturing full page**: Some websites with complex layouts or lazy loading might not capture correctly

## License

MIT
