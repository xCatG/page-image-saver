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
