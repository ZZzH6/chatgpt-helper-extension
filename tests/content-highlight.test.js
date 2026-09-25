const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-helper-extension', 'styles.css'), 'utf8');

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

test('selected messages receive persistent outlines and clear them when deselected', () => {
  const start = source.indexOf('  function updateSelectedMessageClasses() {');
  const end = source.indexOf('  function updateMessageListSelectionState() {', start);
  assert.ok(start >= 0 && end > start);
  const { document, window } = parseHTML('<body><div id="message">Answer</div></body>');
  const message = document.querySelector('#message');
  const selectedMessageSignatures = new Set(['assistant:answer']);
  const selectedMessageOutlines = new Map();
  let removed = 0;
  const createMessageOutline = () => ({ node: null, element: { remove: () => { removed += 1; } } });
  const update = new Function(
    'currentMessages', 'selectedMessageSignatures', 'exportSelectionMode', 'selectedMessageOutlines',
    'HTMLElement', 'createMessageOutline', 'removeMessageOutline', 'ensureMessageOutlineTracking', 'scheduleMessageOutlineUpdate',
    `${source.slice(start, end)} return updateSelectedMessageClasses;`
  )([{ node: message, signature: 'assistant:answer' }], selectedMessageSignatures, true,
    selectedMessageOutlines, window.HTMLElement, createMessageOutline, outline => outline.element.remove(), () => {}, () => {});

  update();
  assert.equal(selectedMessageOutlines.get('assistant:answer').node, message);
  assert.equal(message.classList.contains('cgh-export-selected'), true);

  selectedMessageSignatures.clear();
  update();
  assert.equal(selectedMessageOutlines.size, 0);
  assert.equal(removed, 1);
  assert.equal(message.classList.contains('cgh-export-selected'), false);
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
