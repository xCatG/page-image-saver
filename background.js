//background.js
// Default configuration (will be overridden by user settings)
const DEFAULT_CONFIG = {
  // Set to true to use S3, false to use R2
  useS3: true,
  
  // For S3 configuration
  s3: {
    region: '',
    bucketName: '',
    folderPath: 'web-images/',
    accessKeyId: '',
    secretAccessKey: '',
    makePublic: false
  },
  
  // For R2 configuration
  r2: {
    accountId: '',
    bucketName: '',
    folderPath: 'web-images/',
    useApiToken: false,
    accessKeyId: '',
    secretAccessKey: '',
    apiToken: '',
    makePublic: false
  },
  
  // General settings
  preserveFilenames: true, // Try to preserve original filenames when possible
  addMetadata: true, // Add metadata about the source page
  maxConcurrentUploads: 3, // Limit concurrent uploads to avoid rate limiting
  minFileSize: 5 * 1024, // Minimum file size in bytes (5KB default)
  useDomainFolders: true // Organize images by domain in subfolders
};

// Store the current configuration (will be loaded from storage)
let CONFIG = { ...DEFAULT_CONFIG };

// Load settings from storage when the extension starts
chrome.storage.sync.get('imageUploaderSettings', (result) => {
  if (result.imageUploaderSettings) {
    CONFIG = result.imageUploaderSettings;
    console.log('Settings loaded from storage');
  } else {
    console.log('No saved settings found, using defaults');
  }
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.imageUploaderSettings) {
    CONFIG = changes.imageUploaderSettings.newValue;
    console.log('Settings updated');
  }
});

// Open settings page when extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Only open settings page on fresh install
    chrome.tabs.create({ url: 'settings.html' });
  }
});

// Add a context menu item to open settings
chrome.contextMenus.create({
  id: 'openSettings',
  title: 'Settings',
  contexts: ['action'] // Only show when clicking on extension icon
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openSettings') {
    chrome.tabs.create({ url: 'settings.html' });
  }
});

// Initialize the extension
chrome.action.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, {action: 'findImages'})
    .catch(error => {
      console.error('Error sending message to content script:', error);
      // If we can't communicate with the content script, it might not be loaded
      // Open the settings page instead
      if (error.message && error.message.includes('Could not establish connection')) {
        chrome.tabs.create({ url: 'settings.html' });
      }
    });
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(command => {
  if (command === 'find_images') {
    chrome.tabs.query({active: true, currentWindow: true}, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {action: 'findImages'})
          .catch(error => {
            console.error('Error sending message to content script:', error);
          });
      }
    });
  } else if (command === 'take_screenshot') {
    chrome.tabs.query({active: true, currentWindow: true}, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {action: 'takeScreenshot'})
          .catch(error => {
            console.error('Error sending message to content script:', error);
          });
      }
    });
  }
});

// Handle image save requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveImages') {
    const images = message.images;
    const sourceInfo = {
      url: message.sourceUrl,
      title: message.pageTitle,
      timestamp: new Date().toISOString()
    };
    
    console.log(`Processing ${images.length} images from ${sourceInfo.url}`);
    
    // Check if we have valid settings before proceeding
    if (!isConfigValid()) {
      sendResponse({
        success: false, 
        error: 'Storage settings not configured. Please go to extension settings.'
      });
      
      // Open settings page
      chrome.tabs.create({ url: 'settings.html' });
      return true;
    }
    
    // Process images in batches to limit concurrent uploads
    processImagesInBatches(images, sourceInfo, sender.tab.id)
      .then(results => {
        const successCount = results.filter(r => r.success).length;
        sendResponse({
          success: true, 
          count: successCount,
          failures: results.length - successCount
        });
      })
      .catch(error => {
        console.error('Error saving images:', error);
        sendResponse({success: false, error: error.message});
      });
    
    return true; // Keep the message channel open for async response
  } else if (message.action === 'captureVisibleTab') {
    // Capture the visible part of the tab
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'png', quality: 100 },
      dataUrl => {
        sendResponse({ dataUrl });
      }
    );
    return true; // Keep the message channel open for async response
  } else if (message.action === 'processScreenshot') {
    // Handle screenshot upload
    const dataUrl = message.screenshot;
    const filename = message.filename;
    const metadata = message.metadata;
    
    console.log(`Processing screenshot: ${filename}`);
    
    // Check if we have valid settings before proceeding
    if (!isConfigValid()) {
      sendResponse({
        success: false, 
        error: 'Storage settings not configured. Please go to extension settings.'
      });
      
      // Open settings page
      chrome.tabs.create({ url: 'settings.html' });
      return true;
    }
    
    // Convert data URL to Blob
    const byteString = atob(dataUrl.split(',')[1]);
    const mimeType = dataUrl.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    
    const blob = new Blob([ab], { type: mimeType });
    
    // Get domain for organizing in folders if enabled
    let domain = '';
    if (CONFIG.useDomainFolders && metadata && metadata.url) {
      try {
        const urlObj = new URL(metadata.url);
        domain = urlObj.hostname;
        // Domain will be sanitized in the upload function
      } catch (e) {
        console.warn('Could not parse URL for domain folder:', e);
      }
    }
    
    // Upload the screenshot
    uploadToStorage(blob, filename, { type: 'screenshot' }, metadata, domain)
      .then(result => {
        sendResponse({
          success: true,
          url: result.url
        });
      })
      .catch(error => {
        console.error('Error uploading screenshot:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });
    
    return true; // Keep the message channel open for async response
  } else if (message.action === 'testConnection') {
    // Test connection with provided settings
    const testSettings = message.settings;
    const testBlob = dataURItoBlob('data:text/plain;base64,' + btoa('test file content'));
    const testFilename = message.testFile.filename;
    
    // Use the provided settings for this test instead of the global CONFIG
    testUploadToStorage(testBlob, testFilename, { type: 'test' }, { test: true }, testSettings)
      .then(result => {
        sendResponse({
          success: true,
          url: result.url
        });
      })
      .catch(error => {
        console.error('Error testing connection:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });
    
    return true; // Keep the message channel open for async response
  }
});

// Process images in controlled batches
async function processImagesInBatches(images, sourceInfo, tabId) {
  const results = [];
  const batchSize = CONFIG.maxConcurrentUploads;
  let totalCompleted = 0;
  
  // Process in batches
  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    const batchPromises = batch.map(image => processImage(image, sourceInfo));
    
    // Wait for the current batch to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Filter out unsuccessful results
    const successfulResults = batchResults.filter(r => r.success);
    results.push(...batchResults);
    
    // Update progress after each batch
    totalCompleted += batch.length;
    
    // Send progress update to the content script
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'uploadProgress',
        completed: totalCompleted,
        total: images.length,
        successCount: successfulResults.length
      });
    }
  }
  
  return results;
}

// Process a single image
async function processImage(image, sourceInfo) {
  try {
    // Download the image
    const imageBlob = await downloadImage(image.url);
    
    // Check file size
    if (imageBlob.size < CONFIG.minFileSize) {
      console.log(`Skipping small image (${imageBlob.size} bytes): ${image.url}`);
      return { 
        success: false, 
        image, 
        error: 'Image too small',
        skipped: true
      };
    }
    
    // Check if it's a valid image file (based on content type)
    if (!imageBlob.type.startsWith('image/')) {
      console.log(`Skipping non-image content type (${imageBlob.type}): ${image.url}`);
      return { 
        success: false, 
        image, 
        error: 'Not a valid image',
        skipped: true
      };
    }
    
    // Generate a filename
    const filename = getFilename(image.url, imageBlob.type);
    
    // Get domain for organizing in folders if enabled
    let domain = '';
    if (CONFIG.useDomainFolders && sourceInfo && sourceInfo.url) {
      try {
        const urlObj = new URL(sourceInfo.url);
        // Get domain from the source page URL, not the image URL
        domain = urlObj.hostname;
        // Domain will be sanitized in the upload function
      } catch (e) {
        console.warn('Could not parse URL for domain folder:', e);
      }
    }
    
    // Upload to storage
    const uploadResult = await uploadToStorage(imageBlob, filename, image, sourceInfo, domain);
    
    console.log(`Successfully uploaded ${filename}`);
    
    return { 
      success: true, 
      image, 
      result: uploadResult 
    };
  } catch (error) {
    console.error(`Error processing ${image.url}:`, error);
    return { 
      success: false, 
      image, 
      error: error.message 
    };
  }
}

// Download an image as a blob
async function downloadImage(url) {
  const response = await fetch(url, {
    // Include credentials to handle images that require cookies
    credentials: 'include',
    // Add a user agent to avoid being blocked
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }
  
  return await response.blob();
}

// Generate a valid filename from URL
function getFilename(url, contentType) {
  try {
    // Try to extract the original filename if available
    if (CONFIG.preserveFilenames) {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      let filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      
      // Clean the filename (remove query parameters, etc.)
      filename = filename.split('?')[0].split('#')[0];
      
      // If filename has a valid extension, use it
      if (filename && filename.includes('.')) {
        return sanitizeFilename(filename);
      }
    }
    
    // Generate a filename based on content type and timestamp
    const ext = getExtensionFromContentType(contentType);
    const timestamp = Date.now();
    return `image_${timestamp}${ext}`;
  } catch (error) {
    console.error('Error generating filename:', error);
    return `image_${Date.now()}.jpg`;
  }
}

// Sanitize filename to be safe for storage
function sanitizeFilename(filename) {
  // Remove characters that aren't allowed in filenames
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    // Ensure the filename isn't too long
    .substring(0, 100);
}

// Extract base domain name (identifies the main domain without common subdomains)
function extractBaseDomain(domain) {
  try {
    // Split the domain into parts
    const parts = domain.split('.');
    
    // If we have only 2 parts (like example.com) or fewer, return as is
    if (parts.length <= 2) {
      return domain;
    }
    
    // Handle special cases for country-specific TLDs
    // For domains like example.co.uk, site.ac.jp, etc.
    const commonCountryTLDs = [
      'co.uk', 'co.jp', 'co.kr', 'co.nz', 'com.au', 'com.br', 'com.cn',
      'com.mx', 'com.tr', 'com.sg', 'or.jp', 'ne.jp', 'ac.jp', 'ac.uk',
      'or.kr', 'ne.kr', 'co.za', 'co.in', 'org.uk', 'net.au', 'org.au'
    ];
    
    // Join the last 2 parts
    const lastTwoParts = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    
    // Join the last 3 parts if dealing with country-specific domain
    if (commonCountryTLDs.includes(lastTwoParts)) {
      // For cases like example.co.uk - we want to keep "example.co.uk"
      if (parts.length === 3) {
        return domain;
      }
      // For cases like www.example.co.uk - we want to return "example.co.uk"
      return parts.slice(-3).join('.');
    }
    
    // Common subdomains to remove
    const commonSubdomains = ['www', 'store', 'shop', 'blog', 'mail', 'app', 'support', 'help'];
    
    // If first part is a common subdomain, remove it
    if (commonSubdomains.includes(parts[0])) {
      return parts.slice(1).join('.');
    }
    
    // For other cases, return the domain as-is
    return domain;
  } catch (e) {
    console.warn('Error extracting base domain:', e);
    return domain;
  }
}

// Sanitize domain name for folder use
function sanitizeDomain(domain) {
  // Extract the base domain first
  domain = extractBaseDomain(domain);
  
  // Remove characters that aren't allowed in folder names
  return domain.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Get file extension from content type
function getExtensionFromContentType(contentType) {
  const typeMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'text/plain': '.txt'
  };
  
  return typeMap[contentType] || '.jpg';
}

// Upload to storage (S3 or R2)
async function uploadToStorage(blob, filename, imageInfo, sourceInfo, domain = '') {
  // Choose the upload method based on config
  if (CONFIG.useS3) {
    return await uploadToS3(blob, filename, imageInfo, sourceInfo, CONFIG, domain);
  } else {
    return await uploadToR2(blob, filename, imageInfo, sourceInfo, CONFIG, domain);
  }
}

// Test upload for connection testing
async function testUploadToStorage(blob, filename, imageInfo, sourceInfo, settings) {
  // Domain is not relevant for test uploads
  const domain = '';
  
  // Choose the upload method based on provided settings
  if (settings.useS3) {
    return await uploadToS3(blob, filename, imageInfo, sourceInfo, settings, domain);
  } else {
    return await uploadToR2(blob, filename, imageInfo, sourceInfo, settings, domain);
  }
}

// Upload to AWS S3
async function uploadToS3(blob, filename, imageInfo, sourceInfo, settings, domain = '') {
  // Get the settings for this upload
  const s3Config = settings.s3;
  const addMetadata = settings.addMetadata;
  const useDomainFolders = settings.useDomainFolders;
  
  // Check credentials
  if (!s3Config.accessKeyId || !s3Config.secretAccessKey || !s3Config.bucketName) {
    throw new Error('Missing S3 credentials or bucket name');
  }
  
  // Construct the full path with optional folder
  let folderPath = s3Config.folderPath || '';
  
  // Add domain as subfolder if enabled and domain is provided
  if (useDomainFolders && domain) {
    // Sanitize domain for use as folder name
    const sanitizedDomain = sanitizeDomain(domain);
    // Make sure the folder path ends with a slash
    if (!folderPath.endsWith('/')) {
      folderPath += '/';
    }
    folderPath += sanitizedDomain + '/';
  }
  
  const fullPath = folderPath + filename;

  try {
    // Import AWS SDK modules dynamically
    const { S3Client, PutObjectCommand } = await import('https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3.400.0/+esm');
    
    // Create S3 client
    const client = new S3Client({
      region: s3Config.region || 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      }
    });

    // Create metadata object if needed
    const metadata = {};
    if (addMetadata && sourceInfo) {
      metadata['source-url'] = sourceInfo.url || '';
      metadata['source-title'] = sourceInfo.title || '';
      metadata['upload-date'] = sourceInfo.timestamp || new Date().toISOString();
    }

    // Prepare upload command
    const command = new PutObjectCommand({
      Bucket: s3Config.bucketName,
      Key: fullPath,
      Body: blob,
      ContentType: blob.type,
      ACL: s3Config.makePublic ? 'public-read' : 'private',
      Metadata: metadata
    });

    // Execute upload
    await client.send(command);
    
    // Construct the URL to the uploaded file
    let fileUrl;
    if (s3Config.makePublic) {
      // Public URL format
      fileUrl = `https://${s3Config.bucketName}.s3.${s3Config.region || 'us-east-1'}.amazonaws.com/${fullPath}`;
    } else {
      // For private objects, we just return a placeholder
      fileUrl = `s3://${s3Config.bucketName}/${fullPath}`;
    }

    return {
      url: fileUrl,
      size: blob.size,
      type: blob.type,
      path: fullPath,
      bucket: s3Config.bucketName,
      sourceInfo: addMetadata ? sourceInfo : null
    };
  } catch (error) {
    console.error('S3 upload error:', error);
    throw new Error(`S3 upload failed: ${error.message}`);
  }
}

// Upload to Cloudflare R2
async function uploadToR2(blob, filename, imageInfo, sourceInfo, settings, domain = '') {
  // Get the settings for this upload
  const r2Config = settings.r2;
  const addMetadata = settings.addMetadata;
  const useDomainFolders = settings.useDomainFolders;
  
  // Construct the full path with optional folder
  let folderPath = r2Config.folderPath || '';
  
  // Add domain as subfolder if enabled and domain is provided
  if (useDomainFolders && domain) {
    // Sanitize domain for use as folder name
    const sanitizedDomain = sanitizeDomain(domain);
    // Make sure the folder path ends with a slash
    if (!folderPath.endsWith('/')) {
      folderPath += '/';
    }
    folderPath += sanitizedDomain + '/';
  }
  
  const fullPath = folderPath + filename;

  try {
    // Handle different authentication methods
    if (r2Config.useApiToken) {
      return await uploadToR2WithToken(blob, fullPath, imageInfo, sourceInfo, settings);
    } else {
      return await uploadToR2WithKeys(blob, fullPath, imageInfo, sourceInfo, settings);
    }
  } catch (error) {
    console.error('R2 upload error:', error);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

// Upload to R2 using API Keys (S3-compatible)
async function uploadToR2WithKeys(blob, fullPath, imageInfo, sourceInfo, settings) {
  const r2Config = settings.r2;
  const addMetadata = settings.addMetadata;
  
  // Check credentials
  if (!r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucketName || !r2Config.accountId) {
    throw new Error('Missing R2 credentials, account ID, or bucket name');
  }

  try {
    // Import AWS SDK modules dynamically (R2 uses S3-compatible API)
    const { S3Client, PutObjectCommand } = await import('https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3.400.0/+esm');
    
    // Create R2 client
    const client = new S3Client({
      region: 'auto', // R2 doesn't use regions in the same way as S3
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey
      }
    });

    // Create metadata object if needed
    const metadata = {};
    if (addMetadata && sourceInfo) {
      metadata['source-url'] = sourceInfo.url || '';
      metadata['source-title'] = sourceInfo.title || '';
      metadata['upload-date'] = sourceInfo.timestamp || new Date().toISOString();
    }

    // Prepare upload command
    const command = new PutObjectCommand({
      Bucket: r2Config.bucketName,
      Key: fullPath,
      Body: blob,
      ContentType: blob.type,
      // R2 doesn't support ACLs directly, but we'll include for compatibility
      ACL: r2Config.makePublic ? 'public-read' : 'private',
      Metadata: metadata
    });

    // Execute upload
    await client.send(command);
    
    // Construct the URL to the uploaded file
    let fileUrl;
    if (r2Config.makePublic) {
      // Public URL format - this will vary depending on your R2 setup
      // You might need to use a custom domain or Cloudflare Workers to serve public content
      fileUrl = `https://${r2Config.bucketName}.${r2Config.accountId}.r2.cloudflarestorage.com/${fullPath}`;
    } else {
      // For private objects, we just return a placeholder
      fileUrl = `r2://${r2Config.bucketName}/${fullPath}`;
    }

    return {
      url: fileUrl,
      size: blob.size,
      type: blob.type,
      path: fullPath,
      bucket: r2Config.bucketName,
      sourceInfo: addMetadata ? sourceInfo : null
    };
  } catch (error) {
    console.error('R2 upload error with API keys:', error);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

// Upload to R2 using Cloudflare API Token
async function uploadToR2WithToken(blob, fullPath, imageInfo, sourceInfo, settings) {
  const r2Config = settings.r2;
  const addMetadata = settings.addMetadata;
  
  // Check credentials
  if (!r2Config.apiToken || !r2Config.bucketName || !r2Config.accountId) {
    throw new Error('Missing R2 API token, account ID, or bucket name');
  }

  try {
    // For API token upload, we need to use Cloudflare's direct upload endpoint
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${r2Config.accountId}/r2/buckets/${r2Config.bucketName}/objects/${encodeURIComponent(fullPath)}`;
    
    // Prepare headers
    const headers = {
      'Authorization': `Bearer ${r2Config.apiToken}`,
      'Content-Type': blob.type
    };
    
    // Add metadata headers if needed
    if (addMetadata && sourceInfo) {
      headers['X-Amz-Meta-Source-Url'] = sourceInfo.url || '';
      headers['X-Amz-Meta-Source-Title'] = sourceInfo.title || '';
      headers['X-Amz-Meta-Upload-Date'] = sourceInfo.timestamp || new Date().toISOString();
    }
    
    // Execute the upload directly using fetch
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: headers,
      body: blob
    });
    
    // Handle the response
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Failed to upload to R2: ${response.status} ${response.statusText} - ${errorData}`);
    }
    
    // Construct the URL to the uploaded file
    let fileUrl;
    if (r2Config.makePublic) {
      // Public URL format - requires a Cloudflare Worker or R2 public access enabled
      fileUrl = `https://${r2Config.bucketName}.${r2Config.accountId}.r2.dev/${fullPath}`;
    } else {
      // For private objects, we just return a placeholder
      fileUrl = `r2://${r2Config.bucketName}/${fullPath}`;
    }
    
    return {
      url: fileUrl,
      size: blob.size,
      type: blob.type,
      path: fullPath,
      bucket: r2Config.bucketName,
      sourceInfo: addMetadata ? sourceInfo : null
    };
  } catch (error) {
    console.error('R2 upload error with API token:', error);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

// Check if the configuration is valid for storage operations
function isConfigValid() {
  if (CONFIG.useS3) {
    return !!(CONFIG.s3.accessKeyId && CONFIG.s3.secretAccessKey && CONFIG.s3.bucketName);
  } else {
    if (CONFIG.r2.useApiToken) {
      return !!(CONFIG.r2.apiToken && CONFIG.r2.bucketName && CONFIG.r2.accountId);
    } else {
      return !!(CONFIG.r2.accessKeyId && CONFIG.r2.secretAccessKey && CONFIG.r2.bucketName && CONFIG.r2.accountId);
    }
  }
}

// Utility function to convert data URI to Blob
function dataURItoBlob(dataURI) {
  // Convert base64/URLEncoded data component to raw binary data
  let byteString;
  if (dataURI.split(',')[0].indexOf('base64') >= 0) {
    byteString = atob(dataURI.split(',')[1]);
  } else {
    byteString = decodeURIComponent(dataURI.split(',')[1]);
  }

  // Separate out the mime component
  const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

  // Write the bytes of the string to a typed array
  const ia = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  return new Blob([ia], { type: mimeString });
}

// Log that the background script has loaded
console.log('Page Image Saver background script loaded.');
