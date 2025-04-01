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
    
    // Capture visible part of the page
    captureVisiblePart: function() {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'captureVisibleTab'
        }, response => {
          if (response && response.dataUrl) {
            resolve(response.dataUrl);
          } else {
            reject(new Error('Failed to capture screenshot'));
          }
        });
      });
    },
    
    // Process the screenshot
    processScreenshot: function(dataUrl) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pageTitle = document.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
      const filename = `screenshot_${pageTitle}_${timestamp}.png`;
      
      // Create metadata
      const metadata = {
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        captureType: 'visible_area'
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
    initiateScreenshot: function() {
      // Store current scroll position
      this.originalScrollPos = window.scrollY;
      
      // Take visible screenshot
      this.captureVisiblePart()
        .then(dataUrl => {
          this.processScreenshot(dataUrl);
        })
        .catch(error => {
          console.error('Screenshot error:', error);
          this.showCompletionNotification(false, null, error.message);
        });
    },
    
    // Show a saving notification
    showSavingNotification: function() {
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
      message.textContent = 'Saving screenshot...';
      
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
