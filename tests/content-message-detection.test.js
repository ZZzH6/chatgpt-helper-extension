const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js'), 'utf8');
const start = source.indexOf('  function collectMessages() {');
const end = source.indexOf('  function dedupeNodes(nodes) {', start);
const dedupeEnd = source.indexOf('  function inferRole(node) {', end);
const inferEnd = source.indexOf('  function extractTextWithLatex(root) {', dedupeEnd);
assert.ok(start >= 0 && end > start && dedupeEnd > end && inferEnd > dedupeEnd);

function collect(document, pathname = '/c/example') {
  const run = new Function('document', 'location', `
    let navigationSource = 'none';
    const inferredMessageRoles = new WeakMap();
    const MESSAGE_SELECTORS = ['section[data-turn]', '[data-message-author-role]', '[data-message-id]'];
    const normalizeWhitespace = text => text.replace(/\\s+/g, ' ').trim();
    const extractTextWithLatex = node => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('button').forEach(button => button.remove());
      return normalizeWhitespace(clone.textContent || '');
    };
    const hasExportableImages = () => false;
    const buildMessageSignature = (_node, role, text) => role + ':' + text;
    ${source.slice(start, dedupeEnd)}
    ${source.slice(dedupeEnd, inferEnd)}
    return { messages: collectMessages(), navigationSource };
  `);
  return run(document, { pathname });
}

test('conversation navigation uses paragraph fallback when ChatGPT has no message attributes', () => {
  const { document } = parseHTML(`
    <main><div><p>First visible answer</p><p>Second visible answer</p></div>
      <form><p>Composer placeholder</p></form></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.deepEqual(messages.map(message => message.text), ['First visible answer', 'Second visible answer']);
  assert.deepEqual(messages.map(message => message.role), ['unknown', 'unknown']);
  assert.equal(navigationSource, 'main text');
});

test('conversation navigation uses copy actions to recover a whole message', () => {
  const { document } = parseHTML(`
    <main><div class="answer"><div>One complete answer</div>
      <div class="toolbar"><button data-testid="copy-turn-action-button">Copy</button></div>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /One complete answer/);
  assert.equal(navigationSource, 'copy actions');
});

test('conversation navigation does not treat the ChatGPT home page as a conversation', () => {
  const { document } = parseHTML('<main><p>Welcome to ChatGPT</p></main>');
  assert.equal(collect(document, '/').messages.length, 0);
});

test('conversation navigation includes direct text beside formatted paragraphs', () => {
  const { document } = parseHTML('<main><div><p>Formatted paragraph</p><div>Direct answer text</div></div></main>');
  assert.deepEqual(collect(document).messages.map(message => message.text), ['Formatted paragraph', 'Direct answer text']);
});

test('conversation navigation separates a user bubble from its assistant answer', () => {
  const { document } = parseHTML(`
    <main><div class="exchange">
      <div class="user"><div class="whitespace-pre-wrap">What is a stationary point?</div>
        <button data-testid="copy-turn-action-button">Copy</button></div>
      <div class="assistant"><p>A stationary point has a zero first derivative.</p></div>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);

  assert.equal(navigationSource, 'copy actions');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(messages.map(message => message.text), [
    'What is a stationary point?',
    'A stationary point has a zero first derivative.',
  ]);
  assert.equal(messages[0].node.className, 'user');
  assert.equal(messages[1].node.className, 'assistant');
});

test('conversation navigation splits an exchange when the copy action is on its outer wrapper', () => {
  const { document } = parseHTML(`
    <main><div class="exchange">
      <div class="user"><div class="whitespace-pre-wrap">Why is zero not enough?</div></div>
      <div class="assistant"><p>A zero derivative alone does not prove an extremum.</p></div>
      <div class="toolbar"><button data-testid="copy-turn-action-button">Copy</button></div>
    </div></main>
  `);
  const { messages } = collect(document);

  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0].node.className, 'user');
  assert.equal(messages[1].node.className, 'assistant');
});
