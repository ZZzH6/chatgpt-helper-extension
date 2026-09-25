const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const toolkit = require('../chatgpt-helper-extension/toolkit-utils.js');
const popupCode = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'popup.js'), 'utf8');
const diagnostics = { route: 'conversation', main: 1, mainChars: 1200, paragraphs: 8, frames: 0, source: 'section[data-turn]', sections: 4, roles: 0, messageIds: 0, actions: 0, legacyTurns: 0, markdown: 4, textTargets: 12, spacingTargets: 8, baseFontSize: 16, fontSize: 20.8, lineHeight: '33.28px', marginBlock: '0.8em' };

function createPopup({ sendMessage, query = async () => [{ id: 7, url: 'https://chatgpt.com/c/example' }] }) {
  class MockInput {
    constructor(id, value) {
      this.id = id;
      this.type = typeof value === 'boolean' ? 'checkbox' : 'range';
      this.checked = value === true;
      this.value = String(value);
    }
  }

  const fields = Object.fromEntries(Object.entries(toolkit.DEFAULTS).map(([id, value]) => [id, new MockInput(id, value)]));
  const status = { textContent: '' };
  const diagnostics = { textContent: '', hidden: true };
  const saveButton = { disabled: false, addEventListener: (_type, listener) => { saveButton.click = listener; } };
  const calls = { saved: null, sent: [], reloaded: [] };
  const document = {
    getElementById: id => ({ ...fields, status, diagnostics, saveBtn: saveButton, extensionVersion: { textContent: '' } })[id],
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const chrome = {
    runtime: { getManifest: () => ({ version: '2.0.12' }) },
    storage: { sync: {
      get: async () => ({ ...toolkit.DEFAULTS }),
      set: async values => { calls.saved = values; },
    } },
    tabs: {
      query,
      sendMessage: async (id, message) => {
        calls.sent.push({ id, message });
        return sendMessage(id, message);
      },
      reload: async id => { calls.reloaded.push(id); },
    },
  };
  vm.runInNewContext(popupCode, { document, chrome, globalThis: { CGH_TOOLKIT: toolkit }, HTMLInputElement: MockInput, URL });
  return { fields, status, diagnostics, saveButton, calls };
}

test('saving applies changed settings to the open ChatGPT tab without reloading', async () => {
  const popup = createPopup({ sendMessage: async () => ({ applied: true, readingEngineVersion: 6, navigationTargets: 3, readingTargets: 3, widthTargets: 3, readingVerified: true, diagnostics }) });
  popup.fields.readingEnabled.checked = true;
  popup.fields.readingWidth.value = '1000';

  await popup.saveButton.click();

  assert.equal(popup.calls.saved.readingWidth, 1000);
  assert.equal(popup.calls.sent[0].message.settings.readingEnabled, true);
  assert.deepEqual(popup.calls.reloaded, []);
  assert.equal(popup.status.textContent, '已保存，聊天页已更新');
});

test('saving refreshes a ChatGPT tab that has no responding content script', async () => {
  const popup = createPopup({ sendMessage: async () => { throw new Error('Receiving end does not exist'); } });

  await popup.saveButton.click();

  assert.deepEqual(popup.calls.reloaded, [7]);
  assert.equal(popup.status.textContent, '已保存，正在刷新聊天页');
});

test('saving refreshes a tab still running the older content script', async () => {
  const popup = createPopup({ sendMessage: async () => ({ applied: true, readingEngineVersion: 5, navigationTargets: 2, readingTargets: 2, widthTargets: 1, diagnostics }) });
  popup.fields.readingEnabled.checked = true;

  await popup.saveButton.click();

  assert.deepEqual(popup.calls.reloaded, [7]);
});

test('saving reports when the active tab is not ChatGPT', async () => {
  const popup = createPopup({
    sendMessage: async () => ({ applied: true, readingEngineVersion: 6, navigationTargets: 3, readingTargets: 3, widthTargets: 3, readingVerified: true, diagnostics }),
    query: async () => [{ id: 8, url: 'https://example.com/' }],
  });

  await popup.saveButton.click();

  assert.ok(popup.calls.saved);
  assert.deepEqual(popup.calls.sent, []);
  assert.deepEqual(popup.calls.reloaded, []);
  assert.equal(popup.status.textContent, '已保存，打开聊天页后生效');
});

test('saving reports a chat page with no recognized reading content', async () => {
  const popup = createPopup({ sendMessage: async () => ({
    applied: true, readingEngineVersion: 6, navigationTargets: 0, readingTargets: 0, widthTargets: 0, readingVerified: false,
    diagnostics: { ...diagnostics, source: 'none', sections: 0, roles: 0, legacyTurns: 0, markdown: 0, fontSize: null },
  }) });
  popup.fields.readingEnabled.checked = true;

  await popup.saveButton.click();

  assert.deepEqual(popup.calls.reloaded, []);
  assert.equal(popup.status.textContent, '已保存，未找到聊天正文');
  assert.match(popup.diagnostics.textContent, /section 0 · role 0/);
  assert.equal(popup.diagnostics.hidden, false);
});

test('saving reports when message styles are not visibly applied', async () => {
  const popup = createPopup({ sendMessage: async () => ({ applied: true, readingEngineVersion: 6, navigationTargets: 2, readingTargets: 2, widthTargets: 2, readingVerified: false, diagnostics }) });
  popup.fields.readingEnabled.checked = true;

  await popup.saveButton.click();

  assert.equal(popup.status.textContent, '已保存，但排版未生效');
});

test('saving reports when conversation navigation still has no messages', async () => {
  const popup = createPopup({ sendMessage: async () => ({
    applied: true, readingEngineVersion: 6, navigationTargets: 0, readingTargets: 2, widthTargets: 1, readingVerified: true, diagnostics,
  }) });
  popup.fields.readingEnabled.checked = true;

  await popup.saveButton.click();

  assert.match(popup.status.textContent, /对话导航未找到消息/);
  assert.match(popup.diagnostics.textContent, /导航 0/);
});

test('saving identifies a ChatGPT page without an open conversation', async () => {
  const popup = createPopup({ sendMessage: async () => ({
    applied: true, readingEngineVersion: 6, navigationTargets: 0, readingTargets: 0, widthTargets: 0, readingVerified: false,
    diagnostics: { ...diagnostics, route: 'home', source: 'none', mainChars: 40, paragraphs: 0 },
  }) });
  popup.fields.readingEnabled.checked = true;

  await popup.saveButton.click();

  assert.equal(popup.status.textContent, '已保存，当前不是对话页');
  assert.match(popup.diagnostics.textContent, /页面 home/);
});
