const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseHTML, Element } = require('linkedom');

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
