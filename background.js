//background.js
// Debugging helper - will show a notification with download paths
function showSavePathNotification(path) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/48.png',
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
// Helper function to check if a URL is likely a tracking pixel
function isTrackingPixel(url) {
  const trackingPatterns = [
    '/fd/ls/l?', // Bing tracking
    '/pagead/', // Google ads
    '/ga-audiences', // Google Analytics
    '/pixel', // Generic pixel trackers
    '/beacon', // Beacons
    '/track', // Generic tracking
    '/analytics', // Analytics
    '/collect', // Collection endpoints
    '/metric', // Metrics
    '/p.gif', // Tracking pixels with p.gif
    '/ping', // Ping endpoints
    '/stats', // Stats collection
    '/impression', // Ad impressions
    '/piwik', // Piwik/Matomo analytics
    '/counter', // Counters
    '/B?BF=', // Specific Bing format
    '/ClientInst', // Microsoft client instrumentation
    '/FilterFlare', // More Bing tracking
  ];
  
  return trackingPatterns.some(pattern => url.includes(pattern));
}

// Listen to all image network requests and notify content scripts of dynamic loads
chrome.webRequest.onCompleted.addListener((details) => {
  // Only forward image requests from valid tabs
  if (details.tabId >= 0 && details.type === 'image' && details.url) {
    // Skip tracking pixels and other tracking related images
    if (isTrackingPixel(details.url)) {
      return;
    }
    
    // Skip tiny images (likely tracking pixels) by checking content length if available
    if (details.responseHeaders) {
      const contentLengthHeader = details.responseHeaders.find(
        header => header.name.toLowerCase() === 'content-length'
      );
      if (contentLengthHeader && parseInt(contentLengthHeader.value) < 1024) {
        // Skip images smaller than 1KB (likely tracking pixels)
        return;
      }
    }
    
    // Fire-and-forget; include callback to swallow errors if no content script is listening
    chrome.tabs.sendMessage(details.tabId, {
      action: 'dynamicImageLoaded',
      url: details.url,
      timestamp: details.timeStamp
    }, () => {
      if (chrome.runtime.lastError) {
        // No receiver in tab (content script not loaded); ignore
      }
    });
  }
}, {
  urls: ["<all_urls>"]
}, ['responseHeaders']);

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
  
  // Local download settings - disabled by default
  local: {
    enabled: true,
    subfolderPerDomain: false,
    baseFolder: 'PageImageSaver'
  },
  
  // Retry settings
  retry: {
    enabled: true,
    maxRetries: 3,
    showNotification: true
  },
  
  // General settings
  preserveFilenames: true, // Try to preserve original filenames when possible
  addMetadata: true, // Add metadata about the source page
  maxConcurrentUploads: 10, // Process more images in parallel (was 3)
  minFileSize: 5 * 1024, // Minimum file size in bytes (5KB default)
  useDomainFolders: true, // Organize images by domain in subfolders
  progressUpdateInterval: 5 // How many images to process before sending progress update
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

// Clear existing context menus to avoid duplicates
chrome.contextMenus.removeAll(() => {
  console.log('Removed all existing context menus');
  
  // Add a context menu item to open settings
  chrome.contextMenus.create({
    id: 'openSettings',
    title: 'Settings',
    contexts: ['action'] // Only show when clicking on extension icon
  });
  
  // Add a retry uploads menu item
  chrome.contextMenus.create({
    id: 'retryUploads',
    title: 'Retry Failed Uploads',
    contexts: ['action'] // Only show when clicking on extension icon
  });
  
  // Add a debug menu item to check download paths
  chrome.contextMenus.create({
    id: 'debugDownloadPath',
    title: 'Debug: Show Download Location',
    contexts: ['action'] // Only show when clicking on extension icon
  });
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
  } else if (info.menuItemId === 'retryUploads') {
    // Show the number of failed uploads first
    chrome.storage.local.get({failedUploads: []}, (result) => {
      const failedUploads = result.failedUploads || [];
      
      if (failedUploads.length === 0) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
          title: 'Retry Uploads',
          message: 'No failed uploads found to retry.',
          priority: 2
        });
      } else {
        // Confirm retry with the user
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
          title: 'Retry Uploads',
          message: `Found ${failedUploads.length} failed uploads. Retrying...`,
          priority: 2
        });
        
        // Start the retry process
        retryFailedUploads();
      }
    });
  } else if (info.menuItemId === 'edgeFilenameMode') {
    // Toggle a flag in storage for Edge mode
    chrome.storage.local.get(['edgeMode'], (result) => {
      const currentMode = result.edgeMode || false;
      const newMode = !currentMode;
      
      chrome.storage.local.set({ edgeMode: newMode }, () => {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
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
            iconUrl: 'icons/48.png',
            title: 'Download Directory',
            message: `Chrome is saving files to:\n${directoryPath}`,
            priority: 2
          });
        });
      } else {
        debugLog('No recent downloads found');
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
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
                iconUrl: 'icons/48.png',
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
  // Make sure we're on a valid tab and page has finished loading
  if (tab.url && tab.url.startsWith('http')) {
    // Check if the content script is already injected
    chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => {
        return typeof window.PageImageSaverLoaded !== 'undefined';
      }
    }).then(results => {
      // If content script is not loaded (or the check failed)
      if (!results || !results[0] || !results[0].result) {
        // Inject content script manually
        chrome.scripting.executeScript({
          target: {tabId: tab.id},
          files: ['content_script.js']
        }).then(() => {
          // Wait a moment for the script to initialize
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, {action: 'findImages'}, response => {
              if (chrome.runtime.lastError) {
                console.error('Error sending message after injection:', chrome.runtime.lastError);
                chrome.tabs.create({ url: 'settings.html' });
              }
            });
          }, 500);
        }).catch(error => {
          console.error('Error injecting content script:', error);
          chrome.tabs.create({ url: 'settings.html' });
        });
      } else {
        // Content script is loaded, send message directly
        chrome.tabs.sendMessage(tab.id, {action: 'findImages'}, response => {
          if (chrome.runtime.lastError) {
            console.error('Error sending message to content script:', chrome.runtime.lastError);
            if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.includes('Could not establish connection')) {
              chrome.tabs.create({ url: 'settings.html' });
            }
          }
        });
      }
    }).catch(error => {
      console.error('Error checking for content script:', error);
      chrome.tabs.create({ url: 'settings.html' });
    });
  } else {
    // Not a valid URL for content script, open settings page
    chrome.tabs.create({ url: 'settings.html' });
  }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(command => {
  if (command === 'find_images' || command === 'take_screenshot') {
    chrome.tabs.query({active: true, currentWindow: true}, tabs => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.startsWith('http')) {
        // Check if content script is loaded
        chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: () => {
            return typeof window.PageImageSaverLoaded !== 'undefined';
          }
        }).then(results => {
          // If content script is not loaded (or the check failed)
          if (!results || !results[0] || !results[0].result) {
            // Inject content script manually
            chrome.scripting.executeScript({
              target: {tabId: tab.id},
              files: ['content_script.js']
            }).then(() => {
              // Wait a moment for script to initialize
              setTimeout(() => {
                const action = command === 'find_images' ? 'findImages' : 'takeScreenshot';
                chrome.tabs.sendMessage(tab.id, {action: action}, response => {
                  if (chrome.runtime.lastError) {
                    console.error(`Error sending ${action} message after injection:`, chrome.runtime.lastError);
                  }
                });
              }, 500);
            }).catch(error => {
              console.error('Error injecting content script:', error);
            });
          } else {
            // Content script is loaded, send message directly
            const action = command === 'find_images' ? 'findImages' : 'takeScreenshot';
            chrome.tabs.sendMessage(tab.id, {action: action}, response => {
              if (chrome.runtime.lastError) {
                console.error(`Error sending ${action} message to content script:`, chrome.runtime.lastError);
              }
            });
          }
        }).catch(error => {
          console.error('Error checking for content script:', error);
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
    
    // Start a processing job to handle the image uploads
    // We'll immediately send a provisional response to keep the channel open,
    // but we won't send the final response until everything is done
    let processingComplete = false;
    
    // Send an immediate provisional response to acknowledge receipt
    console.log(`[UPLOAD START] Sending provisional response for ${images.length} images`);
    sendResponse({
      success: true,
      provisional: true,
      message: 'Processing started, check console for progress',
      total: images.length
    });
    
    // Process images in batches to limit concurrent uploads
    processImagesInBatches(images, sourceInfo, sender.tab.id)
      .then(results => {
        processingComplete = true;
        
        const successCount = results.filter(r => r.success).length;
        console.log(`[UPLOAD FINAL] Upload process completed. Final stats: ${successCount} successful, ${results.length - successCount} failed`);
        
        // Send a final completion message to the tab
        try {
          console.log(`[UPLOAD COMPLETE] Sending completion message to tab ${sender.tab.id}`);
          chrome.tabs.sendMessage(sender.tab.id, {
            action: 'uploadComplete',
            success: true, 
            count: successCount,
            failures: results.length - successCount,
            total: results.length,
            timestamp: Date.now()
          }, response => {
            console.log(`[UPLOAD COMPLETE] Completion message response:`, response || 'No response');
          });
        } catch (sendError) {
          // If we can't send the message, show a notification
          console.warn('[UPLOAD ERROR] Could not send completion message:', sendError);
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Image Upload Complete',
            message: `Saved ${successCount} of ${results.length} images`,
            priority: 2
          });
        }
      })
      .catch(error => {
        processingComplete = true;
        console.error('[UPLOAD ERROR] Error saving images:', error);
        
        // Send error completion message to tab
        try {
          console.log(`[UPLOAD ERROR] Sending error completion message to tab ${sender.tab.id}`);
          chrome.tabs.sendMessage(sender.tab.id, {
            action: 'uploadComplete',
            success: false, 
            error: error.message,
            timestamp: Date.now()
          }, response => {
            console.log(`[UPLOAD ERROR] Error completion message response:`, response || 'No response');
          });
        } catch (sendError) {
          // If we can't send the message, show a notification
          console.warn('[UPLOAD ERROR] Could not send error message:', sendError);
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Image Upload Error',
            message: `Error: ${error.message}`,
            priority: 2
          });
          console.log(`[UPLOAD NOTIFICATION] Created error notification since tab message failed`);
        }
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

    // Get domain for local subfolders if enabled
    let localDomainForScreenshot = '';
    if (CONFIG.local.subfolderPerDomain && metadata && metadata.url) {
      try {
        const urlObj = new URL(metadata.url);
        localDomainForScreenshot = urlObj.hostname;
      } catch (e) { console.warn('Could not parse URL for local domain folder (screenshot):', e); }
    }

    if (CONFIG.local && CONFIG.local.enabled) {
      console.log('[processScreenshot] Local saving enabled for screenshot, attempting local save');
      debugLog('[processScreenshot] Local saving enabled for screenshot, attempting local save. Filename: ' + filename);
      promises.push(saveLocally(blob, filename, metadata, localDomainForScreenshot));
    } else {
      debugLog('[processScreenshot] Local saving for screenshot is disabled');
    }
    
    // Upload to cloud storage if configured
    if (isConfigValid()) {
      console.log('[processScreenshot] Cloud storage is configured, attempting screenshot upload');
      debugLog('[processScreenshot] Cloud storage is configured, attempting screenshot upload. Filename: ' + filename);
      promises.push(uploadToStorage(blob, filename, { type: 'screenshot' }, metadata, domain));
    } else {
      debugLog('[processScreenshot] Cloud storage not configured or invalid settings');
    }
    
    if (promises.length === 0) {
      // This means !CONFIG.local.enabled && !isConfigValid()
      console.error('[processScreenshot] No storage methods enabled for screenshot.');
      debugLog('[processScreenshot] No storage methods enabled for screenshot. Both local and cloud are disabled/misconfigured.');
      sendResponse({
        success: false,
        error: 'Storage not configured. Please enable local saving or set up S3 or R2 storage.'
      });
      return true; 
    }
    
    // Set a timeout to ensure sendResponse happens even if processing takes too long
    const responseTimeout = setTimeout(() => {
      console.warn('Screenshot processing took too long, sending preliminary response');
      sendResponse({
        success: true,
        provisional: true,
        message: 'Processing started, check notifications for completion'
      });
    }, 5000); // 5 second timeout
    
    // Wait for all operations to complete
    Promise.all(promises)
      .then(results => {
        // Clear the timeout
        clearTimeout(responseTimeout);
        
        console.log('Screenshot save operations completed:', results);
        
        // Filter successful results
        const successfulResults = results.filter(r => r && r.success);
        console.log('Successful screenshot operations:', successfulResults.length);
        debugLog(`[processScreenshot] Successful operations: ${successfulResults.length} out of ${results.length}`);

        successfulResults.forEach(result => {
            if (result.type === 'local' && result.path) {
                debugLog(`[processScreenshot] 📁 SCREENSHOT SAVED TO LOCAL PATH: ${result.path}`);
            } else if (result.url) {
                debugLog(`[processScreenshot] 🌐 SCREENSHOT SAVED TO REMOTE URL: ${result.url}`);
            }
        });
        
        try {
          if (successfulResults.length > 0) {
            sendResponse({
              success: true,
              // Return the URL of the first successful save (prefer cloud, then local)
              url: successfulResults.find(r => r.url)?.url || successfulResults.find(r => r.path)?.path || 'File saved'
            });
          } else {
             const errorMessages = results.map(r => r.error).filter(e => e).join('; ');
            sendResponse({
              success: false,
              error: errorMessages || 'Failed to save screenshot'
            });
          }
        } catch (responseError) {
          console.warn('[processScreenshot] Could not send screenshot response, channel may be closed:', responseError);
          debugLog('[processScreenshot] Could not send screenshot response, channel may be closed. Error: ' + responseError.message);
          
          // Show notification instead
          if (successfulResults.length > 0) {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/48.png',
              title: 'Screenshot Saved',
              message: 'Screenshot was successfully saved.', // Simplified message
              priority: 2
            });
          } else {
            const errorMessages = results.map(r => r.error).filter(e => e).join('; ');
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/48.png',
              title: 'Screenshot Error',
              message: `Failed to save screenshot: ${errorMessages || 'Unknown error'}. Please check settings.`,
              priority: 2
            });
          }
        }
      })
      .catch(error => {
        // Clear the timeout
        clearTimeout(responseTimeout);
        
        console.error('[processScreenshot] Error processing screenshot:', error);
        debugLog('[processScreenshot] Error processing screenshot: ' + error.message);
        
        try {
          sendResponse({
            success: false,
            error: error.message
          });
        } catch (responseError) {
          console.warn('[processScreenshot] Could not send screenshot error response, channel may be closed:', responseError);
          debugLog('[processScreenshot] Could not send screenshot error response, channel may be closed. Error: ' + responseError.message);
          
          // Show notification instead
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Screenshot Error',
            message: `Error: ${error.message}`,
            priority: 2
          });
        }
      });
    
    return true; // Keep the message channel open for async response
  } else if (message.action === 'testConnection') {
    // Test connection with provided settings
    const testSettings = message.settings;
    const testBlob = dataURItoBlob('data:text/plain;base64,' + btoa('test file content'));
    const testFilename = message.testFile.filename;
    
    // Set a timeout to ensure sendResponse happens even if processing takes too long
    const responseTimeout = setTimeout(() => {
      console.warn('Connection test took too long, sending preliminary response');
      sendResponse({
        success: false,
        error: 'The connection test is taking longer than expected. This usually indicates connectivity issues.'
      });
    }, 10000); // 10 second timeout
    
    // Use the provided settings for this test instead of the global CONFIG
    testUploadToStorage(testBlob, testFilename, { type: 'test' }, { test: true }, testSettings)
      .then(result => {
        // Clear the timeout
        clearTimeout(responseTimeout);
        
        try {
          sendResponse({
            success: true,
            url: result.url
          });
        } catch (responseError) {
          console.warn('Could not send test connection response, channel may be closed:', responseError);
          
          // Show notification instead
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Connection Test',
            message: 'Connection test successful! Your storage is properly configured.',
            priority: 2
          });
        }
      })
      .catch(error => {
        // Clear the timeout
        clearTimeout(responseTimeout);
        
        console.error('Error testing connection:', error);
        
        try {
          sendResponse({
            success: false,
            error: error.message
          });
        } catch (responseError) {
          console.warn('Could not send test connection error response, channel may be closed');
          
          // Show notification instead
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Connection Test Failed',
            message: `Error: ${error.message}`,
            priority: 2
          });
        }
      });
    
    return true; // Keep the message channel open for async response
  }
});

// Process images in controlled batches
async function processImagesInBatches(images, sourceInfo, tabId) {
  const results = [];
  const batchSize = CONFIG.maxConcurrentUploads;
  let totalCompleted = 0;
  let processedInCurrentInterval = 0;
  let successCount = 0;
  const updateInterval = CONFIG.progressUpdateInterval || 5;
  
  // Function to send progress updates to content script
  async function sendProgressUpdate(forceUpdate = false) {
    // Only send updates if we have a tab ID and either it's forced or we've hit the update interval
    if (tabId && (forceUpdate || processedInCurrentInterval >= updateInterval)) {
      processedInCurrentInterval = 0; // Reset the counter
      
      // ALWAYS log progress to console for debugging
      console.log(`[UPLOAD PROGRESS] ${totalCompleted}/${images.length} images processed (${successCount} successful)`);
      
      try {
        await new Promise((resolve) => {
          debugLog(`Sending progress update: ${totalCompleted}/${images.length} (${successCount} successful)`);
          
          // Also log when we're trying to send a message
          console.log(`[UPLOAD MSG] Sending progress update to tab ${tabId}: ${totalCompleted}/${images.length}`);
          
          chrome.tabs.sendMessage(
            tabId, 
            {
              action: 'uploadProgress',
              completed: totalCompleted,
              total: images.length,
              successCount: successCount,
              timestamp: Date.now()
            },
            (response) => {
              // Log the response
              console.log(`[UPLOAD MSG] Progress update response:`, response || 'No response');
              
              // Always resolve, even if there's an error
              // We don't want to block processing if updates fail
              resolve(response || {received: false});
            }
          );
          
          // Set a longer timeout for receiving responses
          setTimeout(() => {
            console.log(`[UPLOAD MSG] Progress update timed out after 2 seconds`);
            resolve({received: false, timedOut: true});
          }, 2000);
        });
      } catch (error) {
        console.warn('[UPLOAD ERROR] Failed to send progress update:', error);
        // Continue processing even if progress updates fail
      }
    }
  }
  
  try {
    console.log(`[UPLOAD START] Starting to process ${images.length} images in batches of ${batchSize}`);
    
    // Initial progress update
    await sendProgressUpdate(true);
    
    // Process in batches
    for (let i = 0; i < images.length; i += batchSize) {
      const batch = images.slice(i, i + batchSize);
      console.log(`[UPLOAD BATCH] Processing batch ${Math.floor(i/batchSize) + 1} with ${batch.length} images (${i}-${Math.min(i + batchSize, images.length)})`);
      
      // Process each image in the batch with progress tracking
      for (let j = 0; j < batch.length; j++) {
        const image = batch[j];
        const imageIndex = i + j;
        
        console.log(`[UPLOAD IMAGE] Processing image ${imageIndex + 1}/${images.length}: ${image.url.substring(0, 50)}...`);
        
        // Process this single image
        const result = await processImage(image, sourceInfo);
        results.push(result);
        
        // Update counters
        totalCompleted++;
        processedInCurrentInterval++;
        if (result.success) {
          successCount++;
          console.log(`[UPLOAD SUCCESS] Image ${imageIndex + 1} uploaded successfully`);
        } else {
          console.log(`[UPLOAD FAIL] Image ${imageIndex + 1} failed: ${result.error || 'Unknown error'}`);
        }
        
        // Send progress updates at regular intervals
        await sendProgressUpdate();
      }
      
      // Force a progress update after each batch completes
      await sendProgressUpdate(true);
      console.log(`[UPLOAD BATCH DONE] Batch ${Math.floor(i/batchSize) + 1} complete. Progress: ${totalCompleted}/${images.length}`);
    }
    
    // Final progress update
    await sendProgressUpdate(true);
    
    console.log(`[UPLOAD COMPLETE] Finished processing all ${images.length} images. Results: ${successCount} successful, ${totalCompleted - successCount} failed`);
    
    return results;
  } catch (error) {
    console.error('Error in batch processing:', error);
    // Send one final update even on error
    await sendProgressUpdate(true);
    return results; // Return any results we managed to get
  }
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
    const filenameForOperations = getFilename(image.url, imageBlob.type);
    
    // Get domain for organizing in cloud folders if enabled
    let domain = ''; // For cloud
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
    
    // Get domain for local subfolders if enabled
    let localDomain = '';
    if (CONFIG.local.subfolderPerDomain && sourceInfo && sourceInfo.url) {
      try {
        const urlObj = new URL(sourceInfo.url);
        localDomain = urlObj.hostname;
      } catch (e) { console.warn('Could not parse URL for local domain folder:', e); }
    }
    
    console.log('Processing image with current config:', CONFIG);
    
    const promises = [];
    
    if (CONFIG.local && CONFIG.local.enabled) {
      debugLog('[processImage] Local saving is enabled, attempting local save');
      promises.push(saveLocally(imageBlob, filenameForOperations, sourceInfo, localDomain));
    } else {
      debugLog('[processImage] Local saving is disabled');
    }
    
    // Upload to cloud storage if configured
    if (isConfigValid()) {
      debugLog('[processImage] Cloud storage is configured, attempting upload');
      promises.push(uploadToStorage(imageBlob, filenameForOperations, image, sourceInfo, domain));
    } else {
      debugLog('[processImage] Cloud storage not configured or invalid settings');
    }
    
    if (promises.length === 0) {
      // This means !CONFIG.local.enabled && !isConfigValid()
      debugLog('[processImage] No storage methods enabled.');
      throw new Error('Storage not configured. Please enable local saving or set up S3/R2 storage in extension settings.');
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
      debugLog(`Successfully saved ${filenameForOperations}`);
      
      // Log more detailed information about where files were saved
      successfulResults.forEach(result => {
        if (result.type === 'local' && result.path) { // Updated to result.path from result.fullPath
          debugLog(`📁 IMAGE SAVED TO LOCAL PATH: ${result.path}`);
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
      // Collect error messages if all promises failed
      const errorMessages = results.map(r => r.error).filter(e => e).join('; ');
      throw new Error(errorMessages || 'All save operations failed');
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

// Save image to local disk via Downloads API
async function saveLocally(blob, originalFilename, sourceInfo, domain) {
  let objectURL;
  const functionName = 'saveLocally'; // For debug logs
  try {
    debugLog(`[${functionName}] Starting local save. Original filename: ${originalFilename}, Domain: ${domain}, Blob type: ${blob.type}, Blob size: ${blob.size}`);
    const baseFolder = CONFIG.local.baseFolder || 'PageImageSaver';
    let downloadPath = baseFolder;

    if (CONFIG.local.subfolderPerDomain && domain) {
      if (downloadPath !== '' && !downloadPath.endsWith('/')) {
        downloadPath += '/';
      }
      downloadPath += sanitizeDomain(domain);
    }

    let filenameToUse;
    if (CONFIG.preserveFilenames && originalFilename) {
      filenameToUse = sanitizeFilename(originalFilename);
    } else {
      const ext = getExtensionFromContentType(blob.type) || '.png'; // Default to .png if type is unknown
      filenameToUse = `image_${Date.now()}${ext}`;
      debugLog(`[${functionName}] preserveFilenames is false or originalFilename not provided. Generated filename: ${filenameToUse}`);
    }
    
    if (downloadPath !== '' && !downloadPath.endsWith('/')) {
      downloadPath += '/';
    }
    // Ensure filenameToUse is not empty, otherwise path might end with just a slash
    if (filenameToUse) {
        downloadPath += filenameToUse;
    } else {
        // Fallback if filenameToUse ends up empty (should not happen with current logic)
        const ext = getExtensionFromContentType(blob.type) || '.png';
        downloadPath += `image_${Date.now()}${ext}`;
        debugLog(`[${functionName}] filenameToUse was empty, used fallback: ${downloadPath}`);
    }
    
    downloadPath = downloadPath.replace(/\\/g, '/').replace(/\/g, '/'); // Normalize to forward slashes

    debugLog(`[${functionName}] Constructed download path: ${downloadPath}`);

    objectURL = URL.createObjectURL(blob);
    debugLog(`[${functionName}] Created object URL: ${objectURL}`);

    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: objectURL,
        filename: downloadPath,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (id) => {
        if (id === undefined) {
          const errorMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed: ID is undefined. Check path/permissions.';
          debugLog(`[${functionName}] chrome.downloads.download failed. Error: ${errorMsg}`);
          reject(new Error(errorMsg));
        } else {
          debugLog(`[${functionName}] chrome.downloads.download initiated. Download ID: ${id}`);
          resolve(id);
        }
      });
    });
    
    return { success: true, path: downloadPath, downloadId: downloadId, type: 'local' };
  } catch (error) {
    console.error(`[${functionName}] Error:`, error); // Keep console.error for visibility
    debugLog(`[${functionName}] Local save error: ${error.message}. Blob type: ${blob.type}, Original filename: ${originalFilename}`);
    return { success: false, error: error.message, type: 'local' };
  } finally {
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
      debugLog(`[${functionName}] Revoked object URL: ${objectURL}`);
    }
  }
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
      // Local saving functionality has been removed, just re-throw the error
      debugLog('R2 upload failed, no fallback available');
      throw error;
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
      // Add source information
      if (sourceInfo.url) {
        metadata['source-url'] = sourceInfo.url;
      }
      
      if (sourceInfo.title) {
        metadata['source-title'] = sourceInfo.title;
      }
      
      metadata['upload-date'] = sourceInfo.timestamp || new Date().toISOString();
      
      // Add alt text metadata if available
      if (imageInfo && imageInfo.alt && imageInfo.alt !== 'No description') {
        metadata['alt-text'] = imageInfo.alt;
      }
      
      // Add image dimensions if available
      if (imageInfo && imageInfo.naturalWidth && imageInfo.naturalHeight) {
        metadata['width'] = imageInfo.naturalWidth.toString();
        metadata['height'] = imageInfo.naturalHeight.toString();
      } else if (imageInfo && imageInfo.width && imageInfo.height) {
        metadata['width'] = imageInfo.width.toString();
        metadata['height'] = imageInfo.height.toString();
      }
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
async function uploadToR2(blob, filename, imageInfo, sourceInfo, settings, domain = '', retryCount = 0) {
  // Get the settings for this upload
  const r2Config = settings.r2;
  const addMetadata = settings.addMetadata;
  const useDomainFolders = settings.useDomainFolders;
  
  // Max number of retries
  const MAX_RETRIES = 3;
  
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
      debugLog(`Using R2 API Token method (retry attempt: ${retryCount})`);
      try {
        result = await uploadToR2WithToken(blob, fullPath, imageInfo, sourceInfo, settings);
        if (!result.success) {
          throw new Error(result.error || 'API token upload failed');
        }
      } catch (tokenError) {
        debugLog('API Token upload failed:', tokenError);
        
        // Check if we should retry due to Cloudflare error
        if (tokenError.message && tokenError.message.includes('520') && retryCount < MAX_RETRIES) {
          debugLog(`Cloudflare 520 error detected. Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
          // Wait with exponential backoff before retrying
          const backoffTime = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          await new Promise(resolve => setTimeout(resolve, backoffTime));
          return uploadToR2(blob, filename, imageInfo, sourceInfo, settings, domain, retryCount + 1);
        }
        
        // Try the keys method as a fallback if available
        if (r2Config.accessKeyId && r2Config.secretAccessKey) {
          debugLog('Attempting fallback to API Keys method since API Token failed');
          result = await uploadToR2WithKeys(blob, fullPath, imageInfo, sourceInfo, settings);
        } else {
          // Save the failed upload info to retry later
          saveFailedUpload(blob, filename, imageInfo, sourceInfo, settings, domain, tokenError.message);
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
    
    // Check if we should retry
    if (error.message && error.message.includes('520') && retryCount < MAX_RETRIES) {
      debugLog(`Cloudflare 520 error detected. Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      // Wait with exponential backoff before retrying
      const backoffTime = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      return uploadToR2(blob, filename, imageInfo, sourceInfo, settings, domain, retryCount + 1);
    }
    
    // Save the failed upload info to retry later
    saveFailedUpload(blob, filename, imageInfo, sourceInfo, settings, domain, error.message);
    
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
      // Add source information
      if (sourceInfo.url) {
        metadata['source-url'] = sourceInfo.url;
      }
      
      if (sourceInfo.title) {
        metadata['source-title'] = sourceInfo.title;
      }
      
      metadata['upload-date'] = sourceInfo.timestamp || new Date().toISOString();
      
      // Add alt text metadata if available
      if (imageInfo && imageInfo.alt && imageInfo.alt !== 'No description') {
        metadata['alt-text'] = imageInfo.alt;
      }
      
      // Add image dimensions if available
      if (imageInfo && imageInfo.naturalWidth && imageInfo.naturalHeight) {
        metadata['width'] = imageInfo.naturalWidth.toString();
        metadata['height'] = imageInfo.naturalHeight.toString();
      } else if (imageInfo && imageInfo.width && imageInfo.height) {
        metadata['width'] = imageInfo.width.toString();
        metadata['height'] = imageInfo.height.toString();
      }
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
    
    // Define headers with proper handling for non-ASCII characters
    const headers = {
      'Authorization': `Bearer ${r2Config.apiToken}`,
      'Content-Type': blob.type || 'application/octet-stream'
    };
    
    // Process metadata with proper encoding for non-ASCII characters
    if (addMetadata && sourceInfo) {
      // Add metadata as x-amz-meta-* headers with proper encoding
      if (sourceInfo.url) {
        headers['x-amz-meta-source-url'] = encodeURIComponent(sourceInfo.url);
      }
      
      if (sourceInfo.title) {
        // Encode title to handle non-ASCII characters
        headers['x-amz-meta-source-title'] = encodeURIComponent(sourceInfo.title);
      }
      
      if (sourceInfo.timestamp) {
        headers['x-amz-meta-upload-date'] = sourceInfo.timestamp;
      }
      
      // Add metadata for alt text if available
      if (imageInfo && imageInfo.alt) {
        headers['x-amz-meta-alt-text'] = encodeURIComponent(imageInfo.alt);
      }
      
      // Add image dimensions if available
      if (imageInfo && imageInfo.naturalWidth && imageInfo.naturalHeight) {
        headers['x-amz-meta-width'] = imageInfo.naturalWidth.toString();
        headers['x-amz-meta-height'] = imageInfo.naturalHeight.toString();
      } else if (imageInfo && imageInfo.width && imageInfo.height) {
        headers['x-amz-meta-width'] = imageInfo.width.toString();
        headers['x-amz-meta-height'] = imageInfo.height.toString();
      }
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

// Local disk saving functionality has been removed

// Check if the configuration is valid for cloud storage operations
function isConfigValid() {
  // Local saving functionality has been removed
  
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

// Functions for handling failed uploads and retries
function saveFailedUpload(blob, filename, imageInfo, sourceInfo, settings, domain, errorMessage) {
  if (!CONFIG.retry.enabled) return; // Don't save if retry is disabled
  
  // Convert blob to a data URL
  blobToDataURL(blob).then(dataUrl => {
    // Create a compressed entry to save
    const uploadEntry = {
      timestamp: Date.now(),
      filename: filename,
      dataUrl: dataUrl,
      imageInfo: imageInfo,
      sourceInfo: sourceInfo,
      settings: {
        useS3: settings.useS3,
        s3: settings.useS3 ? {
          region: settings.s3.region,
          bucketName: settings.s3.bucketName,
          folderPath: settings.s3.folderPath,
          accessKeyId: "***", // Don't store sensitive info
          secretAccessKey: "***",
          makePublic: settings.s3.makePublic
        } : null,
        r2: !settings.useS3 ? {
          accountId: settings.r2.accountId,
          bucketName: settings.r2.bucketName,
          folderPath: settings.r2.folderPath,
          useApiToken: settings.r2.useApiToken,
          accessKeyId: "***", // Don't store sensitive info
          secretAccessKey: "***",
          apiToken: "***",
          makePublic: settings.r2.makePublic
        } : null,
        addMetadata: settings.addMetadata,
        useDomainFolders: settings.useDomainFolders
      },
      domain: domain,
      error: errorMessage,
      retryCount: 0
    };
    
    // Save to storage
    chrome.storage.local.get({failedUploads: []}, (result) => {
      const failedUploads = result.failedUploads || [];
      failedUploads.push(uploadEntry);
      
      // Limit number of saved failed uploads (keep most recent 50)
      if (failedUploads.length > 50) {
        failedUploads.splice(0, failedUploads.length - 50);
      }
      
      chrome.storage.local.set({failedUploads: failedUploads}, () => {
        console.log('Failed upload saved for later retry');
        
        // Show notification if enabled
        if (CONFIG.retry.showNotification) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/48.png', // Use an icon that definitely exists
            title: 'Upload Failed',
            message: `The image "${filename}" failed to upload (${errorMessage}). You can retry from the extension menu.`,
            priority: 2
          });
        }
      });
    });
  }).catch(error => {
    console.error('Error saving failed upload:', error);
  });
}

// Retry all failed uploads
async function retryFailedUploads() {
  try {
    // Get current settings
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get('imageUploaderSettings', (result) => {
        resolve(result.imageUploaderSettings || CONFIG);
      });
    });
    
    // Get failed uploads
    const result = await new Promise((resolve) => {
      chrome.storage.local.get({failedUploads: []}, (result) => {
        resolve(result);
      });
    });
    
    const failedUploads = result.failedUploads || [];
    
    if (failedUploads.length === 0) {
      // Show notification if there's nothing to retry
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/48.png',
        title: 'Retry Uploads',
        message: 'No failed uploads found to retry.',
        priority: 2
      });
      return;
    }
    
    // Show progress notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Retrying Uploads',
      message: `Attempting to retry ${failedUploads.length} failed uploads...`,
      priority: 2
    });
    
    // Track successful and failed retries
    let successCount = 0;
    let failureCount = 0;
    const stillFailed = [];
    
    // Process in batches
    const batchSize = 3;
    for (let i = 0; i < failedUploads.length; i += batchSize) {
      const batch = failedUploads.slice(i, i + batchSize);
      
      // Process each batch
      await Promise.all(batch.map(async (entry) => {
        try {
          // Convert data URL back to blob
          const blob = dataURItoBlob(entry.dataUrl);
          
          // Get the actual credentials from current settings
          const currentSettings = {...entry.settings};
          
          if (currentSettings.useS3) {
            currentSettings.s3.accessKeyId = settings.s3.accessKeyId;
            currentSettings.s3.secretAccessKey = settings.s3.secretAccessKey;
          } else {
            currentSettings.r2.accessKeyId = settings.r2.accessKeyId;
            currentSettings.r2.secretAccessKey = settings.r2.secretAccessKey;
            currentSettings.r2.apiToken = settings.r2.apiToken;
          }
          
          // Attempt upload
          if (currentSettings.useS3) {
            await uploadToS3(blob, entry.filename, entry.imageInfo, entry.sourceInfo, currentSettings, entry.domain);
          } else {
            await uploadToR2(blob, entry.filename, entry.imageInfo, entry.sourceInfo, currentSettings, entry.domain);
          }
          
          // Increment success count
          successCount++;
        } catch (error) {
          // Increment failure count
          failureCount++;
          
          // Update retry count and save for next attempt if under max retries
          entry.retryCount = (entry.retryCount || 0) + 1;
          entry.lastError = error.message;
          entry.lastAttempt = Date.now();
          
          if (entry.retryCount < CONFIG.retry.maxRetries) {
            stillFailed.push(entry);
          }
        }
      }));
    }
    
    // Update the failed uploads list
    await new Promise((resolve) => {
      chrome.storage.local.set({failedUploads: stillFailed}, resolve);
    });
    
    // Show completion notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Retry Uploads Complete',
      message: `Results: ${successCount} succeeded, ${failureCount} failed. ${stillFailed.length} will be retried later.`,
      priority: 2
    });
    
  } catch (error) {
    console.error('Error retrying uploads:', error);
    
    // Show error notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Retry Error',
      message: `Error retrying uploads: ${error.message}`,
      priority: 2
    });
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
