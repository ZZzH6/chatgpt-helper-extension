const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const contentPath = path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js');

function createReadingHarness(document, settings, actionNodes = []) {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function setReadingStyle(element, property, value) {');
  const end = source.indexOf('  function findComposer() {', start);
  const genericStart = source.indexOf('  function findGenericMessageNodes() {');
  const genericEnd = source.indexOf('  function inferRole(node) {', genericStart);
  assert.ok(start >= 0 && end > start && genericStart >= 0 && genericEnd > genericStart);
  return new Function('document', 'settings', 'location', 'findMessageNodesFromActions', `
    const readingStyleBackup = new Map();
    let readingBaseFontSizes = new WeakMap();
    ${source.slice(genericStart, genericEnd)}
    ${source.slice(start, end)}
    return { applyReadingSettings };
  `)(document, settings, { pathname: '/c/example' }, () => actionNodes);
}

test('reading settings change message text and column width, then restore previous styles', () => {
  const { document } = parseHTML(`
    <main><article data-testid="conversation-turn-1">
      <div class="max-w-[var(--thread-content-max-width)]" style="max-width: 768px">
        <div data-message-author-role="assistant">
          <div class="markdown"><p style="font-size: 18px">测试正文</p><p>第二段</p></div>
        </div>
      </div>
    </article></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 1000, fontScale: 130, lineHeight: 1.8, paragraphSpacing: 0.8 };
  const { applyReadingSettings } = createReadingHarness(document, settings);
  const paragraph = document.querySelector('.markdown p');
  const widthNode = document.querySelector('[class*="thread-content-max-width"]');

  const result = applyReadingSettings();
  assert.equal(result.readingTargets, 1);
  assert.equal(result.widthTargets, 1);
  assert.equal(result.readingVerified, true);
  assert.equal(result.diagnostics.source, '[data-message-author-role]');
  assert.equal(paragraph.style.getPropertyValue('font-size'), '23.4px');
  assert.equal(paragraph.style.getPropertyValue('line-height'), '1.8');
  assert.equal(widthNode.style.getPropertyValue('max-width'), '1000px');

  settings.fontScale = 85;
  settings.readingWidth = 640;
  applyReadingSettings();
  assert.equal(paragraph.style.getPropertyValue('font-size'), '15.3px');
  assert.equal(widthNode.style.getPropertyValue('max-width'), '640px');

  settings.readingEnabled = false;
  applyReadingSettings();
  assert.equal(paragraph.style.getPropertyValue('font-size'), '18px');
  assert.equal(widthNode.style.getPropertyValue('max-width'), '768px');
});

test('original reading values restore only their own inline styles', () => {
  const { document } = parseHTML(`
    <main><article data-testid="conversation-turn-1">
      <div class="max-w-[var(--thread-content-max-width)]" style="--thread-content-max-width: 777px !important; max-width: 777px !important; width: 95% !important">
        <div data-message-author-role="assistant">
          <div class="markdown"><p style="font-size: 18px !important; line-height: 1.25 !important; margin-block: 0.4em !important">原版排版</p></div>
        </div>
      </div>
    </article></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 0, fontScale: 0, lineHeight: 0, paragraphSpacing: 0 };
  const { applyReadingSettings } = createReadingHarness(document, settings);
  const paragraph = document.querySelector('.markdown p');
  const widthNode = document.querySelector('[class*="thread-content-max-width"]');
  const inlineValue = (element, property) => {
    const value = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority?.(property) || '';
    if (value.endsWith(' !important')) return value;
    return priority === 'important' ? `${value} !important` : value;
  };

  const originalResult = applyReadingSettings();
  assert.equal(originalResult.readingVerified, true);
  assert.equal(inlineValue(widthNode, '--thread-content-max-width'), '777px !important');
  assert.equal(inlineValue(widthNode, 'max-width'), '777px !important');
  assert.equal(inlineValue(widthNode, 'width'), '95% !important');
  assert.equal(inlineValue(paragraph, 'font-size'), '18px !important');
  assert.equal(inlineValue(paragraph, 'line-height'), '1.25 !important');
  assert.equal(inlineValue(paragraph, 'margin-block'), '0.4em !important');

  settings.readingWidth = 1000;
  settings.fontScale = 130;
  settings.lineHeight = 1.8;
  settings.paragraphSpacing = 0.8;
  applyReadingSettings();
  assert.equal(widthNode.style.getPropertyValue('max-width'), '1000px');
  assert.equal(widthNode.style.getPropertyValue('--thread-content-max-width'), '1000px');
  assert.equal(widthNode.style.getPropertyValue('width'), '100%');
  assert.equal(paragraph.style.getPropertyValue('font-size'), '23.4px');
  assert.equal(paragraph.style.getPropertyValue('line-height'), '1.8');
  assert.equal(paragraph.style.getPropertyValue('margin-block'), '0.8em');

  settings.readingWidth = 0;
  settings.lineHeight = 0;
  applyReadingSettings();
  assert.equal(inlineValue(widthNode, '--thread-content-max-width'), '777px !important');
  assert.equal(inlineValue(widthNode, 'max-width'), '777px !important');
  assert.equal(inlineValue(widthNode, 'width'), '95% !important');
  assert.equal(inlineValue(paragraph, 'line-height'), '1.25 !important');
  assert.equal(paragraph.style.getPropertyValue('font-size'), '23.4px');
  assert.equal(paragraph.style.getPropertyValue('margin-block'), '0.8em');

  settings.fontScale = 0;
  settings.paragraphSpacing = 0;
  applyReadingSettings();
  assert.equal(inlineValue(paragraph, 'font-size'), '18px !important');
  assert.equal(inlineValue(paragraph, 'line-height'), '1.25 !important');
  assert.equal(inlineValue(paragraph, 'margin-block'), '0.4em !important');
});

test('reading settings also handle message containers without conversation turn testids', () => {
  const { document } = parseHTML(`
    <main><div id="thread"><div class="max-w-[var(--thread-content-max-width)]" style="max-width: 720px">
      <div data-message-author-role="assistant"><div class="prose"><p>新的页面结构</p></div></div>
    </div></div></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 1100, fontScale: 85, lineHeight: 1.5, paragraphSpacing: 0.4 };
  const { applyReadingSettings } = createReadingHarness(document, settings);

  const result = applyReadingSettings();
  assert.equal(result.readingTargets, 1);
  assert.equal(result.widthTargets, 1);
  assert.equal(result.readingVerified, true);
  assert.equal(document.querySelector('.prose p').style.getPropertyValue('font-size'), '13.6px');
  assert.equal(document.querySelector('[class*="thread-content-max-width"]').style.getPropertyValue('max-width'), '1100px');
});

test('reading settings recognize section[data-turn] when role attributes are absent', () => {
  const { document } = parseHTML(`
    <main><div id="thread">
      <section data-turn="user"><div class="max-w-[var(--user-chat-width,70%)]" style="max-width: 70%"><div class="whitespace-pre-wrap">问题</div></div></section>
      <section data-turn="assistant"><div class="max-w-chat"><div class="markdown"><p>回答正文</p></div></div></section>
    </div></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 1020, fontScale: 130, lineHeight: 1.7, paragraphSpacing: 0.8 };
  const { applyReadingSettings } = createReadingHarness(document, settings);

  const result = applyReadingSettings();
  assert.equal(result.readingTargets, 2);
  assert.equal(result.widthTargets, 1);
  assert.equal(result.readingVerified, true);
  assert.equal(result.diagnostics.source, 'section[data-turn]');
  assert.equal(result.diagnostics.sections, 2);
  assert.equal(result.diagnostics.roles, 0);
  assert.equal(document.querySelector('.markdown p').style.getPropertyValue('font-size'), '20.8px');
  assert.equal(document.querySelector('[class*="user-chat-width"]').style.getPropertyValue('max-width'), '70%');
});

test('reading settings fall back to visible paragraph text without message markers', () => {
  const { document } = parseHTML(`
    <main><div><p>Visible answer paragraph</p><p>Another answer paragraph</p></div>
      <form><p>Composer helper text</p></form></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 1020, fontScale: 85, lineHeight: 1.8, paragraphSpacing: 0.8 };
  const { applyReadingSettings } = createReadingHarness(document, settings);

  const result = applyReadingSettings();
  assert.equal(result.readingTargets, 2);
  assert.equal(result.diagnostics.source, 'main text');
  assert.equal(result.diagnostics.mainChars > 0, true);
  assert.equal(result.readingVerified, true);
  assert.equal(document.querySelector('main p').style.getPropertyValue('font-size'), '13.6px');
  assert.equal(document.querySelector('form p').style.getPropertyValue('font-size') || '', '');
});

test('reading settings include direct text nodes alongside paragraphs', () => {
  const { document } = parseHTML('<main><div><p>Formatted paragraph</p><div>Direct answer text</div></div></main>');
  const settings = { readingEnabled: true, readingWidth: 1020, fontScale: 85, lineHeight: 1.8, paragraphSpacing: 0.8 };
  const { applyReadingSettings } = createReadingHarness(document, settings);

  const result = applyReadingSettings();
  assert.equal(result.readingTargets, 2);
  assert.equal(document.querySelector('main div div').style.getPropertyValue('font-size'), '13.6px');
});

test('reading settings scale actual text and math while updating paragraph gaps', () => {
  const { document } = parseHTML(`
    <main><div class="answer"><p style="margin-block: 3em">
      <span style="font-size: 24px">Visible body text</span>
      <span class="katex" style="font-size: 25px">x²</span>
    </p></div></main>
  `);
  const settings = { readingEnabled: true, readingWidth: 900, fontScale: 85, lineHeight: 1.35, paragraphSpacing: 0.2 };
  const { applyReadingSettings } = createReadingHarness(document, settings);
  const text = document.querySelector('p span');
  const math = document.querySelector('.katex');
  const paragraph = document.querySelector('p');

  const first = applyReadingSettings();
  assert.equal(first.diagnostics.textTargets, 1);
  assert.equal(first.diagnostics.spacingTargets, 1);
  assert.equal(first.diagnostics.baseFontSize, 24);
  assert.equal(first.diagnostics.fontSize, 20.4);
  assert.equal(text.style.getPropertyValue('font-size'), '20.4px');
  assert.equal(text.style.getPropertyValue('line-height'), '1.35');
  assert.equal(math.style.getPropertyValue('font-size'), '21.25px');
  assert.equal(paragraph.style.getPropertyValue('margin-block'), '0.2em');

  settings.fontScale = 130;
  settings.lineHeight = 2.1;
  settings.paragraphSpacing = 1.6;
  const second = applyReadingSettings();
  assert.equal(second.diagnostics.fontSize, 31.2);
  assert.equal(text.style.getPropertyValue('font-size'), '31.2px');
  assert.equal(text.style.getPropertyValue('line-height'), '2.1');
  assert.equal(math.style.getPropertyValue('font-size'), '32.5px');
  assert.equal(paragraph.style.getPropertyValue('margin-block'), '1.6em');

  settings.readingEnabled = false;
  applyReadingSettings();
  assert.equal(text.style.getPropertyValue('font-size'), '24px');
  assert.equal(math.style.getPropertyValue('font-size'), '25px');
  assert.equal(paragraph.style.getPropertyValue('margin-block'), '3em');
});

test('reading settings style the assistant answer when an action anchor wraps a full exchange', () => {
  const { document } = parseHTML(`
    <main><div class="exchange"><div class="user"><div class="whitespace-pre-wrap">Question</div></div>
      <div class="assistant"><p style="font-size: 20px">The answer text</p></div></div></main>
  `);
  const exchange = document.querySelector('.exchange');
  const settings = { readingEnabled: true, readingWidth: 900, fontScale: 130, lineHeight: 1.8, paragraphSpacing: 0.8 };
  const { applyReadingSettings } = createReadingHarness(document, settings, [exchange]);

  const result = applyReadingSettings();
  assert.equal(result.diagnostics.source, 'copy actions');
  assert.equal(result.readingTargets, 1);
  assert.equal(document.querySelector('.assistant p').style.getPropertyValue('font-size'), '26px');
  assert.equal(document.querySelector('.assistant p').style.getPropertyValue('line-height'), '1.8');
});
