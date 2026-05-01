(() => {
  'use strict';

  const DEFAULTS = {
    warnThreshold: 30000,
    dangerThreshold: 60000,
    copyMode: 'latex',
    showPerMessage: true,
  };

  let settings = { ...DEFAULTS };
  let panel = null;
  let listContainer = null;
  let toastEl = null;
  let updateTimer = null;
  let observer = null;
  let storageListenerAdded = false;
  let formulaButton = null;
  let formulaMenu = null;
  let activeFormula = null;
  let hideFormulaTimer = null;
  let formulaListenersBound = false;
  let currentMessages = [];
  let highlightedMessageNode = null;
  let highlightedMessageTimer = null;
  let lastConversationMutationAt = performance.now();
  let jumpSequence = 0;
  let jumpRunning = false;
  let pendingJump = null;
  const boundFormulaNodes = new WeakSet();
  const CONVERSATION_READY_QUIET_MS = 500;
  const PRE_JUMP_SCROLL_IDLE_MS = 260;
  const PRE_JUMP_SCROLL_IDLE_TIMEOUT_MS = 2200;
  const AUTO_FOLLOW_ESCAPE_PX = 96;
  const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 80;
  const SCROLL_SETTLE_QUIET_MS = 180;
  const SCROLL_POSITION_EPSILON = 2;

  const MESSAGE_SELECTORS = [
    '[data-message-author-role]',
    'article[data-testid^="conversation-turn-"]',
    'main article',
    'main [role="article"]'
  ];

  const FORMULA_SELECTORS = [
    '.katex',
    'mjx-container',
    'math',
    '[data-tex]',
    '[data-latex]',
    '.MathJax'
  ].join(',');

  init();

  async function init() {
    settings = await chrome.storage.sync.get(DEFAULTS);
    createPanel();
    ensureFormulaUi();
    observeDom();
    attachStorageListener();
    scheduleRefresh();
    setInterval(scheduleRefresh, 5000);
  }

  function attachStorageListener() {
    if (storageListenerAdded) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, value] of Object.entries(changes)) {
        settings[key] = value.newValue;
      }
      scheduleRefresh();
    });
    storageListenerAdded = true;
  }

  function observeDom() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          if ([...mutation.addedNodes].some(node => isRelevantNode(node))) {
            shouldRefresh = true;
            break;
          }
        } else if (mutation.type === 'characterData') {
          shouldRefresh = true;
          break;
        }
      }
      if (shouldRefresh) scheduleRefresh();
      if (shouldRefresh) lastConversationMutationAt = performance.now();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function isRelevantNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === 'cgh-panel' || node.id === 'cgh-toast' || node.id === 'cgh-formula-btn' || node.id === 'cgh-formula-menu') return false;
    if (node.closest && (node.closest('#cgh-panel') || node.closest('#cgh-toast') || node.closest('#cgh-formula-btn') || node.closest('#cgh-formula-menu'))) return false;
    return !!(
      node.matches?.(MESSAGE_SELECTORS.join(',')) ||
      node.querySelector?.(MESSAGE_SELECTORS.join(',')) ||
      node.matches?.(FORMULA_SELECTORS) ||
      node.querySelector?.(FORMULA_SELECTORS)
    );
  }

  function scheduleRefresh() {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(refreshAll, 300);
  }

  function refreshAll() {
    ensurePanelAlive();
    ensureFormulaUi();
    bindFormulaListeners();
    const messages = collectMessages();
    currentMessages = messages;
    const stats = computeStats(messages);
    renderPanel(stats);
  }

  function ensurePanelAlive() {
    if (!panel || !document.body.contains(panel)) {
      createPanel();
    }
  }

  function createPanel() {
    if (panel?.isConnected) return;

    panel = document.createElement('div');
    panel.id = 'cgh-panel';
    panel.classList.add('cgh-hidden');
    panel.innerHTML = `
      <div class="cgh-header">
        <div class="cgh-title">上下文估算</div>
        <div style="display:flex;gap:6px;">
          <button class="cgh-mini-btn" data-action="refresh">刷新</button>
          <button class="cgh-mini-btn" data-action="toggle">展开</button>
        </div>
      </div>
      <div class="cgh-main">
        <div>可见总 token</div><div id="cgh-total">-</div>
        <div>用户 / 助手</div><div id="cgh-role-total">-</div>
        <div>消息数</div><div id="cgh-count">-</div>
        <div>状态</div><div id="cgh-status">-</div>
      </div>
      <div class="cgh-list" id="cgh-list"></div>
    `;

    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === 'refresh') refreshAll();
      if (action === 'toggle') {
        panel.classList.toggle('cgh-hidden');
        target.textContent = panel.classList.contains('cgh-hidden') ? '展开' : '收起';
      }
    });

    document.body.appendChild(panel);
    listContainer = panel.querySelector('#cgh-list');
    listContainer.addEventListener('click', handleMessageListClick);
  }

  function ensureFormulaUi() {
    if (!formulaButton) {
      formulaButton = document.createElement('button');
      formulaButton.id = 'cgh-formula-btn';
      formulaButton.type = 'button';
      formulaButton.textContent = '复制';
      formulaButton.hidden = true;
      formulaButton.addEventListener('mouseenter', clearHideFormulaTimer);
      formulaButton.addEventListener('mouseleave', scheduleHideFormulaUi);
      formulaButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!activeFormula) return;
        openFormulaMenu(activeFormula.node, activeFormula.latex, activeFormula.displayMode);
      });
    }
    if (!document.body.contains(formulaButton)) {
      document.body.appendChild(formulaButton);
    }

    if (!formulaMenu) {
      formulaMenu = document.createElement('div');
      formulaMenu.id = 'cgh-formula-menu';
      formulaMenu.className = 'cgh-formula-menu';
      formulaMenu.hidden = true;
      formulaMenu.addEventListener('mouseenter', clearHideFormulaTimer);
      formulaMenu.addEventListener('mouseleave', scheduleHideFormulaUi);
    }
    if (!document.body.contains(formulaMenu)) {
      document.body.appendChild(formulaMenu);
    }

    if (!formulaListenersBound) {
      document.addEventListener('pointerdown', handleDocumentPointerDown, true);
      window.addEventListener('scroll', hideFormulaUi, true);
      window.addEventListener('resize', hideFormulaUi);
      document.addEventListener('keydown', handleDocumentKeydown, true);
      formulaListenersBound = true;
    }
  }

  function collectMessages() {
    const selector = MESSAGE_SELECTORS.join(',');
    let nodes = [...document.querySelectorAll(selector)];

    nodes = nodes.filter(node => !node.closest('#cgh-panel') && !node.closest('#cgh-toast'));
    nodes = dedupeNodes(nodes);

    const messages = [];
    for (const node of nodes) {
      const role = inferRole(node);
      const text = extractTextWithLatex(node);
      if (!text.trim()) continue;
      messages.push({
        role,
        text,
        node,
        signature: buildMessageSignature(node, role, text),
      });
    }

    return messages;
  }

  function dedupeNodes(nodes) {
    return nodes.filter((node, index) => {
      return !nodes.some((other, otherIndex) => {
        if (index === otherIndex) return false;
        return other.contains(node);
      });
    });
  }

  function inferRole(node) {
    const role = node.getAttribute('data-message-author-role');
    if (role) return role;

    const text = (node.textContent || '').slice(0, 80);
    if (/^(You|你|用户)\b/i.test(text)) return 'user';
    return 'assistant';
  }

  function extractTextWithLatex(root) {
    const clone = root.cloneNode(true);

    clone.querySelectorAll('#cgh-panel, #cgh-toast, .cgh-formula-btn, .cgh-formula-menu').forEach(el => el.remove());

    clone.querySelectorAll(FORMULA_SELECTORS).forEach((formulaNode) => {
      const latex = extractLatexFromNode(formulaNode);
      const replacement = document.createTextNode(latex ? ` ${wrapFormulaForInlineHeuristic(formulaNode, latex)} ` : ' ');
      formulaNode.replaceWith(replacement);
    });

    clone.querySelectorAll('pre code').forEach((code) => {
      const text = code.textContent || '';
      const replacement = document.createTextNode(`\n\
\
\
${text}\n\
\
\
`);
      code.parentElement?.replaceWith(replacement);
    });

    const text = clone.textContent || '';
    return normalizeWhitespace(text);
  }

  function wrapFormulaForInlineHeuristic(node, latex) {
    const displayLike = node.closest('p, span') ? false : true;
    return displayLike ? `$$${latex}$$` : `$${latex}$`;
  }

  function normalizeWhitespace(text) {
    return text
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function computeStats(messages) {
    let total = 0;
    let userTotal = 0;
    let assistantTotal = 0;

    const perMessage = messages.map((message) => {
      const tokens = estimateTokens(message.text);
      total += tokens;
      if (message.role === 'user') userTotal += tokens;
      else assistantTotal += tokens;
      return {
        role: message.role,
        tokens,
        preview: message.text.slice(0, 70).replace(/\n/g, ' '),
      };
    });

    return {
      total,
      userTotal,
      assistantTotal,
      count: messages.length,
      level: getRiskLevel(total),
      perMessage,
    };
  }

  function getRiskLevel(total) {
    if (total >= settings.dangerThreshold) {
      return { key: 'danger', label: '建议新建聊天' };
    }
    if (total >= settings.warnThreshold) {
      return { key: 'warn', label: '开始变长' };
    }
    return { key: 'ok', label: '正常' };
  }

  function renderPanel(stats) {
    panel.querySelector('#cgh-total').textContent = formatNumber(stats.total);
    panel.querySelector('#cgh-role-total').textContent = `${formatNumber(stats.userTotal)} / ${formatNumber(stats.assistantTotal)}`;
    panel.querySelector('#cgh-count').textContent = String(stats.count);

    const statusEl = panel.querySelector('#cgh-status');
    statusEl.innerHTML = `<span class="cgh-pill cgh-${stats.level.key}">${stats.level.label}</span>`;

    if (!listContainer) return;
    if (!settings.showPerMessage) {
      listContainer.innerHTML = '<div style="font-size:11px;opacity:.75;">已在设置中关闭逐条消息显示</div>';
      return;
    }

    listContainer.innerHTML = stats.perMessage
      .map((item, idx) => `
        <button type="button" class="cgh-item" data-message-index="${idx}" aria-label="${escapeHtml(`滚动到第 ${idx + 1} 条${item.role === 'user' ? '用户' : '助手'}消息`)}">
          <div class="cgh-role">${item.role === 'user' ? '用户' : '助手'}</div>
          <div class="cgh-preview">${escapeHtml(`${idx + 1}. ${item.preview}`)}</div>
          <div class="cgh-token">${formatNumber(item.tokens)}</div>
        </button>
      `)
      .join('') || '<div style="font-size:11px;opacity:.75;">未检测到消息</div>';
  }

  function handleMessageListClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const item = target.closest('.cgh-item');
    if (!(item instanceof HTMLElement) || !listContainer?.contains(item)) return;

    const index = Number(item.dataset.messageIndex);
    if (!Number.isInteger(index)) return;

    event.preventDefault();
    event.stopPropagation();
    queueMessageJump(index);
  }

  function queueMessageJump(index) {
    pendingJump = { index, token: ++jumpSequence };
    if (jumpRunning) return;
    void processPendingJump();
  }

  async function processPendingJump() {
    if (jumpRunning) return;
    jumpRunning = true;

    try {
      while (pendingJump) {
        const request = pendingJump;
        pendingJump = null;
        await jumpToMessage(request.index, request.token);
      }
    } finally {
      jumpRunning = false;
    }
  }

  async function jumpToMessage(index, token) {
    const initialMessage = currentMessages[index];
    if (!initialMessage) {
      showToast('未找到对应消息');
      return;
    }

    if (isConversationLoading()) {
      showToast('正在加载对话...', 0);
    }

    const initialContainer = getMessageScrollContainer(initialMessage.node);
    await disengageAutoFollow(initialContainer, token);
    if (!isLatestJumpToken(token)) return;

    const ready = await waitForConversationReady(token);
    if (!isLatestJumpToken(token)) return;

    if (!ready) {
      showToast('正在加载对话，请稍后再试');
      return;
    }

    currentMessages = collectMessages();
    if (!isLatestJumpToken(token)) return;

    let message = currentMessages[index];
    if (message?.signature !== initialMessage.signature) {
      const matched = currentMessages.find(item => item.signature === initialMessage.signature);
      if (matched) {
        message = matched;
      } else if (!message) {
        message = initialMessage;
      }
    }

    const node = message?.node;
    if (!(node instanceof Element) || !node.isConnected) {
      showToast('未找到对应消息');
      return;
    }

    const container = getMessageScrollContainer(node);
    await disengageAutoFollow(container, token);
    if (!isLatestJumpToken(token)) return;

    await waitForScrollIdle(container, token, PRE_JUMP_SCROLL_IDLE_TIMEOUT_MS, PRE_JUMP_SCROLL_IDLE_MS);
    if (!isLatestJumpToken(token)) return;

    await scrollMessageIntoView(node, container, token);

    if (!isLatestJumpToken(token)) return;
    highlightMessageNode(node);
    showToast(`已定位到第 ${index + 1} 条消息`);
  }

  function isLatestJumpToken(token) {
    return token === jumpSequence;
  }

  function buildMessageSignature(node, role, text) {
    const stableId = [
      node.getAttribute?.('data-message-id'),
      node.getAttribute?.('data-testid'),
      node.id,
    ].find(Boolean) || '';

    return `${role}|${stableId}|${text.length}|${hashText(text)}`;
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isConversationLoading() {
    const loadingSelectors = [
      'main button[aria-label*="Stop generating"]',
      'main button[aria-label*="停止生成"]',
      'main [aria-busy="true"]',
      'main [data-testid*="stop-generating"]',
      'main [data-testid*="loading"]',
    ].join(',');

    if (document.querySelector(loadingSelectors)) return true;
    return performance.now() - lastConversationMutationAt < 350;
  }

  async function waitForConversationReady(token, timeoutMs = 6000) {
    const deadline = performance.now() + timeoutMs;
    let sawBusy = false;

    while (performance.now() < deadline) {
      if (!isLatestJumpToken(token)) return false;

      const loading = isConversationLoading();
      const quietFor = performance.now() - lastConversationMutationAt;
      if (!loading && quietFor >= CONVERSATION_READY_QUIET_MS) {
        return true;
      }

      sawBusy = sawBusy || loading || quietFor < CONVERSATION_READY_QUIET_MS;
      if (sawBusy) {
        showToast('正在加载对话...', 0);
      }

      await waitForLayoutStability(120);
    }

    return !isConversationLoading() && performance.now() - lastConversationMutationAt >= CONVERSATION_READY_QUIET_MS;
  }

  async function scrollMessageIntoView(node, container, token) {
    if (!(node instanceof Element)) return;

    const restoreOverflowAnchors = suspendOverflowAnchors(container);
    const restoreFocus = suspendScrollSensitiveFocus();

    try {
      if (!isLatestJumpToken(token) || !node.isConnected) return;

      const targetTop = getTargetScrollTopForNode(container, node);
      const currentTop = getScrollTop(container);
      const distance = Math.abs(targetTop - currentTop);
      if (distance <= 8 && isNodeCenteredEnough(node, container)) {
        return;
      }

      scrollContainerTo(container, targetTop, 'smooth');
      await waitForScrollToSettle(container, distance > 240 ? 1400 : 900);
      if (!isLatestJumpToken(token) || !node.isConnected) return;

      if (isNodeCenteredEnough(node, container)) {
        return;
      }

      await waitForScrollIdle(container, token, 600, 120);
      if (!isLatestJumpToken(token) || !node.isConnected) return;

      const correctedTop = getTargetScrollTopForNode(container, node);
      scrollContainerTo(container, correctedTop, 'auto');
      await waitForScrollToSettle(container, 400);
    } finally {
      restoreOverflowAnchors();
      restoreFocus();
    }
  }

  function getMessageScrollContainer(node) {
    let current = node.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY || style.overflow;
      if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight + 1) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function suspendOverflowAnchors(container) {
    const targets = new Set([document.documentElement, document.body]);
    if (container instanceof HTMLElement) {
      targets.add(container);
    }

    const snapshots = [];
    for (const target of targets) {
      if (!(target instanceof HTMLElement)) continue;
      snapshots.push({ target, overflowAnchor: target.style.overflowAnchor });
      target.style.overflowAnchor = 'none';
    }

    return () => {
      for (const snapshot of snapshots) {
        snapshot.target.style.overflowAnchor = snapshot.overflowAnchor;
      }
    };
  }

  function suspendScrollSensitiveFocus() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !isScrollSensitiveFocusTarget(activeElement)) {
      return () => {};
    }

    try {
      activeElement.blur();
    } catch (error) {
      return () => {};
    }

    return () => {};
  }

  function isScrollSensitiveFocusTarget(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest('#cgh-panel') || node.closest('#cgh-toast')) return false;

    if (node.isContentEditable) return true;
    if (node.getAttribute('role') === 'textbox') return true;
    if (node instanceof HTMLTextAreaElement) return true;
    if (node instanceof HTMLInputElement) {
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(node.type);
    }

    return false;
  }

  function isRootScrollContainer(container) {
    return container === document.scrollingElement || container === document.documentElement || container === document.body;
  }

  function getScrollTop(container) {
    if (isRootScrollContainer(container)) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return container.scrollTop;
  }

  function getContainerViewportHeight(container) {
    if (isRootScrollContainer(container)) {
      return window.innerHeight || document.documentElement.clientHeight || 0;
    }
    return container.clientHeight;
  }

  function getContainerMaxScrollTop(container) {
    if (isRootScrollContainer(container)) {
      const root = document.scrollingElement || document.documentElement;
      return Math.max(0, root.scrollHeight - root.clientHeight);
    }
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }

  function getDistanceToBottom(container) {
    return Math.max(0, getContainerMaxScrollTop(container) - getScrollTop(container));
  }

  function getNodeTopWithinContainer(node, container) {
    const nodeRect = node.getBoundingClientRect();
    if (isRootScrollContainer(container)) {
      return getScrollTop(container) + nodeRect.top;
    }

    const containerRect = container.getBoundingClientRect();
    return container.scrollTop + nodeRect.top - containerRect.top;
  }

  function getTargetScrollTopForNode(container, node) {
    const nodeTop = getNodeTopWithinContainer(node, container);
    const viewportHeight = getContainerViewportHeight(container);
    const nodeHeight = Math.min(node.getBoundingClientRect().height, viewportHeight);
    const paddingTop = Math.max(24, (viewportHeight - nodeHeight) / 2);
    return clamp(nodeTop - paddingTop, 0, getContainerMaxScrollTop(container));
  }

  function scrollContainerTo(container, top, behavior = 'auto') {
    const nextTop = Math.round(top);
    if (isRootScrollContainer(container)) {
      window.scrollTo({ top: nextTop, behavior });
      return;
    }

    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: nextTop, behavior });
      return;
    }

    container.scrollTop = nextTop;
  }

  async function waitForScrollToSettle(container, timeoutMs = 1000) {
    const deadline = performance.now() + timeoutMs;
    let lastTop = getScrollTop(container);
    let stableSince = performance.now();

    while (performance.now() < deadline) {
      await waitForLayoutStability(60);
      const nextTop = getScrollTop(container);
      if (Math.abs(nextTop - lastTop) > SCROLL_POSITION_EPSILON) {
        lastTop = nextTop;
        stableSince = performance.now();
        continue;
      }

      if (performance.now() - stableSince >= SCROLL_SETTLE_QUIET_MS) {
        return;
      }
    }
  }

  async function disengageAutoFollow(container, token) {
    if (!container) return;

    const currentTop = getScrollTop(container);
    const distanceToBottom = getDistanceToBottom(container);
    if (distanceToBottom > AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      return;
    }

    const viewportHeight = getContainerViewportHeight(container);
    const escapeDistance = Math.max(
      AUTO_FOLLOW_ESCAPE_PX,
      Math.min(Math.round(viewportHeight * 0.18), 180)
    );
    const targetTop = Math.max(0, currentTop - escapeDistance);
    if (Math.abs(targetTop - currentTop) <= SCROLL_POSITION_EPSILON) {
      return;
    }

    scrollContainerTo(container, targetTop, 'auto');
    dispatchSyntheticScrollHint(container, currentTop, targetTop);
    await waitForScrollIdle(container, token, 500, 120);
  }

  function dispatchSyntheticScrollHint(container, previousTop, nextTop) {
    const deltaY = previousTop - nextTop;
    const target = isRootScrollContainer(container) ? window : container;

    try {
      target.dispatchEvent(new Event('scroll'));
    } catch (error) {
      // Ignore dispatch failures on locked-down targets.
    }

    try {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
      }));
    } catch (error) {
      // Ignore browsers that reject synthetic wheel events.
    }
  }

  async function waitForScrollIdle(container, token, timeoutMs = 1500, idleMs = PRE_JUMP_SCROLL_IDLE_MS) {
    const deadline = performance.now() + timeoutMs;
    let lastTop = getScrollTop(container);
    let idleSince = performance.now();

    while (performance.now() < deadline) {
      if (!isLatestJumpToken(token)) return false;

      await waitForLayoutStability(60);
      const nextTop = getScrollTop(container);
      if (Math.abs(nextTop - lastTop) > SCROLL_POSITION_EPSILON) {
        lastTop = nextTop;
        idleSince = performance.now();
        continue;
      }

      if (performance.now() - idleSince >= idleMs) {
        return true;
      }
    }

    return true;
  }

  function isNodeCenteredEnough(node, container) {
    if (!(node instanceof Element) || !isNodeVisibleEnough(node)) return false;

    const rect = node.getBoundingClientRect();
    const viewportHeight = getContainerViewportHeight(container);
    if (!viewportHeight) return false;

    let viewportTop = 0;
    if (!isRootScrollContainer(container)) {
      viewportTop = container.getBoundingClientRect().top;
    }

    const viewportCenter = viewportTop + viewportHeight / 2;
    const nodeCenter = rect.top + rect.height / 2;
    const tolerance = Math.max(48, Math.min(160, viewportHeight * 0.18));
    return Math.abs(nodeCenter - viewportCenter) <= tolerance;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function isNodeVisibleEnough(node) {
    if (!(node instanceof Element)) return false;

    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
  }

  async function waitForLayoutStability(delayMs = 120) {
    await new Promise(resolve => window.setTimeout(resolve, delayMs));
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function highlightMessageNode(node) {
    if (!(node instanceof HTMLElement)) return;

    if (highlightedMessageTimer) {
      window.clearTimeout(highlightedMessageTimer);
      highlightedMessageTimer = null;
    }

    if (highlightedMessageNode && highlightedMessageNode !== node) {
      highlightedMessageNode.classList.remove('cgh-target-message');
    }

    highlightedMessageNode = node;
    node.classList.add('cgh-target-message');

    highlightedMessageTimer = window.setTimeout(() => {
      if (highlightedMessageNode === node) {
        node.classList.remove('cgh-target-message');
        highlightedMessageNode = null;
      }
      highlightedMessageTimer = null;
    }, 1800);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value);
  }

  function escapeHtml(text) {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function estimateTokens(text) {
    if (!text) return 0;

    let tokens = 0;

    const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
    tokens += cjkMatches.length;

    const asciiText = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
    const segments = asciiText.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?|\S/gu) || [];

    for (const segment of segments) {
      if (/^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(segment)) {
        tokens += Math.max(1, Math.ceil(segment.length / 4));
      } else if (/^\d+(?:\.\d+)?$/.test(segment)) {
        tokens += Math.max(1, Math.ceil(segment.length / 3));
      } else {
        tokens += 1;
      }
    }

    const newlineCount = (text.match(/\n/g) || []).length;
    tokens += Math.ceil(newlineCount * 0.2);

    return tokens;
  }

  function bindFormulaListeners() {
    const formulaNodes = [...document.querySelectorAll(FORMULA_SELECTORS)];
    for (const node of formulaNodes) {
      if (!(node instanceof HTMLElement || node instanceof Element)) continue;
      if (node.closest('#cgh-panel') || node.closest('#cgh-toast')) continue;
      if (boundFormulaNodes.has(node)) continue;

      boundFormulaNodes.add(node);
      node.addEventListener('pointerenter', handleFormulaEnter);
      node.addEventListener('pointerleave', handleFormulaLeave);
      node.addEventListener('click', handleFormulaClick);
    }
  }

  function handleFormulaEnter(event) {
    const node = event.currentTarget;
    if (!(node instanceof Element)) return;
    showFormulaCopyButton(node);
  }

  function handleFormulaLeave(event) {
    const related = event.relatedTarget;
    if (related instanceof Element) {
      if (related.closest('#cgh-formula-btn') || related.closest('#cgh-formula-menu')) return;
      if (related.closest(FORMULA_SELECTORS)) return;
    }
    scheduleHideFormulaUi();
  }

  async function handleFormulaClick(event) {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const node = event.currentTarget;
    if (!(node instanceof Element)) return;

    event.preventDefault();
    event.stopPropagation();

    const latex = extractLatexFromNode(node);
    if (!latex) return;

    hideFormulaUi();
    await copyFormulaText(latex, isDisplayFormula(node), settings.copyMode);
  }

  function isDisplayFormula(node) {
    if (node.matches('mjx-container[display="true"], .katex-display')) return true;
    const displayAttr = node.getAttribute?.('display');
    if (displayAttr === 'block' || displayAttr === 'true') return true;
    return false;
  }

  function showFormulaCopyButton(node) {
    const latex = extractLatexFromNode(node);
    if (!latex) {
      hideFormulaUi();
      return;
    }

    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    ensureFormulaUi();
    clearHideFormulaTimer();
    closeFormulaMenu();
    activeFormula = {
      node,
      latex,
      displayMode: isDisplayFormula(node),
    };

    const buttonWidth = 52;
    const buttonHeight = 24;
    const left = clamp(rect.right - buttonWidth, 8, Math.max(8, window.innerWidth - buttonWidth - 8));
    const above = rect.top - buttonHeight - 6;
    const below = rect.bottom + 6;
    const top = above >= 8 ? above : below;
    const maxTop = Math.max(8, window.innerHeight - buttonHeight - 8);

    formulaButton.hidden = false;
    formulaButton.style.display = 'block';
    formulaButton.style.left = `${left}px`;
    formulaButton.style.top = `${clamp(top, 8, maxTop)}px`;
  }

  function hideFormulaUi() {
    clearHideFormulaTimer();
    closeFormulaMenu();
    if (formulaButton) {
      formulaButton.hidden = true;
      formulaButton.style.display = 'none';
    }
    activeFormula = null;
  }

  function scheduleHideFormulaUi() {
    clearHideFormulaTimer();
    hideFormulaTimer = window.setTimeout(hideFormulaUi, 180);
  }

  function clearHideFormulaTimer() {
    if (hideFormulaTimer) {
      window.clearTimeout(hideFormulaTimer);
      hideFormulaTimer = null;
    }
  }

  function openFormulaMenu(anchor, latex, displayMode) {
    ensureFormulaUi();
    clearHideFormulaTimer();
    closeFormulaMenu();

    const menu = formulaMenu;
    menu.innerHTML = '';

    const quickBtn = document.createElement('button');
    quickBtn.textContent = `按默认格式复制（${settings.copyMode === 'markdown' ? 'Markdown' : 'LaTeX'}）`;
    quickBtn.addEventListener('click', async () => {
      await copyFormulaText(latex, displayMode, settings.copyMode);
      hideFormulaUi();
    });

    const latexBtn = document.createElement('button');
    latexBtn.textContent = '复制 LaTeX';
    latexBtn.addEventListener('click', async () => {
      await copyText(latex);
      showToast('已复制 LaTeX');
      hideFormulaUi();
    });

    const markdownBtn = document.createElement('button');
    markdownBtn.textContent = '复制 Markdown';
    markdownBtn.addEventListener('click', async () => {
      const wrapped = displayMode ? `$$\n${latex}\n$$` : `$${latex}$`;
      await copyText(wrapped);
      showToast('已复制 Markdown');
      hideFormulaUi();
    });

    menu.append(quickBtn, latexBtn, markdownBtn);
    menu.hidden = false;
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';

    const rect = anchor.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const menuWidth = menuBox.width || 180;
    const menuHeight = menuBox.height || 120;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 8;

    let left;
    if (rect.right + menuWidth + gap <= viewportWidth) {
      left = rect.right + gap;
    } else if (rect.left - menuWidth - gap >= 0) {
      left = rect.left - menuWidth - gap;
    } else {
      left = rect.left + rect.width / 2 - menuWidth / 2;
    }

    let top;
    if (rect.top - menuHeight - gap >= 0) {
      top = rect.top - menuHeight - gap;
    } else if (rect.bottom + menuHeight + gap <= viewportHeight) {
      top = rect.bottom + gap;
    } else {
      top = rect.bottom - menuHeight;
    }

    menu.style.left = `${clamp(left, 8, Math.max(8, viewportWidth - menuWidth - 8))}px`;
    menu.style.top = `${clamp(top, 8, Math.max(8, viewportHeight - menuHeight - 8))}px`;
    menu.style.visibility = 'visible';
  }

  function closeFormulaMenu() {
    if (!formulaMenu) return;
    formulaMenu.hidden = true;
    formulaMenu.style.display = 'none';
    formulaMenu.innerHTML = '';
  }

  function handleDocumentPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#cgh-formula-btn') || target.closest('#cgh-formula-menu') || target.closest('#cgh-panel') || target.closest('#cgh-toast')) {
      return;
    }
    hideFormulaUi();
  }

  function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
      hideFormulaUi();
    }
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  async function copyFormulaText(latex, displayMode, mode) {
    const text = mode === 'markdown'
      ? (displayMode ? `$$\n${latex}\n$$` : `$${latex}$`)
      : latex;
    await copyText(text);
    showToast(`已复制${mode === 'markdown' ? ' Markdown' : ' LaTeX'}`);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  function showToast(text, duration = 1400) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'cgh-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(showToast._timer);
    if (duration > 0) {
      showToast._timer = setTimeout(() => {
        if (toastEl) toastEl.hidden = true;
      }, duration);
    }
  }

  function extractLatexFromNode(node) {
    if (!(node instanceof Element)) return '';

    const directCandidates = [
      node.getAttribute('data-tex'),
      node.getAttribute('data-latex'),
      node.getAttribute('latex'),
      node.getAttribute('aria-label'),
      node.getAttribute('alttext'),
    ].filter(Boolean);

    for (const candidate of directCandidates) {
      const cleaned = cleanLatexCandidate(candidate);
      if (looksLikeLatex(cleaned)) return cleaned;
    }

    const annotation = node.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    if (annotation?.textContent) {
      const cleaned = cleanLatexCandidate(annotation.textContent);
      if (cleaned) return cleaned;
    }

    const semantics = node.querySelector('semantics > annotation');
    if (semantics?.textContent) {
      const cleaned = cleanLatexCandidate(semantics.textContent);
      if (looksLikeLatex(cleaned)) return cleaned;
    }

    const mjxAssistive = node.querySelector('mjx-assistive-mml math');
    if (mjxAssistive) {
      const alttext = mjxAssistive.getAttribute('alttext');
      if (alttext) {
        const cleaned = cleanLatexCandidate(alttext);
        if (cleaned) return cleaned;
      }
    }

    if (node.matches('.katex')) {
      const ann = node.querySelector('annotation');
      if (ann?.textContent) {
        const cleaned = cleanLatexCandidate(ann.textContent);
        if (cleaned) return cleaned;
      }
      const mathml = node.querySelector('math');
      if (mathml?.getAttribute('alttext')) {
        const cleaned = cleanLatexCandidate(mathml.getAttribute('alttext'));
        if (cleaned) return cleaned;
      }
    }

    if (node.matches('math')) {
      const alttext = node.getAttribute('alttext');
      if (alttext) {
        const cleaned = cleanLatexCandidate(alttext);
        if (cleaned) return cleaned;
      }
    }

    const text = normalizeWhitespace(node.textContent || '');
    if (looksLikeLatex(text)) return text;

    return '';
  }

  function cleanLatexCandidate(text) {
    if (!text) return '';
    return text
      .replace(/^\$\$(.*)\$\$$/s, '$1')
      .replace(/^\$(.*)\$$/s, '$1')
      .replace(/^\\\[(.*)\\\]$/s, '$1')
      .replace(/^\\\((.*)\\\)$/s, '$1')
      .trim();
  }

  function looksLikeLatex(text) {
    if (!text) return false;
    if (/[\\_^{}]/.test(text)) return true;
    if (/\b(frac|sqrt|sum|int|alpha|beta|gamma|sin|cos|tan|cdot|times|leq|geq)\b/.test(text)) return true;
    if (/^[0-9A-Za-z+\-*/=().,\s]+$/.test(text) && /[=+\-*/^]/.test(text)) return true;
    return false;
  }
})();
