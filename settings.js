// settings.js - Handles the settings page functionality

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const storageTypeSelect = document.getElementById('storage-type');
  const s3Config = document.getElementById('s3-config');
  const r2Config = document.getElementById('r2-config');
  const r2AuthMethodRadios = document.getElementsByName('r2AuthMethod');
  const r2ApiKeysFields = document.getElementById('r2-api-keys-fields');
  const r2TokenField = document.getElementById('r2-token-field');
  const settingsForm = document.getElementById('settings-form');
  const testConnectionBtn = document.getElementById('test-connection');
  const statusMessageDiv = document.getElementById('status-message');
  
  // Domain filter elements
  const newDomainInput = document.getElementById('new-domain');
  const newMinWidthInput = document.getElementById('new-min-width');
  const newMinHeightInput = document.getElementById('new-min-height');
  const addDomainFilterBtn = document.getElementById('add-domain-filter');
  const clearDomainFiltersBtn = document.getElementById('clear-domain-filters');
  const domainFiltersTableBody = document.getElementById('domain-filters-body');
  
  // Initial setup - toggle storage config sections
  storageTypeSelect.addEventListener('change', () => {
    const useS3 = storageTypeSelect.value === 's3';
    s3Config.classList.toggle('hidden', !useS3);
    r2Config.classList.toggle('hidden', useS3);
  });
  
  // Toggle R2 auth method fields
  for (const radio of r2AuthMethodRadios) {
    radio.addEventListener('change', () => {
      const useApiKeys = document.getElementById('r2-auth-api-keys').checked;
      r2ApiKeysFields.classList.toggle('hidden', !useApiKeys);
      r2TokenField.classList.toggle('hidden', useApiKeys);
    });
  }
  
  // Load saved settings when page loads
  loadSettings();
  
  // Handle form submission
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });
  
  // Handle test connection button
  testConnectionBtn.addEventListener('click', () => {
    testConnection();
  });
  
  // Handle domain filter actions
  addDomainFilterBtn.addEventListener('click', () => {
    addDomainFilter();
  });
  
  clearDomainFiltersBtn.addEventListener('click', () => {
    clearDomainFilters();
  });
  
  // Function to load saved settings
  function loadSettings() {
    chrome.storage.sync.get(['imageUploaderSettings', 'domainSizeFilters'], (result) => {
      const settings = result.imageUploaderSettings || getDefaultSettings();
      
      // Set storage type
      storageTypeSelect.value = settings.useS3 ? 's3' : 'r2';
      storageTypeSelect.dispatchEvent(new Event('change'));
      
      // Set S3 fields
      document.getElementById('s3-region').value = settings.s3.region || '';
      document.getElementById('s3-bucket').value = settings.s3.bucketName || '';
      document.getElementById('s3-folder').value = settings.s3.folderPath || '';
      document.getElementById('s3-access-key').value = settings.s3.accessKeyId || '';
      document.getElementById('s3-secret-key').value = settings.s3.secretAccessKey || '';
      document.getElementById('s3-public').checked = settings.s3.makePublic || false;
      
      // Set R2 fields
      document.getElementById('r2-account-id').value = settings.r2.accountId || '';
      document.getElementById('r2-bucket').value = settings.r2.bucketName || '';
      document.getElementById('r2-folder').value = settings.r2.folderPath || '';
      
      // Set R2 auth method
      if (settings.r2.useApiToken) {
        document.getElementById('r2-auth-token').checked = true;
        document.getElementById('r2-api-token').value = settings.r2.apiToken || '';
      } else {
        document.getElementById('r2-auth-api-keys').checked = true;
        document.getElementById('r2-access-key').value = settings.r2.accessKeyId || '';
        document.getElementById('r2-secret-key').value = settings.r2.secretAccessKey || '';
      }
      
      // Trigger auth method radio change event
      for (const radio of r2AuthMethodRadios) {
        if (radio.checked) {
          radio.dispatchEvent(new Event('change'));
          break;
        }
      }
      
      document.getElementById('r2-public').checked = settings.r2.makePublic || false;
      
      // Set local download settings
      if (settings.local) {
        document.getElementById('local-enabled').checked = settings.local.enabled !== false; // Default to true
        document.getElementById('local-subfolder-domain').checked = settings.local.subfolderPerDomain !== false; // Default to true
      }
      
      // Set general settings
      document.getElementById('preserve-filenames').checked = settings.preserveFilenames;
      document.getElementById('add-metadata').checked = settings.addMetadata;
      document.getElementById('use-domain-folders').checked = settings.useDomainFolders !== false; // Default to true if not set
      document.getElementById('concurrent-uploads').value = settings.maxConcurrentUploads.toString();
      
      // Set minimum file size (convert bytes to KB)
      const minFileSizeKB = Math.round(settings.minFileSize / 1024) || 5;
      document.getElementById('min-file-size').value = minFileSizeKB;
      
      // Load domain filters
      const domainFilters = result.domainSizeFilters || {};
      loadDomainFiltersTable(domainFilters);
    });
  }
  
  // Function to save settings
  function saveSettings() {
    const useS3 = storageTypeSelect.value === 's3';
    const useR2ApiToken = document.getElementById('r2-auth-token').checked;
    
    // Get and validate the minimum file size
    let minFileSizeKB = parseInt(document.getElementById('min-file-size').value, 10);
    if (isNaN(minFileSizeKB) || minFileSizeKB < 0) {
      minFileSizeKB = 5; // Default to 5KB if invalid
    }
    
    const settings = {
      useS3: useS3,
      s3: {
        region: document.getElementById('s3-region').value,
        bucketName: document.getElementById('s3-bucket').value,
        folderPath: document.getElementById('s3-folder').value,
        accessKeyId: document.getElementById('s3-access-key').value,
        secretAccessKey: document.getElementById('s3-secret-key').value,
        makePublic: document.getElementById('s3-public').checked
      },
      r2: {
        accountId: document.getElementById('r2-account-id').value,
        bucketName: document.getElementById('r2-bucket').value,
        folderPath: document.getElementById('r2-folder').value,
        useApiToken: useR2ApiToken,
        accessKeyId: useR2ApiToken ? '' : document.getElementById('r2-access-key').value,
        secretAccessKey: useR2ApiToken ? '' : document.getElementById('r2-secret-key').value,
        apiToken: useR2ApiToken ? document.getElementById('r2-api-token').value : '',
        makePublic: document.getElementById('r2-public').checked
      },
      local: {
        enabled: document.getElementById('local-enabled').checked,
        subfolderPerDomain: document.getElementById('local-subfolder-domain').checked
      },
      preserveFilenames: document.getElementById('preserve-filenames').checked,
      addMetadata: document.getElementById('add-metadata').checked,
      useDomainFolders: document.getElementById('use-domain-folders').checked,
      maxConcurrentUploads: parseInt(document.getElementById('concurrent-uploads').value, 10),
      minFileSize: minFileSizeKB * 1024 // Convert KB to bytes
    };
    
    chrome.storage.sync.set({ imageUploaderSettings: settings }, () => {
      showStatusMessage('Settings saved successfully!', 'success');
    });
  }
  
  // Test connection to storage service
  function testConnection() {
    const useS3 = storageTypeSelect.value === 's3';
    const useR2ApiToken = document.getElementById('r2-auth-token').checked;
    
    showStatusMessage('Testing connection...', 'info');
    
    // Create a temporary test file
    const testBlob = new Blob(['test file content'], { type: 'text/plain' });
    const testFilename = `test-${Date.now()}.txt`;
    
    // Get and validate the minimum file size
    let minFileSizeKB = parseInt(document.getElementById('min-file-size').value, 10);
    if (isNaN(minFileSizeKB) || minFileSizeKB < 0) {
      minFileSizeKB = 5; // Default to 5KB if invalid
    }
    
    // Get current settings from form
    const settings = {
      useS3: useS3,
      s3: {
        region: document.getElementById('s3-region').value,
        bucketName: document.getElementById('s3-bucket').value,
        folderPath: document.getElementById('s3-folder').value,
        accessKeyId: document.getElementById('s3-access-key').value,
        secretAccessKey: document.getElementById('s3-secret-key').value,
        makePublic: document.getElementById('s3-public').checked
      },
      r2: {
        accountId: document.getElementById('r2-account-id').value,
        bucketName: document.getElementById('r2-bucket').value,
        folderPath: document.getElementById('r2-folder').value,
        useApiToken: useR2ApiToken,
        accessKeyId: useR2ApiToken ? '' : document.getElementById('r2-access-key').value,
        secretAccessKey: useR2ApiToken ? '' : document.getElementById('r2-secret-key').value,
        apiToken: useR2ApiToken ? document.getElementById('r2-api-token').value : '',
        makePublic: document.getElementById('r2-public').checked
      },
      useDomainFolders: document.getElementById('use-domain-folders').checked,
      minFileSize: minFileSizeKB * 1024 // Convert KB to bytes
    };
    
    // Validate required fields before testing
    if (useS3) {
      if (!settings.s3.bucketName || !settings.s3.accessKeyId || !settings.s3.secretAccessKey) {
        showStatusMessage('Please fill in all required S3 fields', 'error');
        return;
      }
    } else {
      if (!settings.r2.accountId || !settings.r2.bucketName) {
        showStatusMessage('Please fill in all required R2 fields', 'error');
        return;
      }
      
      if (useR2ApiToken) {
        if (!settings.r2.apiToken) {
          showStatusMessage('Please enter your Cloudflare API token', 'error');
          return;
        }
      } else {
        if (!settings.r2.accessKeyId || !settings.r2.secretAccessKey) {
          showStatusMessage('Please enter your R2 API keys', 'error');
          return;
        }
      }
    }
    
    // Send test request to background script
    chrome.runtime.sendMessage({
      action: 'testConnection',
      settings: settings,
      testFile: {
        blob: testBlob,
        filename: testFilename
      }
    }, (response) => {
      if (response && response.success) {
        showStatusMessage(`Connection successful! File uploaded to: ${response.url}`, 'success');
      } else {
        showStatusMessage(`Connection failed: ${response?.error || 'Unknown error'}`, 'error');
      }
    });
  }
  
  // Add a domain filter
  function addDomainFilter() {
    const domain = newDomainInput.value.trim();
    const minWidth = parseInt(newMinWidthInput.value) || 0;
    const minHeight = parseInt(newMinHeightInput.value) || 0;
    
    if (!domain) {
      showStatusMessage('Please enter a domain name', 'error');
      return;
    }
    
    chrome.storage.sync.get('domainSizeFilters', (result) => {
      const domainFilters = result.domainSizeFilters || {};
      
      // Add or update the filter
      domainFilters[domain] = {
        minWidth: minWidth,
        minHeight: minHeight
      };
      
      // Save to storage
      chrome.storage.sync.set({ domainSizeFilters: domainFilters }, () => {
        showStatusMessage(`Filter for ${domain} saved`, 'success');
        
        // Reset input fields
        newDomainInput.value = '';
        newMinWidthInput.value = '50';
        newMinHeightInput.value = '50';
        
        // Reload the table
        loadDomainFiltersTable(domainFilters);
      });
    });
  }
  
  // Remove a domain filter
  function removeDomainFilter(domain) {
    chrome.storage.sync.get('domainSizeFilters', (result) => {
      const domainFilters = result.domainSizeFilters || {};
      
      // Remove the filter
      delete domainFilters[domain];
      
      // Save to storage
      chrome.storage.sync.set({ domainSizeFilters: domainFilters }, () => {
        showStatusMessage(`Filter for ${domain} removed`, 'success');
        
        // Reload the table
        loadDomainFiltersTable(domainFilters);
      });
    });
  }
  
  // Clear all domain filters
  function clearDomainFilters() {
    if (confirm('Are you sure you want to clear all domain filters?')) {
      chrome.storage.sync.set({ domainSizeFilters: {} }, () => {
        showStatusMessage('All domain filters cleared', 'success');
        
        // Reload the table
        loadDomainFiltersTable({});
      });
    }
  }
  
  // Load domain filters table
  function loadDomainFiltersTable(domainFilters) {
    // Clear the table
    domainFiltersTableBody.innerHTML = '';
    
    // Check if there are any filters
    if (Object.keys(domainFilters).length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = `<td colspan="4" style="text-align: center;">No domain filters configured</td>`;
      domainFiltersTableBody.appendChild(row);
      return;
    }
    
    // Add each filter to the table
    for (const domain in domainFilters) {
      const filter = domainFilters[domain];
      const row = document.createElement('tr');
      
      row.innerHTML = `
        <td>${domain}</td>
        <td>${filter.minWidth}</td>
        <td>${filter.minHeight}</td>
        <td class="filter-actions">
          <button class="danger-button remove-filter" data-domain="${domain}">Remove</button>
        </td>
      `;
      
      domainFiltersTableBody.appendChild(row);
    }
    
    // Add event listeners to remove buttons
    const removeButtons = document.querySelectorAll('.remove-filter');
    removeButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        const domain = e.target.dataset.domain;
        removeDomainFilter(domain);
      });
    });
  }
  
  // Show status message
  function showStatusMessage(message, type = 'info') {
    statusMessageDiv.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
    
    // Clear message after 5 seconds if it's a success message
    if (type === 'success') {
      setTimeout(() => {
        statusMessageDiv.innerHTML = '';
      }, 5000);
    }
  }
  
  // Get default settings
  function getDefaultSettings() {
    return {
      useS3: true,
      s3: {
        region: '',
        bucketName: '',
        folderPath: 'web-images/',
        accessKeyId: '',
        secretAccessKey: '',
        makePublic: false
      },
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
      local: {
        enabled: true,
        subfolderPerDomain: true
      },
      preserveFilenames: true,
      addMetadata: true,
      useDomainFolders: true,
      maxConcurrentUploads: 3,
      minFileSize: 5 * 1024 // 5KB in bytes
    };
  }
});
