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
