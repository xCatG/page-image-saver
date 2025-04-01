// content_script.js - This gets injected into web pages

// Global variables for domain-specific settings
let currentDomain = '';
let allImagesCache = [];
let domainSettings = {
  minWidth: 50,
  minHeight: 50
};

// Function to get the current domain
function getCurrentDomain() {
  return window.location.hostname;
}

// Function to save domain settings
function saveDomainSettings(domain, settings) {
  chrome.storage.sync.get('domainSizeFilters', (result) => {
    const domainFilters = result.domainSizeFilters || {};
    domainFilters[domain] = settings;
    chrome.storage.sync.set({ domainSizeFilters: domainFilters }, () => {
      console.log(`Size filter settings saved for domain: ${domain}`);
    });
  });
}

// Function to load domain settings
function loadDomainSettings(domain, callback) {
  chrome.storage.sync.get('domainSizeFilters', (result) => {
    const domainFilters = result.domainSizeFilters || {};
    const settings = domainFilters[domain] || { minWidth: 50, minHeight: 50 };
    callback(settings);
  });
}

// Filter images by size
function filterImagesBySize(images, minWidth, minHeight) {
  return images.filter(img => {
    if (img.type === 'img') {
      // For <img> elements, we can use naturalWidth/Height if available
      const actualWidth = img.naturalWidth || img.width;
      const actualHeight = img.naturalHeight || img.height;
      return actualWidth >= minWidth && actualHeight >= minHeight;
    } else {
      // For background images, we just use the element dimensions
      return img.width >= minWidth && img.height >= minHeight;
    }
  });
}

function findAllImages() {
  // Get all standard image elements
  const imgElements = Array.from(document.querySelectorAll('img'));
  
  // Also look for background images in CSS
  const elementsWithBgImages = Array.from(document.querySelectorAll('*')).filter(el => {
    const style = window.getComputedStyle(el);
    const bgImage = style.backgroundImage;
    return bgImage && bgImage !== 'none' && bgImage.startsWith('url(');
  });
  
  // Extract image URLs from the elements
  const imageUrls = imgElements.map(img => {
    return {
      url: img.src,
      alt: img.alt || 'No description',
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      type: 'img'
    };
  });
  
  // Extract background image URLs
  const bgImageUrls = elementsWithBgImages.map(el => {
    const style = window.getComputedStyle(el);
    const bgImageUrl = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/)[1];
    return {
      url: bgImageUrl,
      alt: 'Background image',
      width: el.offsetWidth,
      height: el.offsetHeight,
      type: 'background',
      element: el.tagName
    };
  });
  
  // Combine both sets of images
  const allImages = [...imageUrls, ...bgImageUrls]
    .filter(img => img.url && img.url.trim() !== '')
    // Filter out data URIs, we want real URLs
    .filter(img => !img.url.startsWith('data:'))
    // Filter out SVG images that are likely icons
    .filter(img => {
      if (img.url.endsWith('.svg') && img.width < 100 && img.height < 100) {
        return false;
      }
      return true;
    });
  
  // Store all valid images before filtering by size
  allImagesCache = allImages;
  
  // Now filter by the current domain settings
  return filterImagesBySize(allImages, domainSettings.minWidth, domainSettings.minHeight);
}

// Function to check image file size before saving
async function checkImagesFileSizes(images) {
  const MIN_FILE_SIZE = 5 * 1024; // 5KB minimum size
  const TIMEOUT_MS = 5000; // 5 second timeout for each request
  const BATCH_SIZE = 10; // Process 10 images at a time to avoid too many concurrent requests
  let validImages = [];
  
  // Function to check a single image with timeout
  async function checkImage(image) {
    try {
      // Create an AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      
      // Fetch headers only with timeout
      const response = await fetch(image.url, { 
        method: 'HEAD', 
        credentials: 'include',
        signal: controller.signal 
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      // If we can get content-length, use it to filter small files
      const contentLength = response.headers.get('Content-Length');
      
      if (contentLength && parseInt(contentLength) < MIN_FILE_SIZE) {
        console.log(`Skipping small image (${contentLength} bytes): ${image.url}`);
        return null; // Skip this image
      } else {
        // Check content type to ensure it's actually an image
        const contentType = response.headers.get('Content-Type');
        if (contentType && contentType.startsWith('image/')) {
          return image; // Keep this image
        } else {
          console.log(`Skipping non-image content type (${contentType}): ${image.url}`);
          return null;
        }
      }
    } catch (error) {
      // If the error is due to timeout, log appropriately
      if (error.name === 'AbortError') {
        console.warn(`Timeout checking image: ${image.url}`);
      } else {
        console.warn(`Error checking image size for ${image.url}:`, error);
      }
      
      // For errors, we'll keep the image and let the background script handle failures
      // This prevents the UI from getting stuck on problematic images
      return image;
    }
  }
  
  // Use image dimensions as a quick local filter first before making network requests
  // This can quickly eliminate tiny images
  const preFilteredImages = images.filter(img => {
    // Make sure the image object is valid
    if (!img) return false;
    
    // For img elements with natural dimensions
    if (img.type && img.type === 'img' && img.naturalWidth && img.naturalHeight) {
      return img.naturalWidth >= 50 && img.naturalHeight >= 50;
    }
    // Otherwise keep it for server-side checking
    return true;
  });
  
  // Process images in batches to limit concurrent requests
  for (let i = 0; i < preFilteredImages.length; i += BATCH_SIZE) {
    const batch = preFilteredImages.slice(i, i + BATCH_SIZE);
    
    // Create a promise for each image in the batch
    const batchPromises = batch.map(image => checkImage(image));
    
    // Wait for the current batch to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Add valid images from this batch
    validImages = validImages.concat(batchResults.filter(image => image !== null));
    
    // Update the status message to show progress
    const processed = Math.min(i + BATCH_SIZE, preFilteredImages.length);
    const statusDiv = document.getElementById('status-message');
    if (statusDiv) {
      statusDiv.innerHTML = `<div class="alert alert-info">Checking images: ${processed}/${preFilteredImages.length} (${validImages.length} valid so far)...</div>`;
    }
  }
  
  return validImages;
}

// UI to show found images
function createImageSelectionUI(images) {
  // Remove any existing UI
  const existingContainer = document.getElementById('image-selector-container');
  if (existingContainer) {
    document.body.removeChild(existingContainer);
  }

  // Create a container for our UI
  const container = document.createElement('div');
  container.id = 'image-selector-container';
  container.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 350px;
    height: 100vh;
    background: white;
    box-shadow: -2px 0 5px rgba(0,0,0,0.2);
    z-index: 999999;
    display: flex;
    flex-direction: column;
    padding: 15px;
    overflow: hidden;
    font-family: Arial, sans-serif;
  `;
  
  // Create header
  const header = document.createElement('div');
  header.innerHTML = `
    <h2 style="margin-top: 0">Images Found (${images.length})</h2>
    <p>Select images to save to your storage</p>
    <div style="display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;">
      <button id="save-selected-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #34A853; color: white; cursor: pointer;">Save Selected</button>
      <button id="select-all-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #4285F4; color: white; cursor: pointer;">Select All</button>
      <button id="deselect-all-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer;">Deselect All</button>
      <button id="take-screenshot-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #EA4335; color: white; cursor: pointer;">Take Screenshot</button>
      <button id="close-btn" style="padding: 8px 12px; border-radius: 4px; border: none; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer;">Close</button>
    </div>
    <div id="size-filter" style="margin-top: 10px; padding: 10px; background: #f5f5f5; border-radius: 4px;">
      <div style="font-weight: bold; margin-bottom: 5px;">Image Size Filter for ${currentDomain}</div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <div>
          <label for="min-width" style="display: block; font-size: 12px; margin-bottom: 2px;">Min Width (px)</label>
          <input type="number" id="min-width" value="${domainSettings.minWidth}" min="0" style="width: 70px; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
        <div>
          <label for="min-height" style="display: block; font-size: 12px; margin-bottom: 2px;">Min Height (px)</label>
          <input type="number" id="min-height" value="${domainSettings.minHeight}" min="0" style="width: 70px; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
        <button id="apply-filter-btn" style="padding: 5px 10px; border-radius: 4px; border: none; background: #4285F4; color: white; cursor: pointer; margin-top: 15px;">Apply</button>
        <button id="save-filter-btn" style="padding: 5px 10px; border-radius: 4px; border: none; background: #34A853; color: white; cursor: pointer; margin-top: 15px;">Save for Domain</button>
      </div>
    </div>
    <div id="status-message" style="margin-top: 10px;"></div>
  `;
  container.appendChild(header);
  
  // Create scrollable image list
  const imageList = document.createElement('div');
  imageList.id = 'image-list';
  imageList.style.cssText = `
    flex: 1;
    overflow-y: auto;
    margin-top: 15px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    align-items: start;
  `;
  
  images.forEach((image, index) => {
    const imgContainer = document.createElement('div');
    imgContainer.style.cssText = `
      border: 1px solid #ddd;
      padding: 10px;
      border-radius: 4px;
      position: relative;
      height: 185px;
      display: flex;
      flex-direction: column;
      cursor: pointer;
    `;
    
    // Add data attribute for tracking
    imgContainer.dataset.index = index;
    
    // Create checkbox for selection
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `img-${index}`;
    checkbox.dataset.index = index;
    checkbox.checked = true;
    checkbox.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      width: 20px;
      height: 20px;
      z-index: 2;
    `;
    
    // Create thumbnail container with fixed height
    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.style.cssText = `
      flex: 1;
      position: relative;
      overflow: hidden;
      margin-bottom: 5px;
      background-color: #f5f5f5;
    `;
    
    // Create thumbnail
    const thumbnail = document.createElement('div');
    thumbnail.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: url(${image.url});
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
    `;
    
    thumbnailContainer.appendChild(thumbnail);
    
    // Add description
    const info = document.createElement('div');
    info.style.cssText = `
      font-size: 12px;
      max-height: 32px;
      word-break: break-all;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      margin-bottom: 2px;
      pointer-events: none;
    `;
    
    // Set description text
    info.textContent = image.alt !== 'No description' ? image.alt : '';
    
    // Add dimensions as a separate line
    const dimensionsInfo = document.createElement('div');
    dimensionsInfo.style.cssText = `
      font-size: 11px;
      color: #666;
      margin-top: 2px;
      pointer-events: none;
    `;
    
    // Add size information
    const dimensions = image.naturalWidth && image.naturalHeight 
      ? `${image.naturalWidth}x${image.naturalHeight}` 
      : `${image.width}x${image.height}`;
      
    dimensionsInfo.textContent = dimensions;
    
    imgContainer.appendChild(checkbox);
    imgContainer.appendChild(thumbnailContainer);
    imgContainer.appendChild(info);
    imgContainer.appendChild(dimensionsInfo);
    imageList.appendChild(imgContainer);
    
    // Add click event to the container - toggle checkbox when clicking anywhere on the item
    imgContainer.addEventListener('click', (event) => {
      // Don't toggle if clicking directly on the checkbox (let the checkbox handle itself)
      if (event.target !== checkbox) {
        // Prevent event bubbling
        event.preventDefault();
        event.stopPropagation();
        
        // Toggle the checkbox
        checkbox.checked = !checkbox.checked;
      }
    });
  });
  
  container.appendChild(imageList);
  document.body.appendChild(container);
  
  // Add event listeners
  document.getElementById('select-all-btn').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#image-selector-container input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
  });
  
  document.getElementById('deselect-all-btn').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#image-selector-container input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
  });
  
  document.getElementById('save-selected-btn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('save-selected-btn');
    const selectedImages = [];
    const checkboxes = document.querySelectorAll('#image-selector-container input[type="checkbox"]:checked');
    
    checkboxes.forEach(cb => {
      try {
        const index = parseInt(cb.dataset.index);
        if (!isNaN(index) && index >= 0 && index < images.length) {
          const image = images[index];
          if (image && image.url) {
            selectedImages.push(image);
          }
        }
      } catch (error) {
        console.error("Error processing selected image:", error);
      }
    });
    
    if (selectedImages.length > 0) {
      // Show saving indicator
      showStatusMessage(`Checking ${selectedImages.length} image${selectedImages.length > 1 ? 's' : ''}...`, 'info');
      
      // Disable save button to prevent multiple clicks
      saveBtn.disabled = true;
      saveBtn.textContent = 'Checking...';
      saveBtn.style.backgroundColor = '#cccccc';
      
      try {
        // Check file sizes before saving
        const validImages = await checkImagesFileSizes(selectedImages);
        
        if (!validImages || validImages.length === 0) {
          showStatusMessage('No valid images found to save (images may be too small).', 'error');
          
          // Re-enable the button
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Selected';
          saveBtn.style.backgroundColor = '#34A853';
          return;
        }
        
        // Update message with valid image count
        showStatusMessage(`Saving ${validImages.length} image${validImages.length > 1 ? 's' : ''}...`, 'info');
        saveBtn.textContent = 'Saving...';
        
        saveImagesToStorage(validImages);
      } catch (error) {
        console.error("Error during image checking:", error);
        showStatusMessage(`Error checking images: ${error.message}`, 'error');
        
        // Re-enable the button
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Selected';
        saveBtn.style.backgroundColor = '#34A853';
      }
    } else {
      showStatusMessage('Please select at least one image to save.', 'error');
    }
  });
  
  document.getElementById('take-screenshot-btn').addEventListener('click', () => {
    // Close the current UI
    document.body.removeChild(container);
    // Initialize screenshot flow
    window.PageScreenshot.initiateScreenshot();
  });
  
  document.getElementById('close-btn').addEventListener('click', () => {
    document.body.removeChild(container);
  });
  
  // Add event listeners for the size filter
  document.getElementById('apply-filter-btn').addEventListener('click', () => {
    applyImageSizeFilter();
  });
  
  document.getElementById('save-filter-btn').addEventListener('click', () => {
    saveImageSizeFilter();
  });
}

// Apply size filter to images
function applyImageSizeFilter() {
  // Get filter values
  const minWidth = parseInt(document.getElementById('min-width').value) || 0;
  const minHeight = parseInt(document.getElementById('min-height').value) || 0;
  
  // Update domain settings (but don't save to storage yet)
  domainSettings.minWidth = minWidth;
  domainSettings.minHeight = minHeight;
  
  // Filter images with new values
  const filteredImages = filterImagesBySize(allImagesCache, minWidth, minHeight);
  
  // Update the UI to show filtered images
  updateImageList(filteredImages);
  
  // Show status message
  showStatusMessage(`Filter applied: ${filteredImages.length} images match the criteria.`, 'info');
}

// Save size filter for domain
function saveImageSizeFilter() {
  // Get filter values
  const minWidth = parseInt(document.getElementById('min-width').value) || 0;
  const minHeight = parseInt(document.getElementById('min-height').value) || 0;
  
  // Update domain settings
  domainSettings.minWidth = minWidth;
  domainSettings.minHeight = minHeight;
  
  // Save to storage
  saveDomainSettings(currentDomain, domainSettings);
  
  // Show status message
  showStatusMessage(`Size filter saved for ${currentDomain}`, 'success');
}

// Update image list with filtered images
function updateImageList(filteredImages) {
  // Update title count
  const titleElement = document.querySelector('#image-selector-container h2');
  if (titleElement) {
    titleElement.textContent = `Images Found (${filteredImages.length})`;
  }
  
  // Clear existing image list
  const imageList = document.getElementById('image-list');
  if (!imageList) return;
  
  imageList.innerHTML = '';
  
  // Populate with new filtered images
  filteredImages.forEach((image, index) => {
    const imgContainer = document.createElement('div');
    imgContainer.style.cssText = `
      border: 1px solid #ddd;
      padding: 10px;
      border-radius: 4px;
      position: relative;
      height: 185px;
      display: flex;
      flex-direction: column;
      cursor: pointer;
    `;
    
    // Add data attribute for tracking
    imgContainer.dataset.index = index;
    
    // Create checkbox for selection
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `img-${index}`;
    checkbox.dataset.index = index;
    checkbox.checked = true;
    checkbox.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      width: 20px;
      height: 20px;
      z-index: 2;
    `;
    
    // Create thumbnail container with fixed height
    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.style.cssText = `
      flex: 1;
      position: relative;
      overflow: hidden;
      margin-bottom: 5px;
      background-color: #f5f5f5;
    `;
    
    // Create thumbnail
    const thumbnail = document.createElement('div');
    thumbnail.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: url(${image.url});
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
    `;
    
    thumbnailContainer.appendChild(thumbnail);
    
    // Add description
    const info = document.createElement('div');
    info.style.cssText = `
      font-size: 12px;
      max-height: 32px;
      word-break: break-all;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      margin-bottom: 2px;
      pointer-events: none;
    `;
    
    // Set description text
    info.textContent = image.alt !== 'No description' ? image.alt : '';
    
    // Add dimensions as a separate line
    const dimensionsInfo = document.createElement('div');
    dimensionsInfo.style.cssText = `
      font-size: 11px;
      color: #666;
      margin-top: 2px;
      pointer-events: none;
    `;
    
    // Add size information
    const dimensions = image.naturalWidth && image.naturalHeight 
      ? `${image.naturalWidth}x${image.naturalHeight}` 
      : `${image.width}x${image.height}`;
      
    dimensionsInfo.textContent = dimensions;
    
    imgContainer.appendChild(checkbox);
    imgContainer.appendChild(thumbnailContainer);
    imgContainer.appendChild(info);
    imgContainer.appendChild(dimensionsInfo);
    imageList.appendChild(imgContainer);
    
    // Add click event to the container - toggle checkbox when clicking anywhere on the item
    imgContainer.addEventListener('click', (event) => {
      // Don't toggle if clicking directly on the checkbox (let the checkbox handle itself)
      if (event.target !== checkbox) {
        // Prevent event bubbling
        event.preventDefault();
        event.stopPropagation();
        
        // Toggle the checkbox
        checkbox.checked = !checkbox.checked;
      }
    });
  });
}

// Function to show status message
function showStatusMessage(message, type = 'info') {
  const statusDiv = document.getElementById('status-message');
  if (!statusDiv) return;

  // Set background color based on message type
  let bgColor = '#e2f3eb'; // Success - light green
  let textColor = '#0f5132';
  
  if (type === 'error') {
    bgColor = '#f8d7da'; // Error - light red
    textColor = '#721c24';
  } else if (type === 'info') {
    bgColor = '#cff4fc'; // Info - light blue
    textColor = '#055160';
  } else if (type === 'warning') {
    bgColor = '#fff3cd'; // Warning - light yellow
    textColor = '#856404';
  }

  statusDiv.style.cssText = `
    padding: 10px;
    border-radius: 4px;
    margin-top: 10px;
    background-color: ${bgColor};
    color: ${textColor};
    text-align: center;
  `;
  statusDiv.innerHTML = message;

  // Clear success/info messages after 5 seconds
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      if (statusDiv && statusDiv.parentNode) {
        statusDiv.innerHTML = '';
        statusDiv.style.padding = '0';
      }
    }, 5000);
  }
}

// Function to create a progress indicator overlay
function createProgressIndicator(count) {
  // Remove any existing indicators
  removeProgressIndicator();
  
  // Create the progress container
  const progressContainer = document.createElement('div');
  progressContainer.id = 'save-progress-indicator';
  progressContainer.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 999999;
    font-family: Arial, sans-serif;
    display: flex;
    align-items: center;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    transition: opacity 0.3s ease-in-out;
  `;
  
  // Add a spinner
  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-radius: 50%;
    border-top-color: white;
    animation: spin 1s linear infinite;
    margin-right: 15px;
  `;
  
  // Add a keyframe animation for the spinner
  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleSheet);
  
  // Create message
  const message = document.createElement('div');
  message.textContent = `Saving ${count} image${count > 1 ? 's' : ''} to your storage...`;
  
  // Add elements to container
  progressContainer.appendChild(spinner);
  progressContainer.appendChild(message);
  
  // Add to body
  document.body.appendChild(progressContainer);
  
  return progressContainer;
}

// Function to update progress indicator
function updateProgressIndicator(completed, total) {
  const indicator = document.getElementById('save-progress-indicator');
  if (!indicator) return;
  
  const messageEl = indicator.lastChild;
  if (messageEl) {
    messageEl.textContent = `Saved ${completed} of ${total} image${total > 1 ? 's' : ''}...`;
  }
}

// Function to show completion notification
function showCompletionNotification(count, success = true) {
  // Remove progress indicator
  removeProgressIndicator();
  
  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'save-completion-notification';
  
  // Set styles based on success or failure
  const bgColor = success ? '#34A853' : '#EA4335';
  const icon = success 
    ? '✓' 
    : '✗';
  
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: ${bgColor};
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 999999;
    font-family: Arial, sans-serif;
    display: flex;
    align-items: center;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
  `;
  
  // Add icon
  const iconEl = document.createElement('div');
  iconEl.style.cssText = `
    font-size: 20px;
    margin-right: 15px;
    font-weight: bold;
  `;
  iconEl.textContent = icon;
  
  // Add message
  const message = document.createElement('div');
  if (success) {
    message.textContent = `Successfully saved ${count} image${count > 1 ? 's' : ''} to your storage`;
  } else {
    message.textContent = `Failed to save images. Please check your settings.`;
  }
  
  // Add elements to container
  notification.appendChild(iconEl);
  notification.appendChild(message);
  
  // Add to body
  document.body.appendChild(notification);
  
  // Show with animation
  setTimeout(() => {
    notification.style.opacity = '1';
  }, 10);
  
  // Remove after a few seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (notification.parentNode) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 5000);
}

// Function to remove progress indicator
function removeProgressIndicator() {
  const indicator = document.getElementById('save-progress-indicator');
  if (indicator && indicator.parentNode) {
    document.body.removeChild(indicator);
  }
}

// Function to save images to your storage (S3/R2)
function saveImagesToStorage(images) {
  // Show progress indicator
  const progressIndicator = createProgressIndicator(images.length);
  
  // This would send the selected images to your background script
  chrome.runtime.sendMessage({
    action: 'saveImages',
    images: images,
    sourceUrl: window.location.href,
    pageTitle: document.title
  }, response => {
    // Remove the UI
    const container = document.getElementById('image-selector-container');
    if (container) {
      document.body.removeChild(container);
    }
    
    if (response && response.success) {
      // Show success notification
      showCompletionNotification(response.count, true);
      console.log(`Successfully saved ${response.count} images.`);
    } else {
      // Show error notification
      showCompletionNotification(0, false);
      console.error(`Error: ${response?.error || 'Unknown error occurred'}`);
    }
  });
  
  // Listen for progress updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'uploadProgress') {
      updateProgressIndicator(message.completed, message.total);
      sendResponse({received: true});
    }
    return true;
  });
}

// Initialize when the user clicks the extension icon or uses keyboard shortcut
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'findImages') {
    // Get current domain and load saved settings for it
    currentDomain = getCurrentDomain();
    
    loadDomainSettings(currentDomain, (settings) => {
      // Update domain settings
      domainSettings = settings;
      
      // Find all images with the loaded filter settings
      const images = findAllImages();
      createImageSelectionUI(images);
      sendResponse({success: true, count: images.length});
    });
    
    return true; // Keep the message channel open for async response
  } else if (message.action === 'takeScreenshot') {
    // Initialize screenshot flow
    window.PageScreenshot.initiateScreenshot();
    sendResponse({success: true});
  }
  return true; // Keep the message channel open for async responses
});

// Load the screenshot functionality
function loadScreenshotModule() {
  // Check if it's already loaded
  if (window.PageScreenshot) {
    return;
  }
  
  // Create script element to load screenshot.js
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('screenshot.js');
  script.onload = function() {
    console.log('Screenshot module loaded successfully');
  };
  script.onerror = function(error) {
    console.error('Error loading screenshot module:', error);
  };
  
  // Add to document head
  (document.head || document.documentElement).appendChild(script);
}

// Load screenshot module
loadScreenshotModule();

// Log that the content script has loaded
console.log('Page Image Saver content script loaded.');
