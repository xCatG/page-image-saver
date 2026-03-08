/**
 * Screenshot Module for Page Image Saver Extension
 * Adds the ability to capture and save screenshots
 */
(function() {
  'use strict';
  
  // Create screenshot namespace to avoid conflicts
  window.PageScreenshot = {
    // Store current scroll position
    originalScrollPos: 0,
    
    // Capture visible part of the page using Chrome API, with retry on quota error
    captureVisiblePart: function() {
      const attempt = (retriesLeft) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, response => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (retriesLeft > 0 && err.message && err.message.includes('quota')) {
              setTimeout(() => attempt(retriesLeft - 1).then(resolve, reject), 600);
            } else {
              reject(new Error(err.message || 'captureVisibleTab failed'));
            }
            return;
          }
          if (response && response.dataUrl) {
            resolve(response.dataUrl);
          } else {
            reject(new Error(response?.error || 'Failed to capture screenshot'));
          }
        });
      });
      return attempt(3);
    },

    // Capture the full page using scroll-and-stitch
    captureFullPage: async function() {
      const container = document.getElementById('image-selector-container');
      if (container) container.style.display = 'none';

      const dpr = window.devicePixelRatio || 1;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const totalW = document.documentElement.scrollWidth;
      const totalH = document.documentElement.scrollHeight;
      const origScrollX = window.scrollX;
      const origScrollY = window.scrollY;

      // Hide fixed/sticky elements so they don't repeat in every strip.
      // Also watch for late-appearing ones (cookie banners, chat widgets, etc.)
      const hiddenEls = new Set();

      const hideFixedEl = (el) => {
        if (hiddenEls.has(el)) return;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          el.dataset._screenshotHidden = el.style.visibility;
          el.style.visibility = 'hidden';
          hiddenEls.add(el);
        }
      };

      document.querySelectorAll('*').forEach(hideFixedEl);

      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            hideFixedEl(node);
            node.querySelectorAll('*').forEach(hideFixedEl);
          }
          if (m.type === 'attributes' && m.target.nodeType === 1) {
            hideFixedEl(m.target);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(totalW * dpr);
      canvas.height = Math.round(totalH * dpr);
      const ctx = canvas.getContext('2d');

      const loadImage = (dataUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });

      try {
        let y = 0;
        while (true) {
          // Clamp scroll so last partial strip aligns to bottom of page
          const scrollY = Math.min(y, Math.max(0, totalH - viewH));
          window.scrollTo(0, scrollY);
          // Wait for scroll + lazy-load/repaint to settle.
          // 500ms also keeps us safely under captureVisibleTab's 2/sec quota.
          await new Promise(r => setTimeout(r, 500));

          const dataUrl = await this.captureVisiblePart();
          const img = await loadImage(dataUrl);
          // Draw at actual scroll position (overlap on last strip is fine — same pixels)
          ctx.drawImage(img, 0, Math.round(scrollY * dpr));

          if (y + viewH >= totalH) break;
          y += viewH;
        }
      } finally {
        observer.disconnect();
        hiddenEls.forEach(el => {
          el.style.visibility = el.dataset._screenshotHidden;
          delete el.dataset._screenshotHidden;
        });
        window.scrollTo(origScrollX, origScrollY);
        if (container) container.style.display = '';
      }

      // Use JPEG (much smaller than PNG for photo-heavy pages).
      // If still approaching the 64MiB sendMessage limit, scale down.
      let dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 48 * 1024 * 1024) {
        const scale = Math.sqrt((48 * 1024 * 1024) / dataUrl.length);
        const scaled = document.createElement('canvas');
        scaled.width = Math.round(canvas.width * scale);
        scaled.height = Math.round(canvas.height * scale);
        scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
        dataUrl = scaled.toDataURL('image/jpeg', 0.85);
      }
      return dataUrl;
    },
    
    // Process the screenshot
    processScreenshot: function(dataUrl, captureType = 'visible_area') {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pageTitle = document.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
      const ext = captureType === 'full_page' ? 'jpg' : 'png';
      const filename = `screenshot_${pageTitle}_${timestamp}.${ext}`;
      
      // Create metadata
      const metadata = {
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        captureType: captureType
      };
      
      // Show saving notification
      this.showSavingNotification();
      
      // Send to background script for processing
      chrome.runtime.sendMessage({
        action: 'processScreenshot',
        screenshot: dataUrl,
        filename: filename,
        metadata: metadata
      }, response => {
        if (response && response.success) {
          // Show success notification
          this.showCompletionNotification(true, response.url);
        } else {
          // Show error notification
          this.showCompletionNotification(false, null, response?.error);
        }
      });
    },
    
    // Handle the screenshot process
    initiateScreenshot: function(fullPage = true) {
      // Store current scroll position
      this.originalScrollPos = window.scrollY;
      
      if (fullPage) {
        this.showSavingNotification('Capturing full page...');
        
        this.captureFullPage()
          .then(dataUrl => {
            // Remove the early notification so processScreenshot can show its own
            const notification = document.getElementById('screenshot-saving-notification');
            if (notification) {
              document.body.removeChild(notification);
            }
            this.processScreenshot(dataUrl, 'full_page');
          })
          .catch(error => {
            console.error('Screenshot error:', error);
            this.showCompletionNotification(false, null, error.message);
          });
      } else {
        // Take visible screenshot
        this.captureVisiblePart()
          .then(dataUrl => {
            this.processScreenshot(dataUrl, 'visible_area');
          })
          .catch(error => {
            console.error('Screenshot error:', error);
            this.showCompletionNotification(false, null, error.message);
          });
      }
    },
    
    // Show a saving notification
    showSavingNotification: function(customMessage = 'Saving screenshot...') {
      // Remove any existing notification first
      const existingNotification = document.getElementById('screenshot-saving-notification');
      if (existingNotification) {
        document.body.removeChild(existingNotification);
      }

      // Create notification element
      const notification = document.createElement('div');
      notification.id = 'screenshot-saving-notification';
      
      notification.style.cssText = `
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
      
      // Add a keyframe animation for the spinner if it doesn't exist yet
      if (!document.querySelector('style[data-spinner-animation]')) {
        const styleSheet = document.createElement('style');
        styleSheet.setAttribute('data-spinner-animation', 'true');
        styleSheet.textContent = `
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(styleSheet);
      }
      
      // Create message
      const message = document.createElement('div');
      message.textContent = customMessage;
      
      // Add elements to container
      notification.appendChild(spinner);
      notification.appendChild(message);
      
      // Add to body
      document.body.appendChild(notification);
    },
    
    // Show completion notification
    showCompletionNotification: function(success, url, errorMessage) {
      // Remove saving notification if it exists
      const savingNotification = document.getElementById('screenshot-saving-notification');
      if (savingNotification) {
        document.body.removeChild(savingNotification);
      }
      
      // Create notification element
      const notification = document.createElement('div');
      notification.id = 'screenshot-completion-notification';
      
      // Set styles based on success or failure
      const bgColor = success ? '#34A853' : '#EA4335';
      const icon = success ? '✓' : '✗';
      
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
        message.textContent = `Screenshot saved successfully!`;
      } else {
        message.textContent = errorMessage || 'Failed to save screenshot';
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
  };
  
  console.log('Screenshot module loaded and ready');
})();
