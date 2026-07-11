const test = require('node:test');
const assert = require('node:assert/strict');

const toolkit = require('../chatgpt-helper-extension/toolkit-utils.js');

test('normalizes toolkit settings and bounds reading controls', () => {
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
  assert.equal(settings.paragraphSpacing, 0.2);
});

test('matches timeline search without case sensitivity', () => {
  const message = { text: 'Export selected ChatGPT messages' };
  assert.equal(toolkit.matchesTimelineQuery(message, 'chatgpt'), true);
  assert.equal(toolkit.matchesTimelineQuery(message, 'formula'), false);
});

test('extracts stable conversation keys from ChatGPT paths', () => {
  assert.equal(toolkit.getConversationKey('/c/abc-123'), 'abc-123');
  assert.equal(toolkit.getConversationKey('/'), 'new-chat');
});
