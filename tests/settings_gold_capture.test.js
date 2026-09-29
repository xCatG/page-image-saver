const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helpers = require('../extension_helpers.js');

class FakeElement {
  constructor() {
    this.checked = false;
    this.value = '';
    this.innerHTML = '';
    this.listeners = {};
    this.classList = { toggle: () => {} };
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  dispatchEvent(event) {
    event.target = this;
    for (const listener of this.listeners[event.type] || []) listener(event);
  }

  appendChild() {}
  querySelectorAll() { return []; }
}

test('gold capture preset saves a local-only sidecar configuration from the settings page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const initialSettings = {
    useS3: true,
    s3: {
      region: 'us-east-1', bucketName: 'bucket', folderPath: 'cloud/',
      accessKeyId: 'access', secretAccessKey: 'secret', makePublic: true
    },
    r2: {
      accountId: 'account', bucketName: 'bucket', folderPath: 'cloud/',
      useApiToken: true, accessKeyId: '', secretAccessKey: '',
      apiToken: 'token', makePublic: true
    },
    local: {
      enabled: false, subfolderPerDomain: false, saveJson: false,
      baseFolder: 'My Gold Evidence'
    },
    receiver: {enabled: true, url: 'http://192.168.1.100:8765', token: 'fixture-token'},
    retry: { enabled: true, showNotification: true, maxRetries: 3 },
    preserveFilenames: true,
    addMetadata: true,
    useDomainFolders: true,
    maxConcurrentUploads: 3,
    minFileSize: 5120
  };
  const writes = [];
  let onReady;
  const sandbox = {
    PageImageSaverHelpers: helpers,
    Event: class Event { constructor(type) { this.type = type; } },
    Blob,
    console,
    confirm: () => true,
    setTimeout: () => 1,
    document: {
      addEventListener: (type, listener) => { if (type === 'DOMContentLoaded') onReady = listener; },
      getElementById: getElement,
      getElementsByName: name => name === 'r2AuthMethod'
        ? [getElement('r2-auth-api-keys'), getElement('r2-auth-token')]
        : [],
      createElement: () => new FakeElement(),
      querySelectorAll: () => []
    },
    chrome: {
      storage: {
        sync: {
          get: (_keys, callback) => callback({
            imageUploaderSettings: initialSettings,
            domainSizeFilters: {},
            ignoredImageUrls: []
          }),
          set: (value, callback) => {
            writes.push(value);
            if (callback) callback();
          }
        }
      },
      runtime: { sendMessage: () => {} }
    }
  };

  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  onReady();
  assert.equal(getElement('receiver-enabled').checked, true);
  assert.equal(getElement('receiver-url').value, 'http://192.168.1.100:8765');
  assert.equal(getElement('receiver-token').value, 'fixture-token');
  getElement('receiver-url').value = 'http://127.0.0.1:8765';
  getElement('settings-form').dispatchEvent({type: 'submit', preventDefault() {}});
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].imageUploaderSettings.receiver)), {
    enabled: true, url: 'http://127.0.0.1:8765', token: 'fixture-token'
  });
  getElement('gold-capture-preset').dispatchEvent({ type: 'click' });

  assert.equal(writes.length, 2);
  const saved = writes[1].imageUploaderSettings;
  assert.deepEqual(JSON.parse(JSON.stringify(saved.local)), {
    enabled: true,
    subfolderPerDomain: true,
    saveJson: true,
    baseFolder: 'My Gold Evidence'
  });
  assert.equal(saved.s3.bucketName, '');
  assert.equal(saved.s3.accessKeyId, '');
  assert.equal(saved.s3.secretAccessKey, '');
  assert.equal(saved.s3.makePublic, false);
  assert.equal(saved.r2.accountId, '');
  assert.equal(saved.r2.bucketName, '');
  assert.equal(saved.r2.apiToken, '');
  assert.equal(saved.r2.makePublic, false);
});
