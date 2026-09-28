const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'styles.css'), 'utf8');

test('export panel shows history with only message selection and three exports', () => {
  const match = source.match(/panel\.innerHTML = `([\s\S]*?)`;/);
  assert.ok(match, 'toolbar markup should be present');
  const { document } = parseHTML(`<body>${match[1]}</body>`);
  const actions = [...document.querySelectorAll('[data-action]')].map(button => button.getAttribute('data-action'));

  assert.deepEqual(actions, ['panel-toggle', 'export-select', 'export-png', 'export-markdown', 'export-print-pdf']);
  assert.equal(document.querySelector('.cgh-title')?.textContent, '消息导出');
  assert.equal(document.querySelector('.cgh-history-label')?.textContent, '历史对话');
  assert.ok(document.querySelector('#cgh-list'));
  assert.equal(document.querySelector('[data-action="panel-toggle"]')?.textContent, '展开');
  assert.equal(document.querySelector('[data-action="panel-toggle"]')?.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[data-action="export-select"]')?.getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('#cgh-export-status')?.getAttribute('aria-live'), 'polite');
  assert.doesNotMatch(source, /data-action="(?:refresh|toggle|select-all|jump-message)"|#cgh-search|function renderTimeline\(/);
});

test('panel toggle collapses only history and export controls', () => {
  const start = source.indexOf('  function setPanelCollapsed(collapsed) {');
  const end = source.indexOf('  function ensureFormulaUi() {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML(`
    <body><div id="cgh-panel"><div class="cgh-header"><div class="cgh-title">消息导出</div>
      <button data-action="panel-toggle"></button></div><div class="cgh-history-label">历史对话</div>
      <div class="cgh-list"></div><div class="cgh-export"></div></div></body>
  `);
  const panel = document.querySelector('#cgh-panel');
  const setCollapsed = new Function('panel', 'HTMLButtonElement', `
    let panelCollapsed = false;
    ${source.slice(start, end)}
    return setPanelCollapsed;
  `)(panel, window.HTMLButtonElement);

  setCollapsed(true);
  assert.equal(panel.classList.contains('cgh-collapsed'), true);
  assert.equal(panel.querySelector('[data-action="panel-toggle"]').textContent, '展开');
  assert.equal(panel.querySelector('[data-action="panel-toggle"]').getAttribute('aria-expanded'), 'false');
  assert.equal(panel.querySelector('.cgh-title').textContent, '消息导出');

  setCollapsed(false);
  assert.equal(panel.classList.contains('cgh-collapsed'), false);
  assert.equal(panel.querySelector('[data-action="panel-toggle"]').textContent, '收起');
  assert.equal(panel.querySelector('[data-action="panel-toggle"]').getAttribute('aria-expanded'), 'true');
});

test('history displays separate messages and reflects export selection', () => {
  const renderStart = source.indexOf('  function renderMessageList() {');
  const renderEnd = source.indexOf('  function updateExportUi() {', renderStart);
  const stateStart = source.indexOf('  function updateMessageListSelectionState() {');
  const stateEnd = source.indexOf('  function updateSelectedMessageClasses() {', stateStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart && stateStart >= 0 && stateEnd > stateStart);

  const { document } = parseHTML('<body><div id="cgh-list"></div></body>');
  const messageList = document.querySelector('#cgh-list');
  const currentMessages = [
    { role: 'user', text: '<b>原问题</b>', signature: 'user-1' },
    { role: 'assistant', text: '第一条回答', signature: 'assistant-1' },
    { role: 'assistant', text: '第一条回答', signature: 'assistant-2' },
  ];
  const selectedMessageSignatures = new Set(['assistant-2']);
  const render = new Function('messageList', 'currentMessages', 'escapeHtml', `
    let renderedMessageListKey = null;
    ${source.slice(renderStart, renderEnd)}
    return renderMessageList;
  `)(messageList, currentMessages, value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const update = new Function('messageList', 'currentMessages', 'selectedMessageSignatures', `
    ${source.slice(stateStart, stateEnd)}
    return updateMessageListSelectionState;
  `)(messageList, currentMessages, selectedMessageSignatures);

  render();
  update();
  const rows = [...messageList.querySelectorAll('[data-action="select-listed-message"]')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.cgh-role').textContent, '你');
  assert.equal(rows[1].querySelector('.cgh-role').textContent, 'GPT');
  assert.equal(rows[0].querySelector('b'), null, 'message text must be escaped');
  assert.equal(rows[2].getAttribute('aria-pressed'), 'true');
  assert.equal(rows[1].getAttribute('aria-pressed'), 'false');

  render();
  assert.equal(messageList.querySelector('[data-message-index="0"]'), rows[0], 'unchanged refresh keeps list focus');

  currentMessages.push({ role: 'user', text: '后续问题', signature: 'user-2' });
  render();
  assert.equal(messageList.querySelectorAll('[data-action="select-listed-message"]').length, 4);

  selectedMessageSignatures.clear();
  selectedMessageSignatures.add('assistant-1');
  update();
  assert.equal(messageList.querySelector('[data-message-index="1"]').getAttribute('aria-pressed'), 'true');
  assert.equal(messageList.querySelector('[data-message-index="2"]').getAttribute('aria-pressed'), 'false');
});

test('clicking a history preview selects its message', () => {
  const start = source.indexOf('  function createPanel() {');
  const end = source.indexOf('  function ensureFormulaUi() {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body></body>');
  const selected = [];
  const panel = new Function('document', 'HTMLElement', 'HTMLButtonElement', 'selected', `
    let panel = null;
    let messageList = null;
    let renderedMessageListKey = null;
    let panelCollapsed = false;
    let exportSelectionMode = false;
    const toggleMessageSelection = index => selected.push(index);
    const setExportSelectionMode = () => {};
    const exportSelectedMessages = () => {};
    const ensureExportSelectionListener = () => {};
    ${source.slice(start, end)}
    createPanel();
    return panel;
  `)(document, window.HTMLElement, window.HTMLButtonElement, selected);
  panel.querySelector('#cgh-list').innerHTML = '<button data-action="select-listed-message" data-message-index="2"><span>回答摘要</span></button>';
  panel.querySelector('#cgh-list span').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(selected, [2]);
});

test('panel mutations do not rescan the conversation, while message edits do', () => {
  const start = source.indexOf('  function observeDom() {');
  const end = source.indexOf('  function scheduleRefresh() {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<html><body><main><div class="prose"><p>回答</p></div><form><div contenteditable="true"><p>草稿</p></div></form></main><div id="cgh-panel"><span>状态</span></div></body></html>');
  let callback;
  let refreshes = 0;
  const MutationObserver = class {
    constructor(handler) { callback = handler; }
    observe() {}
  };
  const observe = new Function('document', 'Element', 'Node', 'MutationObserver', 'scheduleRefresh', `
    let observer = null;
    const MESSAGE_SELECTORS = ['[data-message-author-role]'];
    const FORMULA_SELECTORS = '.katex';
    ${source.slice(start, end)}
    return observeDom;
  `)(document, window.Element, window.Node, MutationObserver, () => { refreshes += 1; });
  observe();

  callback([{ type: 'characterData', target: document.querySelector('#cgh-panel span').firstChild }]);
  assert.equal(refreshes, 0);
  callback([{ type: 'characterData', target: document.querySelector('form p').firstChild }]);
  assert.equal(refreshes, 0);
  callback([{ type: 'characterData', target: document.querySelector('main p').firstChild }]);
  assert.equal(refreshes, 1);

  const outline = document.createElement('div');
  outline.className = 'cgh-message-outline';
  document.querySelector('main').appendChild(outline);
  callback([{ type: 'childList', target: document.querySelector('main'), addedNodes: [outline], removedNodes: [] }]);
  assert.equal(refreshes, 1);

  const answer = document.createElement('p');
  answer.textContent = '新消息';
  document.querySelector('main').appendChild(answer);
  callback([{ type: 'childList', target: document.querySelector('main'), addedNodes: [answer], removedNodes: [] }]);
  assert.equal(refreshes, 2);
});

test('periodic check only rescans after conversation changes', async () => {
  const start = source.indexOf('  async function init() {');
  const end = source.indexOf('  function attachStorageListener() {', start);
  assert.ok(start >= 0 && end > start);
  let interval;
  let refreshes = 0;
  let key = 'conversation-a';
  const init = new Function('chrome', 'setInterval', 'getConversationKey', 'scheduleRefresh', `
    const DEFAULTS = {};
    let settings;
    const activeConversationKey = 'conversation-a';
    const normalizeSettings = value => value;
    const createPanel = () => {};
    const ensureFormulaUi = () => {};
    const applyReadingSettings = () => {};
    const observeDom = () => {};
    const attachStorageListener = () => {};
    const attachSettingsMessageListener = () => {};
    const startDraftSave = () => {};
    ${source.slice(start, end)}
    return init;
  `)({ storage: { sync: { get: async () => ({}) } } }, callback => { interval = callback; },
    () => key, () => { refreshes += 1; });
  await init();
  assert.equal(refreshes, 1);
  interval();
  assert.equal(refreshes, 1);
  key = 'conversation-b';
  interval();
  assert.equal(refreshes, 2);
});

test('draft input observer skips unrelated long-page mutations', () => {
  const start = source.indexOf('  function startDraftSave() {');
  const end = source.indexOf('  function handleDraftSendKey(event) {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<html><body><main></main><div id="prompt-textarea" contenteditable="true"></div></body></html>');
  let callback;
  let lookups = 0;
  const MutationObserver = class {
    constructor(handler) { callback = handler; }
    observe() {}
  };
  const startDraft = new Function('document', 'window', 'Element', 'MutationObserver', 'attachDraftInput', `
    let draftObserver = null;
    const draftInput = document.querySelector('#prompt-textarea');
    const COMPOSER_SELECTORS = '#prompt-textarea';
    const saveDraftNow = () => {};
    const handleDraftSendKey = () => {};
    const handleDraftSendClick = () => {};
    const restoreDraft = () => {};
    ${source.slice(start, end)}
    return startDraftSave;
  `)(document, window, window.Element, MutationObserver, () => { lookups += 1; });
  startDraft();
  assert.equal(lookups, 1);

  const paragraph = document.createElement('p');
  paragraph.textContent = '新回答';
  document.querySelector('main').appendChild(paragraph);
  callback([{ addedNodes: [paragraph] }]);
  assert.equal(lookups, 1);

  document.querySelector('#prompt-textarea').remove();
  callback([{ addedNodes: [], removedNodes: [] }]);
  assert.equal(lookups, 2, 'a removed composer should trigger a replacement lookup');
});

test('clicking a chat message in selection mode toggles that message', () => {
  const start = source.indexOf('  function handleExportSelectionClick(event) {');
  const end = source.indexOf('  function setExportSelectionMode(enabled', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body><main><article><p>Answer text</p></article></main><div id="cgh-panel"></div></body>');
  const message = document.querySelector('article');
  const toggled = [];
  const handler = new Function('document', 'Element', 'toggled', `
    let exportSelectionMode = true;
    const currentMessages = [{ node: document.querySelector('article') }];
    const toggleMessageSelection = index => toggled.push(index);
    ${source.slice(start, end)}
    return handleExportSelectionClick;
  `)(document, window.Element, toggled);
  const event = {
    target: message.querySelector('p'),
    preventDefault() {},
    stopPropagation() {},
  };

  handler(event);
  assert.deepEqual(toggled, [0]);
  handler({ ...event, target: document.querySelector('#cgh-panel') });
  assert.deepEqual(toggled, [0], 'toolbar clicks should not select chat messages');
});

test('clicking the last fragment of a long answer selects the full message', () => {
  const start = source.indexOf('  function handleExportSelectionClick(event) {');
  const end = source.indexOf('  function setExportSelectionMode(enabled', start);
  const { document, window } = parseHTML('<body><main><p id="first">开头</p><p id="last">结尾</p></main></body>');
  const currentMessages = [{ node: document.querySelector('#first'), contentNodes: [
    document.querySelector('#first'), document.querySelector('#last')
  ] }];
  const toggled = [];
  const handler = new Function('Element', 'currentMessages', 'toggled', `
    let exportSelectionMode = true;
    const toggleMessageSelection = index => toggled.push(index);
    ${source.slice(start, end)}
    return handleExportSelectionClick;
  `)(window.Element, currentMessages, toggled);
  handler({ target: document.querySelector('#last'), preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(toggled, [0]);
});

test('entering selection mode scans messages before the next immediate page click', () => {
  const selectStart = source.indexOf('  function setExportSelectionMode(enabled', 0);
  const selectEnd = source.indexOf('  function toggleMessageSelection(', selectStart);
  const clickStart = source.indexOf('  function handleExportSelectionClick(event) {');
  const clickEnd = source.indexOf('  function setExportSelectionMode(enabled', clickStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart && clickStart >= 0 && clickEnd > clickStart);

  const { document, window } = parseHTML('<body><main><article><p>Freshly loaded answer</p></article></main></body>');
  const message = document.querySelector('article');
  const toggled = [];
  const flow = new Function('document', 'Element', 'message', 'toggled', `
    let exportSelectionMode = false;
    let currentMessages = [];
    const selectedMessageSignatures = new Set();
    const syncConversationState = () => {};
    const collectMessages = () => [{ node: message, signature: 'fresh-answer' }];
    const syncSelectedMessagesWithCurrent = () => {};
    const renderMessageList = () => {};
    const clearHoveredMessageOutline = () => {};
    const updateExportUi = () => {};
    const showToast = () => {};
    const toggleMessageSelection = index => toggled.push(currentMessages[index]?.signature);
    ${source.slice(selectStart, selectEnd)}
    ${source.slice(clickStart, clickEnd)}
    return { enter: () => setExportSelectionMode(true), click: handleExportSelectionClick };
  `)(document, window.Element, message, toggled);

  flow.enter();
  flow.click({
    target: message.querySelector('p'),
    preventDefault() {},
    stopPropagation() {},
  });

  assert.deepEqual(toggled, ['fresh-answer']);
});

test('toolbar reports selection count and enables exports only when messages are selected', () => {
  const start = source.indexOf('  function updateExportUi() {');
  const end = source.indexOf('  function updateSelectedMessageClasses() {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML(`
    <body><div id="cgh-panel"><button data-action="export-select"></button>
      <button data-action="export-png"></button><button data-action="export-markdown"></button>
      <button data-action="export-print-pdf"></button><div id="cgh-export-status"></div>
    </div></body>
  `);
  const panel = document.querySelector('#cgh-panel');
  const selectedMessageSignatures = new Set();
  const update = new Function('panel', 'messageList', 'selectedMessageSignatures', 'exportSelectionMode', 'exportRendering', 'activeExportFormat', 'updateSelectedMessageClasses', 'HTMLButtonElement', `
    ${source.slice(start, end)}
    return updateExportUi;
  `)(panel, null, selectedMessageSignatures, false, false, null, () => {}, window.HTMLButtonElement);

  update();
  for (const button of panel.querySelectorAll('[data-action^="export-"]:not([data-action="export-select"])')) {
    assert.equal(button.disabled, true);
  }
  assert.equal(panel.querySelector('#cgh-export-status').textContent, '未选择消息');

  selectedMessageSignatures.add('one');
  selectedMessageSignatures.add('two');
  update();
  for (const action of ['export-png', 'export-markdown', 'export-print-pdf']) {
    assert.equal(panel.querySelector(`[data-action="${action}"]`).disabled, false);
  }
  assert.equal(panel.querySelector('#cgh-export-status').textContent, '已选择 2 条');
});

test('message outline is anchored to the page rather than the viewport', () => {
  assert.match(styles, /\.cgh-message-outline\s*\{\s*position:\s*absolute\s*;/);
});

test('message outline includes text that visually extends past its wrapper', () => {
  const start = source.indexOf('  function getMessageOutlineRect(node) {');
  const end = source.indexOf('  function positionMessageOutline(outline) {', start);
  assert.ok(start >= 0 && end > start);
  const { document } = parseHTML('<body><div id="message"><p>Answer</p></div></body>');
  const message = document.querySelector('#message');
  const paragraph = message.querySelector('p');
  message.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 300, width: 400, height: 200 });
  paragraph.getBoundingClientRect = () => ({ left: 110, top: 120, right: 490, bottom: 320, width: 380, height: 200 });
  const getRect = new Function(`${source.slice(start, end)} return getMessageOutlineRect;`)();
  assert.equal(getRect(message).bottom, 320);
});

test('long ChatGPT message units use their own layout bounds', () => {
  const start = source.indexOf('  function getMessageOutlineRect(node) {');
  const end = source.indexOf('  function positionMessageOutline(outline) {', start);
  const { document } = parseHTML('<body><div data-content-search-unit-key="fallback-turn-1:2:assistant"><p>长回答</p></div></body>');
  const unit = document.querySelector('[data-content-search-unit-key]');
  const bounds = { left: 50, top: 80, right: 650, bottom: 5000, width: 600, height: 4920 };
  unit.getBoundingClientRect = () => bounds;
  unit.querySelector('p').getBoundingClientRect = () => { throw new Error('unnecessary descendant layout read'); };
  const getRect = new Function(`${source.slice(start, end)} return getMessageOutlineRect;`)();
  assert.equal(getRect(unit), bounds);
});

test('message outline stays anchored inside a scrolling message container', () => {
  const start = source.indexOf('  function createMessageOutline(kind) {');
  const end = source.indexOf('  function setReadingStyle(element, property, value) {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body><div id="scroller"><div id="message"><p>First</p><p>Second</p></div></div></body>');
  const scroller = document.querySelector('#scroller');
  const message = document.querySelector('#message');
  const [first, second] = message.querySelectorAll('p');
  let innerScrollY = 0;
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  scroller.clientTop = 0;
  scroller.clientLeft = 0;
  scroller.getBoundingClientRect = () => ({ left: 50, top: 50, right: 650, bottom: 550, width: 600, height: 500 });
  message.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  first.getBoundingClientRect = () => ({ left: 100, top: 120 - innerScrollY, right: 500, bottom: 150 - innerScrollY, width: 400, height: 30 });
  second.getBoundingClientRect = () => ({ left: 110, top: 400 - innerScrollY, right: 510, bottom: 430 - innerScrollY, width: 400, height: 30 });
  window.getComputedStyle = () => ({ position: 'static', display: 'block' });

  const helpers = new Function('document', 'window', `
    const messageOutlineAnchors = new WeakMap();
    ${source.slice(start, end)}
    return { createMessageOutline, positionMessageOutline, removeMessageOutline };
  `)(document, window);
  const outline = helpers.createMessageOutline('cgh-selected-outline');
  outline.node = message;
  helpers.positionMessageOutline(outline);

  assert.equal(outline.element.hidden, false);
  assert.equal(outline.element.parentElement, scroller);
  assert.equal(scroller.style.position, 'relative');
  assert.equal(outline.element.style.left, '45px');
  assert.equal(outline.element.style.top, '65px');
  assert.equal(outline.element.style.width, '420px');
  assert.equal(outline.element.style.height, '320px');

  innerScrollY = 200;
  scroller.scrollTop = 200;
  helpers.positionMessageOutline(outline);
  assert.equal(outline.element.style.top, '65px');
  assert.equal(outline.element.style.height, '320px');

  const secondOutline = helpers.createMessageOutline('cgh-hover-outline');
  secondOutline.node = message;
  helpers.positionMessageOutline(secondOutline);
  helpers.removeMessageOutline(outline);
  assert.equal(scroller.style.position, 'relative');
  helpers.removeMessageOutline(secondOutline);
  assert.ok(!scroller.style.position);
  assert.equal(outline.element.isConnected, false);
});

test('one outline spans all fragments of a grouped answer', () => {
  const start = source.indexOf('  function createMessageOutline(kind) {');
  const end = source.indexOf('  function setReadingStyle(element, property, value) {', start);
  const { document, window } = parseHTML('<body><div id="scroller"><p id="first">开头</p><p id="last">结尾</p></div></body>');
  const scroller = document.querySelector('#scroller');
  const first = document.querySelector('#first');
  const last = document.querySelector('#last');
  scroller.scrollTop = scroller.scrollLeft = scroller.clientTop = scroller.clientLeft = 0;
  scroller.getBoundingClientRect = () => ({ left: 50, top: 50, right: 650, bottom: 550, width: 600, height: 500 });
  first.getBoundingClientRect = () => ({ left: 100, top: 120, right: 500, bottom: 150, width: 400, height: 30 });
  last.getBoundingClientRect = () => ({ left: 110, top: 420, right: 510, bottom: 450, width: 400, height: 30 });
  window.getComputedStyle = () => ({ position: 'static', display: 'block' });
  const helpers = new Function('document', 'window', `
    const messageOutlineAnchors = new WeakMap();
    ${source.slice(start, end)}
    return { createMessageOutline, positionMessageOutline };
  `)(document, window);
  const outline = helpers.createMessageOutline('cgh-selected-outline');
  outline.node = first;
  outline.nodes = [first, last];
  helpers.positionMessageOutline(outline);
  assert.equal(outline.element.parentElement, scroller);
  assert.equal(outline.element.style.top, '65px');
  assert.equal(outline.element.style.width, '420px');
  assert.equal(outline.element.style.height, '340px');
});

test('selected messages receive persistent outlines and clear them when deselected', () => {
  const start = source.indexOf('  function updateSelectedMessageClasses() {');
  const end = source.indexOf('  async function exportSelectedMessages(', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body><div id="message">Answer</div><div id="later">Later answer</div></body>');
  const message = document.querySelector('#message');
  const later = document.querySelector('#later');
  const selectedMessageSignatures = new Set(['assistant:answer']);
  const selectedMessageOutlines = new Map();
  let removed = 0;
  const createMessageOutline = () => ({ node: null, element: { remove: () => { removed += 1; } } });
  const update = new Function(
    'currentMessages', 'selectedMessageSignatures', 'exportSelectionMode', 'selectedMessageOutlines',
    'HTMLElement', 'createMessageOutline', 'removeMessageOutline', 'ensureMessageOutlineTracking', 'scheduleMessageOutlineUpdate',
    `${source.slice(start, end)} return updateSelectedMessageClasses;`
  )([{ node: message, contentNodes: [message, later], signature: 'assistant:answer' }], selectedMessageSignatures, true,
    selectedMessageOutlines, window.HTMLElement, createMessageOutline, outline => outline.element.remove(), () => {}, () => {});

  update();
  assert.equal(selectedMessageOutlines.get('assistant:answer').node, message);
  assert.deepEqual(selectedMessageOutlines.get('assistant:answer').nodes, [message, later]);
  assert.equal(message.classList.contains('cgh-export-selected'), true);
  assert.equal(later.classList.contains('cgh-export-selected'), true);

  selectedMessageSignatures.clear();
  update();
  assert.equal(selectedMessageOutlines.size, 0);
  assert.equal(removed, 1);
  assert.equal(message.classList.contains('cgh-export-selected'), false);
  assert.equal(later.classList.contains('cgh-export-selected'), false);
});

test('hover outline follows only the current unselected message', () => {
  const start = source.indexOf('  function handleExportSelectionPointerOver(event) {');
  const end = source.indexOf('  function handleExportSelectionClick(event) {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body><div id="user"><span>Question</span></div><div id="assistant"><span>Answer</span></div></body>');
  const user = document.querySelector('#user');
  const assistant = document.querySelector('#assistant');
  const selectedMessageSignatures = new Set();
  let created = 0;
  const createMessageOutline = () => {
    created += 1;
    return { node: null, element: { remove: () => {} } };
  };
  const handlers = new Function(
    'Element', 'currentMessages', 'selectedMessageSignatures', 'createMessageOutline',
    'removeMessageOutline', 'ensureMessageOutlineTracking', 'scheduleMessageOutlineUpdate',
    `let exportSelectionMode = true;
    let hoveredMessageOutline = null;
    ${source.slice(start, end)} return {
      over: handleExportSelectionPointerOver,
      out: handleExportSelectionPointerOut,
      current: () => hoveredMessageOutline,
    };`
  )(window.Element, [
    { node: user, signature: 'user' },
    { node: assistant, signature: 'assistant' },
  ], selectedMessageSignatures, createMessageOutline, outline => outline.element.remove(), () => {}, () => {});

  handlers.over({ target: user.querySelector('span') });
  assert.equal(handlers.current().node, user);
  handlers.out({ target: user.querySelector('span'), relatedTarget: user });
  assert.equal(handlers.current().node, user);

  handlers.over({ target: assistant.querySelector('span') });
  assert.equal(handlers.current().node, assistant);
  assert.equal(created, 1);

  selectedMessageSignatures.add('assistant');
  handlers.over({ target: assistant.querySelector('span') });
  assert.equal(handlers.current(), null);
});
