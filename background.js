//background.js
// Debugging helper - will show a notification with download paths
function showSavePathNotification(path) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Image Saved',
    message: `File saved to:\n${path}`,
    priority: 2
  });
}

// Add a debug command to show download directory
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'debugShowDownloadPaths') {
    chrome.downloads.search({}, (downloads) => {
      if (downloads && downloads.length > 0) {
        // Get the most recent download
        const recentDownload = downloads[0];
        debugLog('MOST RECENT DOWNLOAD PATH:', recentDownload.filename);
        // Show a notification with the path
        showSavePathNotification(recentDownload.filename);
        sendResponse({success: true, path: recentDownload.filename});
      } else {
        sendResponse({success: false, error: 'No downloads found'});
      }
    });
    return true; // Keep the message channel open for async response
  }
});

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
  
  // Local download settings
  local: {
    enabled: true,
    subfolderPerDomain: true,
    baseFolder: 'PageImageSaver'
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

// Add a debug menu item to check download paths
chrome.contextMenus.create({
  id: 'debugDownloadPath',
  title: 'Debug: Show Download Location',
  contexts: ['action'] // Only show when clicking on extension icon
});

// If we're in Edge, add an Edge-specific option
if (detectBrowser() === "Edge") {
  chrome.contextMenus.create({
    id: 'edgeFilenameMode',
    title: 'Edge Mode: Always Show Save Dialog',
    contexts: ['action']
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openSettings') {
    chrome.tabs.create({ url: 'settings.html' });
  } else if (info.menuItemId === 'edgeFilenameMode') {
    // Toggle a flag in storage for Edge mode
    chrome.storage.local.get(['edgeMode'], (result) => {
      const currentMode = result.edgeMode || false;
      const newMode = !currentMode;
      
      chrome.storage.local.set({ edgeMode: newMode }, () => {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Edge Save Mode',
          message: newMode 
            ? 'Edge Mode enabled: Save dialog will always be shown for downloads' 
            : 'Edge Mode disabled: Using normal download behavior',
          priority: 2
        });
      });
    });
  } else if (info.menuItemId === 'debugDownloadPath') {
    // Show the user where downloads are saved
    debugLog('Debug: Checking download locations');
    chrome.downloads.search({}, (downloads) => {
      if (downloads && downloads.length > 0) {
        // Show the 3 most recent download locations
        const recentDownloads = downloads.slice(0, 3);
        recentDownloads.forEach(download => {
          debugLog(`Recent download path: ${download.filename}`);
          // Extract the directory path from the full file path
          const filePath = download.filename;
          const lastSlashIndex = filePath.lastIndexOf('/');
          const lastBackslashIndex = filePath.lastIndexOf('\\');
          const lastSeparatorIndex = Math.max(lastSlashIndex, lastBackslashIndex);
          const directoryPath = lastSeparatorIndex > -1 ? filePath.substring(0, lastSeparatorIndex) : 'Unknown';
          
          // Show notification with the directory path
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Download Directory',
            message: `Chrome is saving files to:\n${directoryPath}`,
            priority: 2
          });
        });
      } else {
        debugLog('No recent downloads found');
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Download Directory',
          message: 'No recent downloads found to determine the directory.',
          priority: 2
        });
      }
    });
    
    // Add a test download with explicit filename to debug the Chrome downloads API behavior
    debugLog('Creating test download with explicit filename...');
    
    // Create a simple text file
    const testBlob = new Blob(['This is a test file to check filename behavior'], { type: 'text/plain' });
    
    // Convert blob to data URL
    const reader = new FileReader();
    reader.onload = function() {
      const dataUrl = reader.result;
      
      // Try to download with explicit filename
      const testFilename = `test_file_${Date.now()}.txt`;
      debugLog(`Attempting to download with filename: ${testFilename}`);
      
      chrome.downloads.download({
        url: dataUrl,
        filename: testFilename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        debugLog(`Test download started with ID: ${downloadId}`);
        
        // Check the actual filename used
        setTimeout(() => {
          chrome.downloads.search({ id: downloadId }, (results) => {
            if (results && results.length > 0) {
              const download = results[0];
              const fullPath = download.filename;
              const lastSeparatorIndex = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
              const actualFilename = lastSeparatorIndex > -1 ? fullPath.substring(lastSeparatorIndex + 1) : fullPath;
              
              debugLog(`Test download filename: Expected "${testFilename}", Actual: "${actualFilename}"`);
              debugLog(`Test download full path: ${fullPath}`);
              
              chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Test Download Filename',
                message: `Expected: ${testFilename}\nActual: ${actualFilename}`,
                priority: 2
              });
            }
          });
        }, 1000); // Wait a second for the download to complete
      });
    };
    reader.readAsDataURL(testBlob);
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
    
    // Check if we have valid settings for cloud storage or local download is enabled
    if (!isConfigValid() && (!CONFIG.local || !CONFIG.local.enabled)) {
      sendResponse({
        success: false, 
        error: 'Storage settings not configured and local download is disabled. Please go to extension settings.'
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
    
    console.log('Processing screenshot with current config:', CONFIG);
    
    const promises = [];
    
    // Save locally if enabled
    if (CONFIG.local && CONFIG.local.enabled) {
      console.log('Local saving is enabled, attempting to save screenshot to disk');
      promises.push(saveToLocalDisk(blob, filename, { type: 'screenshot' }, metadata, domain));
    } else {
      console.log('Local saving is disabled or not configured:', CONFIG.local);
    }
    
    // Upload to cloud storage if configured
    if (isConfigValid()) {
      console.log('Cloud storage is configured, attempting screenshot upload');
      promises.push(uploadToStorage(blob, filename, { type: 'screenshot' }, metadata, domain));
    } else {
      console.log('Cloud storage not configured or invalid settings');
    }
    
    if (promises.length === 0) {
      console.error('No storage methods enabled. Enable local download or configure cloud storage.');
      sendResponse({
        success: false,
        error: 'No storage methods enabled. Please configure at least one storage method in settings.'
      });
      return true;
    }
    
    // Wait for all operations to complete
    Promise.all(promises)
      .then(results => {
        console.log('Screenshot save operations completed:', results);
        
        // Filter successful results
        const successfulResults = results.filter(r => r && r.success);
        console.log('Successful operations:', successfulResults.length);
        
        if (successfulResults.length > 0) {
          sendResponse({
            success: true,
            url: successfulResults[0].url || 'File saved'
          });
        } else {
          sendResponse({
            success: false,
            error: 'Failed to save screenshot'
          });
        }
      })
      .catch(error => {
        console.error('Error processing screenshot:', error);
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
    
    console.log('Processing image with current config:', CONFIG);
    
    const promises = [];
    
    // Save locally if enabled
    if (CONFIG.local && CONFIG.local.enabled) {
      debugLog('Local saving is enabled, attempting to save to disk');
      // Set local saving to be explicitly enabled for this session if needed
      if (!CONFIG.local.enabled) {
        debugLog('Forcing local saving to be enabled for fallback');
        CONFIG.local.enabled = true;
      }
      promises.push(saveToLocalDisk(imageBlob, filename, image, sourceInfo, domain));
    } else {
      debugLog('Local saving is disabled or not configured:', CONFIG.local);
    }
    
    // Upload to cloud storage if configured
    if (isConfigValid()) {
      debugLog('Cloud storage is configured, attempting upload');
      promises.push(uploadToStorage(imageBlob, filename, image, sourceInfo, domain));
    } else {
      debugLog('Cloud storage not configured or invalid settings');
      
      // If cloud storage is not configured but local saving is disabled,
      // let's temporarily enable local saving as a fallback
      if (!CONFIG.local || !CONFIG.local.enabled) {
        debugLog('No storage methods configured, enabling local saving as fallback');
        if (!CONFIG.local) CONFIG.local = {};
        CONFIG.local.enabled = true;
        CONFIG.local.baseFolder = 'PageImageSaver';
        CONFIG.local.subfolderPerDomain = true;
        
        // Add a local save promise
        promises.push(saveToLocalDisk(imageBlob, filename, image, sourceInfo, domain));
      }
    }
    
    if (promises.length === 0) {
      debugLog('No storage methods enabled. Enable local download or configure cloud storage.');
      throw new Error('No storage methods enabled');
    }
    
    // Wait for all operations to complete
    console.log(`Starting ${promises.length} save operations`);
    const results = await Promise.all(promises);
    console.log('Save operations completed:', results);
    
    // Filter successful results
    const successfulResults = results.filter(r => r && r.success);
    console.log('Successful operations:', successfulResults.length);
    
    // If at least one operation succeeded, consider the overall process a success
    if (successfulResults.length > 0) {
      debugLog(`Successfully saved ${filename}`);
      
      // Log more detailed information about where files were saved
      successfulResults.forEach(result => {
        if (result.type === 'local' && result.fullPath) {
          debugLog(`📁 IMAGE SAVED TO LOCAL PATH: ${result.fullPath}`);
        } else if (result.url) {
          debugLog(`🌐 IMAGE SAVED TO REMOTE URL: ${result.url}`);
        }
      });
      
      return { 
        success: true, 
        image, 
        results: successfulResults 
      };
    } else {
      throw new Error('All save operations failed');
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
  debugLog(`Generating filename from URL: ${url}`);
  debugLog(`Content type: ${contentType}`);
  
  try {
    // Try to extract the original filename if available
    if (CONFIG.preserveFilenames) {
      debugLog(`Preserve filenames is enabled`);
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      let filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      
      debugLog(`Original filename from pathname: "${filename}"`);
      
      // Clean the filename (remove query parameters, etc.)
      filename = filename.split('?')[0].split('#')[0];
      debugLog(`Cleaned filename: "${filename}"`);
      
      // If filename has a valid extension, use it
      if (filename && filename.includes('.')) {
        const sanitized = sanitizeFilename(filename);
        debugLog(`Using sanitized original filename: "${sanitized}"`);
        return sanitized;
      } else {
        debugLog(`Filename doesn't have a valid extension, will generate one`);
      }
    } else {
      debugLog(`Preserve filenames is disabled, will generate filename`);
    }
    
    // Generate a filename based on content type and timestamp
    const ext = getExtensionFromContentType(contentType);
    const timestamp = Date.now();
    const generatedName = `image_${timestamp}${ext}`;
    debugLog(`Generated filename: "${generatedName}"`);
    return generatedName;
  } catch (error) {
    debugLog(`❌ Error generating filename: ${error.message}`);
    const fallbackName = `image_${Date.now()}.jpg`;
    debugLog(`Using fallback filename: "${fallbackName}"`);
    return fallbackName;
  }
}

// Sanitize filename to be safe for storage
function sanitizeFilename(filename) {
  debugLog(`Sanitizing filename: "${filename}"`);
  
  // Remove characters that aren't allowed in filenames
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    // Ensure the filename isn't too long
    .substring(0, 100);
  
  debugLog(`Sanitized result: "${sanitized}"`);
  
  // Make sure there's an extension
  if (!sanitized.includes('.')) {
    debugLog(`Adding .jpg extension to filename without extension`);
    return sanitized + '.jpg';
  }
  
  return sanitized;
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
  debugLog(`Getting file extension for content type: ${contentType}`);
  
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
  
  const extension = typeMap[contentType] || '.jpg';
  debugLog(`Using extension: ${extension} for content type: ${contentType}`);
  return extension;
}

// Upload to storage (S3 or R2)
async function uploadToStorage(blob, filename, imageInfo, sourceInfo, domain = '') {
  // Choose the upload method based on config
  if (CONFIG.useS3) {
    return await uploadToS3(blob, filename, imageInfo, sourceInfo, CONFIG, domain);
  } else {
    try {
      debugLog('Attempting to upload to R2...');
      return await uploadToR2(blob, filename, imageInfo, sourceInfo, CONFIG, domain);
    } catch (error) {
      debugLog('R2 upload failed, trying local save as fallback if enabled');
      // If R2 upload fails but local saving is enabled, try local saving as a fallback
      if (CONFIG.local && CONFIG.local.enabled) {
        debugLog('Attempting local save as fallback after R2 failure');
        return await saveToLocalDisk(blob, filename, imageInfo, sourceInfo, domain);
      } else {
        // Re-throw the error if local saving is not enabled
        throw error;
      }
    }
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
    let result;
    
    // Handle different authentication methods
    if (r2Config.useApiToken) {
      debugLog('Using R2 API Token method');
      try {
        result = await uploadToR2WithToken(blob, fullPath, imageInfo, sourceInfo, settings);
        if (!result.success) {
          throw new Error(result.error || 'API token upload failed');
        }
      } catch (tokenError) {
        debugLog('API Token upload failed, falling back to Keys method', tokenError);
        // If token method fails, try the keys method as a fallback
        if (r2Config.accessKeyId && r2Config.secretAccessKey) {
          debugLog('Attempting fallback to API Keys method since API Token failed');
          result = await uploadToR2WithKeys(blob, fullPath, imageInfo, sourceInfo, settings);
        } else {
          throw tokenError; // Re-throw if we can't use the fallback
        }
      }
    } else {
      debugLog('Using R2 API Keys method');
      result = await uploadToR2WithKeys(blob, fullPath, imageInfo, sourceInfo, settings);
    }
    
    return result;
  } catch (error) {
    debugLog('R2 upload error:', error);
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
    
    // Instead of using custom headers with potential non-ASCII characters,
    // let's skip metadata and focus on getting the upload working first
    const headers = {
      'Authorization': `Bearer ${r2Config.apiToken}`,
      'Content-Type': blob.type || 'application/octet-stream'
    };
    
    // TEMPORARILY DISABLE METADATA to avoid non-ASCII issues
    // We can re-enable this later with proper encoding if needed
    if (false && addMetadata && sourceInfo) {
      // This section is temporarily disabled
    }
    
    debugLog('R2 Upload using simplified headers');
    
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
      success: true,
      url: fileUrl,
      size: blob.size,
      type: blob.type,
      path: fullPath,
      bucket: r2Config.bucketName,
      sourceInfo: addMetadata ? sourceInfo : null
    };
  } catch (error) {
    console.error('R2 upload error with API token:', error);
    return {
      success: false,
      error: `R2 upload failed: ${error.message}`
    };
  }
}

// Dedicated debug logging function that ensures visibility in console
function debugLog(message, data) {
  const timestamp = new Date().toISOString();
  const prefix = '[PAGE-IMAGE-SAVER DEBUG]';
  
  if (data) {
    console.log(prefix, timestamp, message, data);
    // Force an error to make the log more visible in the console
    console.trace(prefix + ' ' + timestamp + ' ' + message);
  } else {
    console.log(prefix, timestamp, message);
    console.trace(prefix + ' ' + timestamp + ' ' + message);
  }
}

// Save file to local disk using the Chrome Downloads API
async function saveToLocalDisk(blob, filename, imageInfo, sourceInfo, domain = '') {
  try {
    debugLog(`Starting local download for: ${filename}`);
    debugLog('Local download settings:', CONFIG.local);
    
    // Use the custom base folder from settings, defaulting to PageImageSaver
    const baseFolder = CONFIG.local.baseFolder || 'PageImageSaver';
    
    // Make sure the base folder name is valid
    const sanitizedBaseFolder = baseFolder.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Always start with a base folder for the extension to keep downloads organized
    let path = sanitizedBaseFolder + '/';
    debugLog(`Using base folder: ${path}`);
    
    // Add domain subfolder if enabled
    if (CONFIG.local.subfolderPerDomain && domain) {
      const sanitizedDomain = sanitizeDomain(domain);
      path += sanitizedDomain + '/';
      debugLog(`Using domain subfolder: ${path}`);
    } else {
      // If not using domain folders, at least organize by date
      const today = new Date();
      const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}/`;
      path += dateFolder;
      debugLog(`Using date folder: ${path}`);
    }
    
    debugLog(`Final path structure: ${path}`);
    
    // For service workers, we need to use a different approach since URL.createObjectURL is not available
    // Convert the blob to a base64 data URL
    const reader = new FileReader();
    const dataUrlPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to convert blob to data URL'));
      reader.readAsDataURL(blob);
    });
    
    const dataUrl = await dataUrlPromise;
    debugLog(`Converted blob to data URL (length: ${dataUrl.length})`);
    
    // Track the filename we're trying to use
    const targetFilename = path + filename;
    debugLog(`🔍 Attempting to save with filename: "${targetFilename}"`);
    
    // Make sure the target filename has the right file extension based on the content type
    let finalTargetFilename = targetFilename;
    if (!finalTargetFilename.includes('.')) {
      // Add appropriate extension based on content type
      const ext = getExtensionFromContentType(blob.type);
      finalTargetFilename += ext;
      debugLog(`Added file extension to filename: "${finalTargetFilename}"`);
    }
    
    // Prepare download options - Edge may have issues with file paths
    // Try with saveAs option to allow the user to confirm the filename
    const downloadOptions = {
      url: dataUrl,
      filename: finalTargetFilename,
      saveAs: true, // Show save dialog to ensure proper filename (works better in Edge)
      conflictAction: 'uniquify' // Automatically rename if file exists
    };
    
    // Check browser type
    const browserType = detectBrowser();
    debugLog(`Browser detected for this download: ${browserType}`);
    
    // Check if we're in Edge or if Edge mode is enabled
    let edgeMode = browserType === "Edge";
    
    // Check if Edge mode is manually enabled/disabled in settings
    chrome.storage.local.get(['edgeMode'], (result) => {
      if (result.edgeMode !== undefined) {
        edgeMode = result.edgeMode;
        debugLog(`Using manual Edge mode setting: ${edgeMode}`);
      }
    });
    
    if (browserType === "Edge" || edgeMode) {
      debugLog("⚠️ Microsoft Edge detected or Edge mode enabled - using saveAs dialog");
      // For Edge, show the save dialog to let user choose the save location and confirm filename
      downloadOptions.saveAs = true;
      
      // Create a "suggested" filename that's more descriptive than "download.jpg"
      // This helps the user identify what they're saving even if Edge doesn't use the folder structure
      if (!finalTargetFilename.includes('/')) {
        // If there's no path separator, it's just a filename
        const edgeFilename = `PageImageSaver_${Date.now()}_${finalTargetFilename}`;
        downloadOptions.filename = edgeFilename;
        debugLog(`📋 Edge-specific filename: ${edgeFilename}`);
      } else {
        // If there is a path, extract just the filename part for Edge
        const lastSlash = finalTargetFilename.lastIndexOf('/');
        const filenameOnly = finalTargetFilename.substring(lastSlash + 1);
        const edgeFilename = `PageImageSaver_${filenameOnly}`;
        downloadOptions.filename = edgeFilename;
        debugLog(`📋 Edge-specific filename (extracted): ${edgeFilename}`);
      }
    }
    
    // Log the complete download options
    debugLog('Complete download options:', JSON.stringify(downloadOptions, null, 2));
    
    debugLog('Download options:', downloadOptions);
    
    // Start the download
    debugLog('Initiating chrome.downloads.download...');
    const downloadId = await chrome.downloads.download(downloadOptions);
    debugLog(`Download started with ID: ${downloadId}`);
    
    // Explicitly log download destinations right away
    chrome.downloads.search({id: downloadId}, (downloads) => {
      if (downloads && downloads.length > 0) {
        const download = downloads[0];
        debugLog('⭐⭐⭐ INITIAL DOWNLOAD DESTINATION:', download.filename);
        
        // Also check the default download directory settings
        chrome.downloads.search({}, (allDownloads) => {
          debugLog('Recent downloads to help identify download location:');
          const recentDownloads = allDownloads.slice(0, 3);
          recentDownloads.forEach(d => {
            debugLog(`Download #${d.id}: ${d.filename}`);
          });
        });
      }
    });
    
    // No need to revoke data URLs as they're not stored in the browser's memory like blob URLs
    
    // Listen for download completion
    return new Promise((resolve, reject) => {
      const downloadListener = (delta) => {
        debugLog('Download status change:', delta);
        if (delta.id === downloadId && delta.state) {
          if (delta.state.current === 'complete') {
            debugLog(`✅ Download #${downloadId} completed successfully`);
            
            // Get the full path from the downloads API
            chrome.downloads.search({ id: downloadId }, (results) => {
              if (results && results.length > 0) {
                const download = results[0];
                
                // Parse the actual filename from the full path
                const fullPath = download.filename;
                const lastSeparatorIndex = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
                const actualFilename = lastSeparatorIndex > -1 ? fullPath.substring(lastSeparatorIndex + 1) : fullPath;
                
                debugLog('💾 DOWNLOAD SAVED TO LOCAL PATH:', download.filename);
                debugLog(`📄 ACTUAL FILENAME USED: "${actualFilename}" (expected: "${path + filename}")`);
                debugLog('Download complete details:', download);
                debugLog(`⭐⭐⭐ DOWNLOAD STATE: ${download.state} - Expected filename: ${path + filename}`);
                
                // Check if the filename matches what we expected
                if (actualFilename === 'download.jpg' || actualFilename.startsWith('download')) {
                  debugLog(`⚠️ WARNING: Generic filename "${actualFilename}" was used instead of "${path + filename}"`);
                }
                
                // Add a definitive breakpoint opportunity
                debugger; // This will pause execution when DevTools is open
                
                chrome.downloads.onChanged.removeListener(downloadListener);
                resolve({
                  success: true,
                  type: 'local',
                  path: path + filename,
                  fullPath: download.filename,
                  actualFilename: actualFilename
                });
              } else {
                debugLog(`⚠️ Could not find download details for ID: ${downloadId}`);
                chrome.downloads.onChanged.removeListener(downloadListener);
                resolve({
                  success: true,
                  type: 'local',
                  path: path + filename
                });
              }
            });
          } else if (delta.state.current === 'interrupted') {
            debugLog(`❌ Download interrupted:`, delta.error);
            chrome.downloads.onChanged.removeListener(downloadListener);
            reject(new Error(`Download failed: ${delta.error?.current || 'unknown error'}`));
          }
        }
      };
      
      chrome.downloads.onChanged.addListener(downloadListener);
    });
  } catch (error) {
    debugLog(`❌ Local download error: ${error.message}`);
    debugLog('Error stack:', error.stack);
    return {
      success: false,
      error: `Local download failed: ${error.message}`
    };
  }
}

// Check if the configuration is valid for cloud storage operations
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

// Helper function to convert Blob to data URL (useful in service worker context)
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert blob to data URL'));
    reader.readAsDataURL(blob);
  });
}

// Detect browser type
function detectBrowser() {
  const userAgent = navigator.userAgent;
  let browserName;
  
  if (userAgent.match(/chrome|chromium|crios/i)) {
    browserName = "Chrome";
    if (userAgent.match(/edg/i)) {
      browserName = "Edge";
    }
  } else if (userAgent.match(/firefox|fxios/i)) {
    browserName = "Firefox";
  } else if (userAgent.match(/safari/i)) {
    browserName = "Safari";
  } else if (userAgent.match(/opr\//i)) {
    browserName = "Opera";
  } else {
    browserName = "Unknown";
  }
  
  return browserName;
}

// Log browser information
const browserType = detectBrowser();
console.log(`Page Image Saver background script loaded in ${browserType} browser.`);
debugLog(`🌐 Browser detected: ${browserType}`);
debugLog(`🔍 Full User Agent: ${navigator.userAgent}`);
