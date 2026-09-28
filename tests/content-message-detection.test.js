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
    const messageTextCache = new WeakMap();
    const MESSAGE_SELECTORS = [
      'section[data-turn="user"]',
      'section[data-turn="assistant"]',
      '[data-message-author-role]',
      '[data-testid="conversation-turn"]',
      '[data-testid^="conversation-turn-"]',
    ];
    const normalizeWhitespace = text => text.replace(/\\s+/g, ' ').trim();
    const extractTextWithLatex = node => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('button, .sr-only').forEach(button => button.remove());
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

test('unmarked paragraphs are not treated as separate exportable messages', () => {
  const { document } = parseHTML(`
    <main><div><p>First visible answer</p><p>Second visible answer</p></div>
      <form><p>Composer placeholder</p></form></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.deepEqual(messages, []);
  assert.equal(navigationSource, 'none');
});

test('message collection uses copy actions to recover a whole message', () => {
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

test('message collection does not treat the ChatGPT home page as a conversation', () => {
  const { document } = parseHTML('<main><p>Welcome to ChatGPT</p></main>');
  assert.equal(collect(document, '/').messages.length, 0);
});

test('an unmarked prose body keeps paragraphs and direct text in one message', () => {
  const { document } = parseHTML('<main><div class="prose"><p>Formatted paragraph</p><div>Direct answer text</div></div></main>');
  const { messages, navigationSource } = collect(document);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Formatted paragraph/);
  assert.match(messages[0].text, /Direct answer text/);
  assert.equal(navigationSource, 'message body');
});

test('message collection separates a user bubble from its assistant answer', () => {
  const { document } = parseHTML(`
    <main><div class="exchange">
      <div class="user"><div class="whitespace-pre-wrap">What is a stationary point?</div>
        <button data-testid="copy-turn-action-button">Copy</button></div>
      <div class="assistant"><p>A stationary point has a zero first derivative.</p></div>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);

  assert.equal(navigationSource, 'user turns');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(messages.map(message => message.text), [
    'What is a stationary point?',
    'A stationary point has a zero first derivative.',
  ]);
  assert.equal(messages[0].node.className, 'whitespace-pre-wrap');
  assert.equal(messages[1].node.className, 'assistant');
});

test('message collection splits an exchange when the copy action is on its outer wrapper', () => {
  const { document } = parseHTML(`
    <main><div class="exchange">
      <div class="user"><div class="whitespace-pre-wrap">Why is zero not enough?</div></div>
      <div class="assistant"><p>A zero derivative alone does not prove an extremum.</p></div>
      <div class="toolbar"><button data-testid="copy-turn-action-button">Copy</button></div>
    </div></main>
  `);
  const { messages } = collect(document);

  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0].node.className, 'whitespace-pre-wrap');
  assert.equal(messages[1].node.className, 'assistant');
});

test('message collection recognizes the current conversation-turn wrapper and prose body', () => {
  const { document } = parseHTML(`
    <main><div data-testid="conversation-turn-42">
      <div data-message-author-role="assistant"><div class="prose"><p>完整回答的第一段。</p><pre><code>const answer = 42;</code></pre><p>完整回答的最后一段。</p></div></div>
    </div></main>
  `);
  const { messages } = collect(document);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.match(messages[0].text, /完整回答的第一段/);
  assert.match(messages[0].text, /完整回答的最后一段/);
  assert.equal(messages[0].node.getAttribute('data-testid'), 'conversation-turn-42');
});

test('copy actions with current-style identifiers recover a whole response', () => {
  const { document } = parseHTML(`
    <main><div class="response-shell">
      <div class="prose"><p>第一段。</p><pre><code>const answer = 42;</code></pre><p>第二段。</p></div>
      <div class="toolbar"><div data-testid="copy-response-action">复制</div></div>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);

  assert.equal(navigationSource, 'copy actions');
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /第一段/);
  assert.match(messages[0].text, /第二段/);
  assert.match(messages[0].text, /const answer = 42/);
});

test('a response action collapses nested fragment anchors into one exportable message', () => {
  const { document } = parseHTML(`
    <main><div class="response-shell">
      <div data-message-id="fragment-1">第一段</div>
      <div data-message-id="fragment-2"><pre><code>纯文本</code></pre></div>
      <div data-message-id="fragment-3">最后一段</div>
      <button data-testid="copy-response-action">复制</button>
    </div></main>
  `);
  const { messages } = collect(document);

  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /第一段/);
  assert.match(messages[0].text, /最后一段/);
  assert.match(messages[0].text, /纯文本/);
});

test('repeated complete message bodies receive distinct selection signatures', () => {
  const { document } = parseHTML(`
    <main><div class="prose"><p>纯文本</p></div><div class="prose"><p>纯文本</p></div></main>
  `);
  const { messages } = collect(document);

  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].signature, messages[1].signature);
});

test('one long response with table and code tools remains a single message', () => {
  const { document } = parseHTML(`
    <main><div class="response-shell">
      <div class="prose">
        <h2>这组 11～21 真正要留下的东西</h2>
        <p>完整回答的开头。</p>
        <div class="code-block"><div><span>纯文本</span><button aria-label="复制代码">复制代码</button></div><pre><code>int value = 11;</code></pre></div>
        <table><tr><td>11</td><td>冯·诺依曼</td></tr></table>
        <div class="code-block"><div><span>纯文本</span><button title="Copy">Copy</button></div><pre><code>int value = 21;</code></pre></div>
        <p>完整回答的结尾。</p>
      </div>
      <div class="toolbar"><button data-testid="copy-response-action">复制</button></div>
    </div></main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].node.className, 'response-shell');
  assert.equal(messages[0].role, 'assistant');
  assert.match(messages[0].text, /完整回答的开头/);
  assert.match(messages[0].text, /完整回答的结尾/);
  assert.match(messages[0].text, /冯·诺依曼/);
});

test('a code block Copy button is not mistaken for a message action', () => {
  const { document } = parseHTML(`
    <main><div class="prose"><p>回答开头</p>
      <div class="code-block"><button title="Copy">Copy</button><pre><code>const value = 1;</code></pre></div>
      <p>回答结尾</p></div></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.equal(messages.length, 1);
  assert.equal(navigationSource, 'message body');
  assert.match(messages[0].text, /回答结尾/);
});

test('whole turn anchors take priority over nested copy actions', () => {
  const { document } = parseHTML(`
    <main><div data-testid="conversation-turn-1" data-message-author-role="assistant">
      <div class="prose"><p>第一段</p><pre><code>纯文本</code></pre><p>第二段</p></div>
      <button data-testid="copy-response-action">复制</button>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(navigationSource, 'message anchors');
});

test('an unmarked assistant response remains exportable beside a marked user turn', () => {
  const { document } = parseHTML(`
    <main><div data-message-author-role="user">请解释缓存命中率</div>
      <div class="response-shell"><div class="prose"><p>完整解释。</p><pre><code>hits / total</code></pre></div>
        <button data-testid="copy-response-action">复制</button></div>
    </main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[1].text, /hits \/ total/);
});

test('shared conversation routes can use complete message anchors', () => {
  const { document } = parseHTML('<main><article data-testid="conversation-turn-1" data-message-author-role="assistant"><div class="prose"><p>分享内容</p></div></article></main>');
  assert.equal(collect(document, '/s/t_example').messages.length, 1);
});

test('a thinking summary and its long answer form one assistant message', () => {
  const { document } = parseHTML(`
    <main><div class="exchange">
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">继续计算机组成原理部分</div></div>
      <div class="assistant-turn">
        <div class="assistant-lead"><article data-testid="conversation-turn-4"><div data-message-author-role="assistant">思考了 28m 1s</div></article>
          <div class="prose"><p>继续按滚动复习模式。</p></div></div>
        <div class="prose"><table><tr><td>第11题</td></tr></table><p>完整回答的结尾。</p></div>
      </div>
    </div></main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].node.className, 'assistant-turn');
  assert.match(messages[1].text, /完整回答的结尾/);
  assert.match(messages[1].previewText, /^继续按滚动复习模式/);
});

test('a complete response action replaces a short thinking anchor', () => {
  const { document } = parseHTML(`
    <main><div class="response-shell">
      <div data-message-author-role="assistant">思考了 28m 1s</div>
      <div class="answer"><p>这是一段很长的完整回答，包含前面的解释。</p><p>还有后面的总结与导出内容。</p></div>
      <button data-testid="copy-response-action">复制</button>
    </div></main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].node.className, 'response-shell');
  assert.match(messages[0].text, /后面的总结/);
});

test('user turns group a long answer spread across sibling nodes', () => {
  const { document } = parseHTML(`
    <main>
      <article data-testid="conversation-turn-0"><div data-message-author-role="user">讲解第 11 到 21 题</div></article>
      <article data-testid="conversation-turn-1"><div data-message-author-role="assistant">思考了 28m 1s</div></article>
      <div class="answer-first"><h2>第11题</h2><p>完整解释的前半段。</p></div>
      <div class="answer-last"><table><tr><td>21</td><td>命中率</td></tr></table><p>完整解释的结尾。</p></div>
      <article data-testid="conversation-turn-2"><div data-message-author-role="user">下一题</div></article>
      <article data-testid="conversation-turn-3"><div data-message-author-role="assistant"><p>简短回答。</p></div></article>
    </main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.equal(navigationSource, 'user turns');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[1].contentNodes.length, 4);
  assert.match(messages[1].text, /第11题/);
  assert.match(messages[1].text, /完整解释的结尾/);
  assert.doesNotMatch(messages[1].text, /思考了/);
  assert.doesNotMatch(messages[1].text, /简短回答/);
  assert.equal(messages[3].text, '简短回答。');
});

test('assistant whitespace blocks do not create extra user turns', () => {
  const { document } = parseHTML(`
    <main><div data-message-author-role="user">解释这段代码</div>
      <div data-message-author-role="assistant"><div class="prose"><p>完整回答</p>
        <span class="whitespace-pre-wrap">const value = 42;</span></div></div></main>
  `);
  const { messages } = collect(document);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.match(messages[1].text, /const value = 42/);
});

test('a thinking-state wrapper does not hide the finished answer', () => {
  const { document } = parseHTML(`
    <main><div data-message-author-role="user">继续复习</div>
      <div class="thinking-complete"><div data-message-author-role="assistant">思考了 28m 1s</div>
        <p>第11题的正式解答。</p><p>第21题的结论。</p></div></main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 2);
  assert.match(messages[1].text, /第11题的正式解答/);
  assert.match(messages[1].text, /第21题的结论/);
});

test('conversation thread excludes footer text from the last answer', () => {
  const { document } = parseHTML(`
    <main><div id="thread"><div data-message-author-role="user">最后一个问题</div>
      <div data-message-author-role="assistant"><p>正式回答。</p></div></div>
      <p>ChatGPT 可能会出错。请核查重要信息。</p></main>
  `);
  const { messages } = collect(document);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, '正式回答。');
});

test('unchanged messages reuse extracted text during later scans', () => {
  const start = source.indexOf('  function getMessageTextCached(node) {');
  const end = source.indexOf('  function mergeActionMessages(', start);
  assert.ok(start >= 0 && end > start);
  const { document } = parseHTML('<p>回答开头</p>');
  const message = document.querySelector('p');
  let extracts = 0;
  const getText = new Function('extractTextWithLatex', `
    const messageTextCache = new WeakMap();
    ${source.slice(start, end)}
    return getMessageTextCached;
  `)(node => { extracts += 1; return node.textContent; });
  assert.equal(getText(message), '回答开头');
  assert.equal(getText(message), '回答开头');
  assert.equal(extracts, 1);
  message.textContent = '回答结尾';
  assert.equal(getText(message), '回答结尾');
  assert.equal(extracts, 2);
});

test('ChatGPT search units separate the user bubble, thinking block, and long answer', () => {
  const { document } = parseHTML(`
    <main><div class="thread-scroll-container">
      <div class="turn">
        <div data-content-search-unit-key="fallback-turn-1:0:user"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">继续计算机组成原理部分</div></div></div>
        <div class="activity"><span data-chatgpt-agent-turn-start></span><button>思考了 28m 1s</button></div>
        <div data-content-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-search-unit-key="fallback-turn-1:2:assistant">
          <h4 class="sr-only">ChatGPT 说</h4><div data-markdown-text-style="assistant-message" class="MarkdownRoot-example">
            <p>继续按滚动复习模式。</p><table><tr><td>第11题</td></tr></table><p>完整回答的结尾。</p>
          </div>
        </div>
      </div>
    </div></main>
  `);
  const { messages, navigationSource } = collect(document);
  assert.equal(navigationSource, 'message units');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0].text, '继续计算机组成原理部分');
  assert.match(messages[1].text, /^继续按滚动复习模式/);
  assert.match(messages[1].text, /完整回答的结尾/);
  assert.doesNotMatch(messages[1].text, /继续计算机组成原理部分|思考了|ChatGPT 说/);
  assert.equal(messages[1].node.getAttribute('data-content-search-unit-key'), 'fallback-turn-1:2:assistant');
});

test('search unit list follows visual order when DOM turns are reversed', () => {
  const { document } = parseHTML(`
    <main><div data-content-search-unit-key="fallback-turn-2:0:user">第二轮用户</div>
      <div data-content-search-unit-key="fallback-turn-2:1:assistant">第二轮回答</div>
      <div data-content-search-unit-key="fallback-turn-1:0:user">第一轮用户</div>
      <div data-content-search-unit-key="fallback-turn-1:1:assistant">第一轮回答</div></main>
  `);
  const visualTops = [400, 500, 100, 200];
  [...document.querySelectorAll('[data-content-search-unit-key]')].forEach((node, index) => {
    node.getBoundingClientRect = () => ({ top: visualTops[index] });
  });
  const { messages } = collect(document);
  assert.deepEqual(messages.map(message => message.text), [
    '第一轮用户', '第一轮回答', '第二轮用户', '第二轮回答'
  ]);
});
