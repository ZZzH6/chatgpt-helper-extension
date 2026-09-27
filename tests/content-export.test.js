const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseHTML, Element, HTMLElement } = require('linkedom');

const contentPath = path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js');

function loadCodeStylePreserver() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function preserveCodeSyntaxStyles(source, clone, styleResolver = null) {');
  const end = source.indexOf('  function findMessageContentNode(node) {', start);
  assert.notEqual(start, -1, 'preserveCodeSyntaxStyles should exist in content.js');
  assert.ok(end > start, 'preserveCodeSyntaxStyles should precede findMessageContentNode');

  const helpers = {};
  const segment = `${source.slice(start, end)}
helpers.preserveCodeSyntaxStyles = preserveCodeSyntaxStyles;`;
  new Function('Element', 'helpers', segment)(Element, helpers);
  return helpers.preserveCodeSyntaxStyles;
}

function loadMessageContentFinder() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function findMessageContentNode(node) {');
  const end = source.indexOf('  function stripInlineInteractionAttributes(root) {', start);
  assert.ok(start >= 0 && end > start, 'findMessageContentNode should exist in content.js');

  const helpers = {};
  const normalizeWhitespace = (text) => text
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const segment = `${source.slice(start, end)}
helpers.findMessageContentNode = findMessageContentNode;`;
  new Function('Element', 'normalizeWhitespace', 'helpers', segment)(Element, normalizeWhitespace, helpers);
  return helpers.findMessageContentNode;
}

function loadExportOverflowNormalizer() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function normalizeExportOverflow(root) {');
  const end = source.indexOf('  function normalizeExportTables(root) {', start);
  assert.ok(start >= 0 && end > start, 'export overflow helpers should exist in content.js');

  const helpers = {};
  const window = {
    getComputedStyle: (element) => ({
      overflow: element.style.overflow || 'visible',
      overflowX: element.style.overflowX || 'visible',
      overflowY: element.style.overflowY || 'visible',
      whiteSpace: element.style.whiteSpace || 'normal',
      width: element.style.width || 'auto',
      minWidth: element.style.minWidth || '0px',
    }),
  };
  const segment = `${source.slice(start, end)}
helpers.normalizeExportOverflow = normalizeExportOverflow;`;
  new Function('Element', 'HTMLElement', 'window', 'helpers', segment)(Element, HTMLElement, window, helpers);
  return helpers.normalizeExportOverflow;
}

test('freezes computed syntax colors onto cloned code tokens', () => {
  const { document } = parseHTML(`
    <div class="markdown">
      <pre><code data-test-color="rgb(244, 244, 245)"><span class="keyword" data-test-color="rgb(198, 120, 221)">const</span> value = <span class="number" data-test-color="rgb(209, 154, 102)">1</span>;</code></pre>
    </div>
  `);
  const source = document.querySelector('.markdown');
  const clone = source.cloneNode(true);
  const preserveCodeSyntaxStyles = loadCodeStylePreserver();

  preserveCodeSyntaxStyles(source, clone, node => ({
    color: node.getAttribute('data-test-color') || 'rgba(0, 0, 0, 0)',
  }));

  const code = clone.querySelector('code');
  const keyword = clone.querySelector('.keyword');
  const number = clone.querySelector('.number');
  assert.ok(code.classList.contains('cgh-export-syntax-token'));
  assert.equal(code.style.getPropertyValue('--cgh-syntax-color'), 'rgb(244, 244, 245)');
  assert.equal(keyword.style.getPropertyValue('--cgh-syntax-color'), 'rgb(198, 120, 221)');
  assert.equal(number.style.getPropertyValue('--cgh-syntax-color'), 'rgb(209, 154, 102)');
});

test('print CSS gives frozen syntax colors priority over generic span colors', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.match(
    source,
    /\.cgh-print-content \.cgh-export-syntax-token\s*\{[^}]*color:\s*var\(--cgh-syntax-color,[^}]*!important;/s,
  );
  assert.match(source, /\.cgh-export-syntax-token\s*\{[^}]*print-color-adjust:\s*exact;/s);
});

test('export overflow normalization preserves KaTeX clipping containers', () => {
  const { document } = parseHTML(`
    <div class="cgh-print-content">
      <div class="overflow-hidden" style="overflow: hidden">
        <span class="katex">
          <span class="hide-tail" style="overflow: hidden"><span class="stretchy" style="overflow: hidden"><svg style="overflow: hidden"></svg></span></span>
        </span>
      </div>
    </div>
  `);
  const normalizeExportOverflow = loadExportOverflowNormalizer();
  normalizeExportOverflow(document.querySelector('.cgh-print-content'));

  assert.equal(document.querySelector('.overflow-hidden').style.getPropertyValue('overflow'), 'visible');
  for (const selector of ['.hide-tail', '.stretchy', 'svg']) {
    const node = document.querySelector(selector);
    assert.notEqual(node.style.getPropertyValue('overflow'), 'visible');
    assert.doesNotMatch(node.getAttribute('style') || '', /overflow:\s*visible\s*!important/i);
  }
});

test('print overflow rules leave KaTeX internals to their native clipping styles', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.match(source, /\.cgh-print-content \*:not\(\.katex\):not\(\.katex \*\)\s*\{[^}]*overflow:\s*visible\s*!important;/s);
  assert.match(source, /\.cgh-print-content svg:not\(\.katex svg\)\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(source, /\.cgh-print-content \.katex \.hide-tail,[\s\S]*?\.cgh-print-content \.katex \.stretchy\s*\{[^}]*overflow:\s*hidden\s*!important;/);
});

test('message content finder skips an early short candidate when a full body follows', () => {
  const { document } = parseHTML(`
    <article data-testid="conversation-turn">
      <div data-message-author-role="assistant">
        <div class="markdown"><p>对，gradu 就是梯度，下面先解释梯度、散度和旋度的区别。</p><p>这里还有完整回复的后续说明。</p><span class="katex">完整公式结构</span><span data-message-id="partial">grad / div / rot</span></div>
        <button>复制</button>
      </div>
    </article>
  `);
  const message = document.querySelector('article');
  const findMessageContentNode = loadMessageContentFinder();

  const content = findMessageContentNode(message);
  assert.equal(content?.className, 'markdown');
  assert.match(content.textContent, /对，gradu 就是梯度/);
  assert.match(content.textContent, /完整回复的后续说明/);
  assert.ok(content.querySelector('.katex'), 'the selected markdown node should keep its formula structure');
});

test('message content finder falls back to the message when body text is split across blocks', () => {
  const { document } = parseHTML(`
    <article data-testid="conversation-turn">
      <div data-message-author-role="assistant">
        <div class="markdown"><p>第一段正文包含前半部分。</p></div>
        <div class="markdown"><p>第二段正文包含后半部分。</p></div>
        <button>复制</button>
      </div>
    </article>
  `);
  const message = document.querySelector('article');
  const findMessageContentNode = loadMessageContentFinder();

  const content = findMessageContentNode(message) || message;
  assert.equal(content, message);
  assert.match(content.textContent, /第一段正文包含前半部分/);
  assert.match(content.textContent, /第二段正文包含后半部分/);
});
