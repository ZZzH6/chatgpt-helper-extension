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

test('print export turns ChatGPT code chrome into a readable code card', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function normalizePrintCodeBlocks(root) {');
  const end = source.indexOf('  function buildPrintPdfHtml(', start);
  assert.ok(start >= 0 && end > start);
  const { document } = parseHTML(`
    <div class="cgh-print-content"><div class="MarkdownRoot-example">
      <p>大量运算都要求：</p>
      <div class="code-frame"><div class="code-header"><span>&lt;/&gt;</span><span>纯文本</span><button>复制</button></div>
        <div class="code-scroll"><pre><code>寄存器 ↔ ALU ↔ 寄存器</code></pre></div></div>
      <p>内存主要通过 LOAD / STORE 访问。</p>
      <div class="code-frame"><div class="code-header"><span>纯文本</span></div>
        <div class="code-scroll"><pre><code>指令种类少\n寻址方式少</code></pre></div></div>
      <p>下一节。</p>
    </div></div>
  `);
  const normalize = new Function('document', 'normalizeWhitespace', `
    ${source.slice(start, end)}
    return normalizePrintCodeBlocks;
  `)(document, value => String(value).replace(/\s+/g, ' ').trim());
  const root = document.querySelector('.cgh-print-content');
  normalize(root);

  const cards = [...root.querySelectorAll('.cgh-print-code-card')];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.querySelector('.cgh-print-code-label').textContent), ['纯文本', '纯文本']);
  assert.match(cards[0].querySelector('pre').textContent, /寄存器 ↔ ALU/);
  assert.match(cards[1].querySelector('pre').textContent, /指令种类少/);
  assert.equal(root.querySelector('.code-frame'), null);
  assert.deepEqual([...root.querySelectorAll('.MarkdownRoot-example > p')].map(p => p.textContent), [
    '大量运算都要求：', '内存主要通过 LOAD / STORE 访问。', '下一节。'
  ]);
});

test('print CSS separates code headers from larger code text', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.match(source, /\.cgh-print-content \.cgh-print-code-label\s*\{[^}]*border-bottom:[^}]*background:/s);
  assert.match(source, /\.cgh-print-content \.cgh-print-code-card pre\s*\{[^}]*padding: 10pt 11pt !important;[^}]*font-size: 10\.5pt;/s);
  assert.match(source, /\.cgh-print-content \.cgh-print-code-card pre code,[\s\S]*?font-size: inherit !important;/);
});

test('markdown and rich export include every fragment of a grouped response', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const markdownStart = source.indexOf('  function getMessageMarkdownRoot(message) {');
  const markdownEnd = source.indexOf('  function domToMarkdown(root) {', markdownStart);
  const richStart = source.indexOf('  function extractMessageExportContent(message) {');
  const richEnd = source.indexOf('  function preserveCodeSyntaxStyles(', richStart);
  assert.ok(markdownStart >= 0 && markdownEnd > markdownStart && richStart >= 0 && richEnd > richStart);

  const { document } = parseHTML('<main><div id="thought">思考了 28m</div><p id="first">回答开头</p><table id="middle"><tr><td>21题</td></tr></table><p id="last">回答结尾</p></main>');
  const contentNodes = ['first', 'middle', 'last'].map(id => document.querySelector(`#${id}`));
  const message = { node: document.querySelector('#thought'), contentNodes };
  const markdownRoot = new Function('document', 'findMessageContentNode', `
    ${source.slice(markdownStart, markdownEnd)}
    return getMessageMarkdownRoot;
  `)(document, () => null)(message);
  const richRoot = new Function('document', 'extractExportContent', `
    ${source.slice(richStart, richEnd)}
    return extractMessageExportContent;
  `)(document, node => node.cloneNode(true))(message);

  for (const root of [markdownRoot, richRoot]) {
    assert.match(root.textContent, /回答开头/);
    assert.match(root.textContent, /21题/);
    assert.match(root.textContent, /回答结尾/);
    assert.doesNotMatch(root.textContent, /思考了/);
  }
});

test('content finder keeps a short final block outside a long prose body', () => {
  const { document } = parseHTML(`
    <div id="turn"><div class="prose"><p>这是一段很长的正文内容，详细解释了问题的背景、步骤和结果，并包含大部分回答文字。</p></div>
      <p>最后一条结论。</p></div>
  `);
  const turn = document.querySelector('#turn');
  assert.equal(loadMessageContentFinder()(turn), null);
});

test('content finder selects ChatGPT MarkdownRoot outside its hidden role heading', () => {
  const { document } = parseHTML(`
    <div data-content-search-unit-key="fallback-turn-1:2:assistant">
      <h4 class="sr-only">ChatGPT 说</h4>
      <div class="MarkdownRoot-example" data-markdown-text-style="assistant-message"><p>完整回答。</p></div>
    </div>
  `);
  const unit = document.querySelector('[data-content-search-unit-key]');
  assert.equal(loadMessageContentFinder()(unit), unit.querySelector('.MarkdownRoot-example'));
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
