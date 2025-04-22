# Page Image Saver

A Chrome extension to find and save images from web pages to your S3 or R2 storage, and capture full-page screenshots with custom DPI.

![Extension Banner](icons/128.png)

## 🌟 Overview

Page Image Saver solves common challenges faced by digital professionals who need to efficiently collect, organize, and store web images:

- **Problem**: Manually saving individual images is time-consuming
- **Solution**: Bulk image extraction with intelligent filtering
- **Problem**: Screenshots often miss content below the fold
- **Solution**: Full-page capture with customizable DPI
- **Problem**: Downloaded images get lost in local folders
- **Solution**: Direct cloud storage to S3/R2 with organized folder structure

## 🔍 Features

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

## 💡 Built with LLM Assistance

This extension was developed using collaborative AI programming techniques, incorporating Large Language Model assistance for key components:

- **CORS Handling Improvements**: Implemented a multi-stage fallback approach for loading images with different CORS modes to handle preloaded images and varying security contexts
- **Upload Progress Tracking**: Developed a two-phase communication system between content and background scripts to provide accurate progress indicators
- **Duplicate Prevention Logic**: Created a global tracking system to prevent re-uploading the same images across paginated content
- **Error Handling Enhancement**: Implemented comprehensive error handling with intelligent fallbacks for network issues

The development process with LLM assistance involved:
1. Identifying complex issues (like CORS handling)
2. Drafting solution approaches with LLM input
3. Implementing and testing code
4. Refining based on real-world usage patterns

## 🛠️ Technical Challenges Solved

### Advanced CORS Handling
```javascript
// Multi-stage fallback approach for image loading
imgEl.crossOrigin = null; // Start with default credentials mode
imgEl.onerror = () => {
  // First fallback: try with anonymous if null failed
  if (imgEl.crossOrigin === null) {
    imgEl.crossOrigin = "anonymous";
    imgEl.src = url;
    return;
  }
  
  // Second fallback: try with no crossorigin attribute
  if (imgEl.crossOrigin === "anonymous") {
    imgEl.removeAttribute('crossorigin');
    imgEl.src = url;
    return;
  }
};
```

### Two-Phase Upload Communication
The extension implements a sophisticated two-phase communication approach:
1. Background script sends an immediate provisional response
2. Content script displays a persistent progress indicator
3. Background script processes images and sends periodic updates
4. Final completion message sent when all processing is done

This system prevents premature completion notifications and provides users with accurate progress information.

### Duplicate Prevention System
A global URL tracking system prevents re-uploading the same images:
```javascript
// Global set to track already uploaded URLs
let alreadyUploadedUrls = new Set();

// Filter out images that have already been uploaded in this session
const newImages = images.filter(image => {
  if (alreadyUploadedUrls.has(image.url)) {
    return false;
  }
  return true;
});

// Add all the current images to the tracking set
images.forEach(image => {
  if (image && image.url) {
    alreadyUploadedUrls.add(image.url);
  }
});
```

## 📸 Visual Walkthrough

### Finding and Extracting Images
![Image Finder Interface](https://via.placeholder.com/800x450.png?text=Image+Finder+Interface)

### Taking High-DPI Screenshots
![Screenshot Tool](https://via.placeholder.com/800x450.png?text=Screenshot+Tool)

### Configuring Cloud Storage
![Settings Page](https://via.placeholder.com/800x450.png?text=Settings+Page)

## 🔧 Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your toolbar

See [INSTALL.md](INSTALL.md) for detailed installation instructions.

## ☁️ Setting Up Your Storage

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

## 🚀 Usage

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

## 🔄 Development Timeline

- **Week 1**: Initial extension development with basic image extraction
- **Week 1**: Added S3 integration and screenshot functionality
- **Week 1**: Implemented R2 support and domain-based organization
- **Week 2**: Fixed CORS issues and added upload progress tracking
- **Week 2**: Added duplicate detection across paginated pages
- **Week 2**: Enhanced error handling and implemented tracking pixel filtering
- **Week 2**: Refined two-phase communication system for upload tracking

The entire project was developed in under two weeks with the assistance of LLM coding agents, demonstrating the efficiency of AI-augmented development.

## 🤖 For LLM Agents Working on This Project

If you're an AI assistant helping to develop or maintain this project:

1. **Start by reviewing the [claude_memo.md](claude_memo.md)** file which contains critical information about recent bug fixes, implementation details, and technical challenges

2. **Key architectural components to understand**:
   - Two-phase communication between content scripts and background scripts
   - CORS handling with multi-stage fallback approach
   - Progress tracking and notification system
   - Duplicate prevention across page loads

3. **Development principles**:
   - Prioritize user feedback with clear progress indicators
   - Implement robust error handling with fallbacks
   - Ensure consistent logging for debugging
   - Maintain separation between UI and background processing

For example, when working on CORS-related issues, refer to the multi-stage fallback approach described in claude_memo.md.

## 🔮 Future Roadmap

- **AI-Powered Features**:
  - Automatic image categorization using computer vision
  - Smart filtering based on image content
  - Relevance scoring to highlight important images
- **Enhanced Organization**:
  - Custom tagging system for images
  - Smart folders with rule-based organization
  - Search functionality across saved images
- **Additional Storage Options**:
  - Google Drive integration
  - Dropbox support
  - Local browser storage option

## 🔒 Security Notes

- Your credentials are stored securely in Chrome's storage sync API
- The extension uses ESM imports from CDNs for the AWS SDK modules to reduce the extension size
- Make sure your bucket policies and permissions are properly configured
- Consider using dedicated API keys with minimal permissions for this extension

## 🧪 Testing

Included in this repository is a `test-page.html` file that contains various types of images for testing the extension. To use it:

1. Open the file in your browser (File > Open or drag it into Chrome)
2. Click the extension icon or use the Alt+Shift+I shortcut
3. Verify that the extension correctly finds and displays both regular images and CSS background images
4. Test the selection, upload, and screenshot functionality

## 📄 License

MIT
