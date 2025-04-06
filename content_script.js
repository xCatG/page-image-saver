// content_script.js - This gets injected into web pages

// Add a global flag that the background script can check to see if we're loaded
window.PageImageSaverLoaded = true;

// Global variables for domain-specific settings
let currentDomain = '';
let allImagesCache = [];
let currentFilteredImages = []; // Add this line to track current filtered images
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
  console.log(`Filtering images: ${images.length} images, min dimensions ${minWidth}x${minHeight}`);
  
  const filtered = images.filter(img => {
    if (img.type === 'img') {
      // For <img> elements, we can use naturalWidth/Height if available
      const actualWidth = img.naturalWidth || img.width;
      const actualHeight = img.naturalHeight || img.height;
      const passes = actualWidth >= minWidth && actualHeight >= minHeight;
      console.log(`Image (${img.url.substring(0, 30)}...): ${actualWidth}x${actualHeight}, passes: ${passes}`);
      return passes;
    } else {
      // For background images, we just use the element dimensions
      const passes = img.width >= minWidth && img.height >= minHeight;
      console.log(`Background (${img.url.substring(0, 30)}...): ${img.width}x${img.height}, passes: ${passes}`);
      return passes;
    }
  });
  
  console.log(`Filtering results: ${filtered.length} of ${images.length} images passed the filter`);
  return filtered;
}

function findAllImages() {
  console.log('findAllImages() called');
  
  // Clear the cache if it exists, to avoid stale data
  allImagesCache = [];
  
  // Get all standard image elements
  const imgElements = Array.from(document.querySelectorAll('img'));
  console.log(`Found ${imgElements.length} img elements`);
  
  // Also look for background images in CSS
  const elementsWithBgImages = Array.from(document.querySelectorAll('*')).filter(el => {
    const style = window.getComputedStyle(el);
    const bgImage = style.backgroundImage;
    return bgImage && bgImage !== 'none' && bgImage.startsWith('url(');
  });
  
  // Extract image URLs from the elements with enhanced metadata
  const imageUrls = imgElements.map(img => {
    let altText = img.alt || '';
    
    // If no alt text is available, try to find it in parent or sibling elements
    if (!altText) {
      // Check for figure caption
      const figure = img.closest('figure');
      if (figure) {
        const figcaption = figure.querySelector('figcaption');
        if (figcaption) {
          altText = figcaption.textContent.trim();
        }
      }
      
      // Check for nearby captions or descriptive text
      if (!altText) {
        // Try nearby div with class containing 'caption'
        const parent = img.parentElement;
        if (parent) {
          const caption = parent.querySelector('div[class*="caption"], .caption, [class*="Caption"], [id*="caption"]');
          if (caption) {
            altText = caption.textContent.trim();
          }
        }
      }
    }
    
    // If still no alt text, look for title attribute
    if (!altText) {
      altText = img.title || 'No description';
    }
    
    // Get image filename from src
    let filename = '';
    try {
      const urlObj = new URL(img.src);
      const pathname = urlObj.pathname;
      filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      // Remove query parameters
      filename = filename.split('?')[0];
    } catch (e) {
      // If URL parsing fails, just use the last part of the src
      const parts = img.src.split('/');
      filename = parts[parts.length - 1].split('?')[0];
    }
    
    // Collect any data attributes that might contain useful metadata
    const dataAttributes = {};
    for (const attr of img.attributes) {
      if (attr.name.startsWith('data-')) {
        dataAttributes[attr.name] = attr.value;
      }
    }
    
    return {
      url: img.src,
      alt: altText,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      type: 'img',
      filename: filename,
      title: img.title || '',
      loading: img.loading || '',
      dataAttributes: dataAttributes
    };
  });
  
  // Extract background image URLs with enhanced metadata
  const bgImageUrls = elementsWithBgImages.map(el => {
    const style = window.getComputedStyle(el);
    const bgImageUrl = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/)[1];
    
    // Get image filename from url
    let filename = '';
    try {
      const urlObj = new URL(bgImageUrl);
      const pathname = urlObj.pathname;
      filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      // Remove query parameters
      filename = filename.split('?')[0];
    } catch (e) {
      // If URL parsing fails, just use the last part of the url
      const parts = bgImageUrl.split('/');
      filename = parts[parts.length - 1].split('?')[0];
    }
    
    // Try to determine alt text from surrounding context
    let altText = el.getAttribute('aria-label') || el.title || '';
    
    // If no alt text, try to get text content if it's a short description
    if (!altText && el.textContent && el.textContent.trim().length < 100) {
      altText = el.textContent.trim();
    }
    
    // Look for nearby headings or text that might describe the image
    if (!altText) {
      const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        altText = heading.textContent.trim();
      }
    }
    
    // If still no alt text, fall back to a more descriptive default
    if (!altText) {
      altText = `Background image for ${el.tagName.toLowerCase()} element`;
    }
    
    // Collect any data attributes that might contain useful metadata
    const dataAttributes = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-')) {
        dataAttributes[attr.name] = attr.value;
      }
    }
    
    // Collect more style information for better context
    const bgSize = style.backgroundSize;
    const bgPosition = style.backgroundPosition;
    const bgRepeat = style.backgroundRepeat;
    
    return {
      url: bgImageUrl,
      alt: altText,
      width: el.offsetWidth,
      height: el.offsetHeight,
      type: 'background',
      element: el.tagName,
      filename: filename,
      className: el.className || '',
      id: el.id || '',
      bgSize: bgSize,
      bgPosition: bgPosition,
      bgRepeat: bgRepeat,
      dataAttributes: dataAttributes
    };
  });
  
  // Combine both sets of images
  let allImages = [...imageUrls, ...bgImageUrls]
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
  
  // Remove duplicate images by URL
  const uniqueUrls = new Set();
  allImages = allImages.filter(img => {
    if (uniqueUrls.has(img.url)) {
      return false;
    }
    uniqueUrls.add(img.url);
    return true;
  });
  
  console.log(`Found ${allImages.length} unique images after removing duplicates`);
  
  console.log('Found images before filtering:', allImages.length);
  
  // Store all valid images before filtering by size
  allImagesCache = [...allImages]; // Create a clone of the array
  
  console.log('Cache size:', allImagesCache.length);
  
  // Now filter by the current domain settings
  const filteredImages = filterImagesBySize(allImages, domainSettings.minWidth, domainSettings.minHeight);
  
  console.log('Found images after filtering:', filteredImages.length);
  
  // Set the current filtered images
  currentFilteredImages = filteredImages;
  
  return filteredImages;
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
      // First, try a more reliable method to check if the image is valid
      // by using the Image constructor which works with cross-origin images
      const prevalidateImage = () => {
        return new Promise((resolve) => {
          // Create temporary image element to verify the URL is a valid image
          const img = new Image();
          
          // Set a timeout in case the image doesn't load
          const imgTimeout = setTimeout(() => {
            console.log(`Image prevalidation timed out: ${image.url}`);
            resolve(true); // Continue anyway, let the server handle it
          }, 2000);
          
          // Image loaded successfully
          img.onload = () => {
            clearTimeout(imgTimeout);
            resolve(true);
          };
          
          // Image failed to load
          img.onerror = () => {
            clearTimeout(imgTimeout);
            console.log(`Image prevalidation failed: ${image.url}`);
            // We'll still proceed to try the fetch, but log it
            resolve(true);
          };
          
          // Set crossOrigin to anonymous to avoid tainting the canvas
          img.crossOrigin = "anonymous";
          img.src = image.url;
        });
      };
      
      // Always prevalidate, but don't fail if it doesn't work
      await prevalidateImage();
      
      try {
        // Create an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        
        // Try a fetch with 'no-cors' mode first to handle cross-origin requests
        try {
          const response = await fetch(image.url, { 
            method: 'HEAD', 
            credentials: 'include',
            mode: 'no-cors', // Use no-cors mode to avoid CORS issues
            signal: controller.signal 
          });
          
          // Clear the timeout
          clearTimeout(timeoutId);
          
          // If using no-cors mode, we can't actually read the headers
          // But if we got here without an error, the image is probably valid
          return image;
        } catch (corsError) {
          // If no-cors mode failed, try a normal request
          console.log(`No-cors request failed for ${image.url}, trying regular request`);
          
          // Create a new AbortController for the second attempt
          const controller2 = new AbortController();
          const timeoutId2 = setTimeout(() => controller2.abort(), TIMEOUT_MS);
          
          const response = await fetch(image.url, { 
            method: 'HEAD', 
            credentials: 'include',
            signal: controller2.signal 
          });
          
          // Clear the timeout
          clearTimeout(timeoutId2);
          
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
        }
      } catch (fetchError) {
        // If both fetch attempts failed, but the image loaded in the browser,
        // let's trust that it's valid and include it
        console.log(`All fetch attempts failed for ${image.url}, but proceeding anyway`);
        return image;
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
  console.log('Creating UI for', images.length, 'images');
  
  // Initialize currentFilteredImages with the images being displayed
  currentFilteredImages = images;
  
  // Make sure allImagesCache is properly set if it's empty
  if (allImagesCache.length === 0) {
    console.log('allImagesCache was empty, initializing from current images');
    allImagesCache = [...images];
  }
  
  // Remove any existing UI to prevent duplicates
  const existingContainer = document.getElementById('image-selector-container');
  if (existingContainer) {
    console.log('Removing existing UI before creating a new one');
    document.body.removeChild(existingContainer);
    // Return early if there's already a UI open and we're clicking the button again with the same images
    // This prevents duplicate image display when clicking the button multiple times
    if (currentFilteredImages === images && existingContainer.getAttribute('data-images-count') === images.length.toString()) {
      console.log('UI was already open with the same images, not re-creating');
      return;
    }
  }

  // Create a container for our UI
  const container = document.createElement('div');
  container.id = 'image-selector-container';
  // Add a data attribute to track how many images are being displayed
  container.setAttribute('data-images-count', images.length.toString());
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
  
  //

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

// Add each image item to the list
images.forEach((image, index) => {
  const imgContainer = _createImageItemElement(image, index);
  imageList.appendChild(imgContainer);
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
        // Use currentFilteredImages instead of images
        if (!isNaN(index) && index >= 0 && index < currentFilteredImages.length) {
          const image = currentFilteredImages[index];
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
  
  console.log('Applying size filter:', { minWidth, minHeight });
  console.log('All images cache:', allImagesCache.length, 'images');
  
  // Ensure we have images to filter
  if (allImagesCache.length === 0) {
    console.error('Error: No images in cache to filter');
    showStatusMessage('Error: No images available to filter', 'error');
    return;
  }
  
  // Update domain settings (but don't save to storage yet)
  domainSettings.minWidth = minWidth;
  domainSettings.minHeight = minHeight;
  
  // Create a shallow copy of the array to avoid modifying the original
  const imagesToFilter = [...allImagesCache];
  console.log(`Filtering ${imagesToFilter.length} images with min dimensions ${minWidth}x${minHeight}`);
  
  // Filter images with new values
  const filteredImages = filterImagesBySize(imagesToFilter, minWidth, minHeight);
  
  console.log('Filtered images:', filteredImages.length, 'images remaining');
  
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

// Helper function to create an image item element
function _createImageItemElement(image, index) {
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
  
  // Create thumbnail using IMG element instead of background-image to handle CORS better
  const thumbnail = document.createElement('div');
  thumbnail.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  `;
  
  // Create actual image element
  const imgEl = document.createElement('img');
  imgEl.src = image.url;
  imgEl.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  `;
  
  // Set crossOrigin to anonymous to prevent CORS issues
  imgEl.crossOrigin = "anonymous";
  
  // Add error handling to show placeholder if image fails to load
  imgEl.onerror = () => {
    // Create a colored placeholder with text if image fails to load
    imgEl.style.display = "none";
    thumbnail.style.backgroundColor = "#f5f5f5";
    thumbnail.style.color = "#666";
    thumbnail.style.display = "flex";
    thumbnail.style.alignItems = "center";
    thumbnail.style.justifyContent = "center";
    thumbnail.style.padding = "5px";
    thumbnail.style.textAlign = "center";
    thumbnail.style.fontSize = "10px";
    thumbnail.textContent = "Image Preview Unavailable";
  };
  
  // Append the image to the thumbnail container
  thumbnail.appendChild(imgEl);
  
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
  
  // Set description text - only show alt text if it's meaningful
  const hasAltText = image.alt && image.alt !== 'No description';
  info.textContent = hasAltText ? image.alt : '';
  
  // Add dimensions as a separate line
  const dimensionsInfo = document.createElement('div');
  dimensionsInfo.style.cssText = `
    font-size: 11px;
    color: #666;
    margin-top: 2px;
    pointer-events: none;
  `;
  
  // Format image dimensions
  const dimensions = image.naturalWidth && image.naturalHeight 
    ? `${image.naturalWidth}x${image.naturalHeight}` 
    : `${image.width}x${image.height}`;
  
  // Always show dimensions
  let displayText = dimensions;
  
  // If alt text is missing, add filename before dimensions
  if (!hasAltText && image.filename) {
    const shortName = `${image.filename.substring(0, 15)}${image.filename.length > 15 ? '...' : ''}`;
    displayText = `${shortName} | ${dimensions}`;
  }
  
  dimensionsInfo.textContent = displayText;
  
  // Add a tooltip with complete metadata
  let tooltipContent = `Dimensions: ${dimensions}\n`;
  
  if (image.filename) {
    tooltipContent += `Filename: ${image.filename}\n`;
  }
  
  if (image.alt && image.alt !== 'No description') {
    tooltipContent += `Alt text: ${image.alt}\n`;
  }
  
  if (image.type === 'background') {
    tooltipContent += `Element: ${image.element}\n`;
    if (image.className) tooltipContent += `Class: ${image.className}\n`;
    if (image.bgSize) tooltipContent += `Background size: ${image.bgSize}\n`;
  }
  
  dimensionsInfo.title = tooltipContent;
  
  imgContainer.appendChild(checkbox);
  imgContainer.appendChild(thumbnailContainer);
  imgContainer.appendChild(info);
  imgContainer.appendChild(dimensionsInfo);
  
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
  
  return imgContainer;
}

// Update image list with filtered images
function updateImageList(filteredImages) {
  console.log('updateImageList called with', filteredImages.length, 'images');
  
  // Store the filtered images in our global variable
  currentFilteredImages = filteredImages;
  
  // Update title count
  const titleElement = document.querySelector('#image-selector-container h2');
  if (titleElement) {
    titleElement.textContent = `Images Found (${filteredImages.length})`;
    console.log('Updated title count to', filteredImages.length);
  } else {
    console.warn('Title element not found');
  }
  
  // Clear existing image list
  const imageList = document.getElementById('image-list');
  if (!imageList) {
    console.error('Image list element not found');
    return;
  }
  
  imageList.innerHTML = '';
  
  // Populate with new filtered images using the helper function
  filteredImages.forEach((image, index) => {
    const imgContainer = _createImageItemElement(image, index);
    imageList.appendChild(imgContainer);
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
    // Check if UI is already open, and just return success if it is
    const existingContainer = document.getElementById('image-selector-container');
    if (existingContainer) {
      console.log('UI already open, not recreating');
      sendResponse({success: true, count: parseInt(existingContainer.getAttribute('data-images-count') || '0')});
      return true;
    }
    
    // Get current domain and load saved settings for it
    currentDomain = getCurrentDomain();
    console.log('Finding images for domain:', currentDomain);
    
    loadDomainSettings(currentDomain, (settings) => {
      // Update domain settings
      domainSettings = settings;
      console.log('Domain settings loaded:', domainSettings);
      
      // Find all images with the loaded filter settings
      const images = findAllImages();
      console.log(`Found ${images.length} images, creating UI`);
      
      // Create the UI with the images
      createImageSelectionUI(images);
      
      // Send response with the count
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

// Add an event listener to notify when the DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('Page Image Saver: DOM fully loaded and parsed');
  });
} else {
  console.log('Page Image Saver: DOM already loaded when script ran');
}
