const test = require('node:test');
const assert = require('node:assert/strict');

const toolkit = require('../chatgpt-helper-extension/toolkit-utils.js');

test('normalizes toolkit settings and bounds custom reading controls', () => {
  const settings = toolkit.normalizeSettings({
    copyMode: 'word',
    readingEnabled: true,
    readingWidth: 9999,
    fontScale: 40,
    lineHeight: 1.87,
    paragraphSpacing: 0,
  });

  assert.equal(settings.copyMode, 'word');
  assert.equal(settings.readingEnabled, true);
  assert.equal(settings.readingWidth, 1200);
  assert.equal(settings.fontScale, 85);
  assert.equal(settings.lineHeight, 1.87);
  assert.equal(settings.paragraphSpacing, 0);
});

test('defaults reading controls to original and preserves saved custom values', () => {
  assert.deepEqual(
    [toolkit.DEFAULTS.readingWidth, toolkit.DEFAULTS.fontScale, toolkit.DEFAULTS.lineHeight, toolkit.DEFAULTS.paragraphSpacing],
    [0, 0, 0, 0],
  );
  const settings = toolkit.normalizeSettings({ readingWidth: 1000, fontScale: 115, lineHeight: 1.8, paragraphSpacing: 0.7 });
  assert.deepEqual(
    [settings.readingWidth, settings.fontScale, settings.lineHeight, settings.paragraphSpacing],
    [1000, 115, 1.8, 0.7],
  );
});

test('extracts stable conversation keys from ChatGPT paths', () => {
  assert.equal(toolkit.getConversationKey('/c/abc-123'), 'abc-123');
  assert.equal(toolkit.getConversationKey('/'), 'new-chat');
});
