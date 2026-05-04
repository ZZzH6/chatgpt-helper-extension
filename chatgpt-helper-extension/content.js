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

    const modeLabels = { latex: 'LaTeX', markdown: 'Markdown', unicode: 'Unicode' };
    const quickBtn = document.createElement('button');
    quickBtn.textContent = `按默认格式复制（${modeLabels[settings.copyMode] || settings.copyMode}）`;
    quickBtn.addEventListener('click', async () => {
      await copyFormulaText(latex, displayMode, settings.copyMode);
      hideFormulaUi();
    });

    const latexBtn = document.createElement('button');
    latexBtn.textContent = '复制 LaTeX';
    latexBtn.addEventListener('click', async () => {
      await copyFormulaText(latex, displayMode, 'latex');
      hideFormulaUi();
    });

    const markdownBtn = document.createElement('button');
    markdownBtn.textContent = '复制 Markdown';
    markdownBtn.addEventListener('click', async () => {
      await copyFormulaText(latex, displayMode, 'markdown');
      hideFormulaUi();
    });

    const unicodeBtn = document.createElement('button');
    unicodeBtn.textContent = '复制 Unicode';
    unicodeBtn.addEventListener('click', async () => {
      await copyFormulaText(latex, displayMode, 'unicode');
      hideFormulaUi();
    });

    menu.append(quickBtn, latexBtn, markdownBtn, unicodeBtn);
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
    let text;
    let label;
    if (mode === 'markdown') {
      text = formatMarkdownFormula(latex, displayMode);
      label = 'Markdown';
    } else if (mode === 'unicode') {
      text = latexToUnicode(latex);
      label = 'Unicode';
    } else {
      text = normalizeLatexForCopy(latex);
      label = 'LaTeX';
    }
    await copyText(text);
    showToast(`已复制 ${label}`);
  }

  function normalizeLatexForCopy(latex) {
    if (!latex) return '';
    return stripMathDelimiters(latex)
      .replace(/\u00A0/g, ' ')
      .replace(/\\tag\s*\{([^{}]*)\}/g, '#($1)')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatMarkdownFormula(latex, displayMode) {
    const body = normalizeLatexForMarkdown(latex);
    if (!body) return '';

    const needsBlock = displayMode ||
      /\\tag\s*\{[^{}]*\}/.test(body) ||
      /\\begin\s*\{(?:align|aligned|array|bmatrix|cases|equation|gather|matrix|multline|pmatrix|split|vmatrix|Vmatrix)\}/.test(body);

    return needsBlock ? `$$\n${body}\n$$` : `$${body}$`;
  }

  function normalizeLatexForMarkdown(latex) {
    if (!latex) return '';
    return stripMathDelimiters(latex)
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]*\n[ \t]*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function latexToUnicode(latex) {
    if (!latex) return '';

    const SYMBOLS = {
      '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
      '\\epsilon': 'ε', '\\varepsilon': 'ɛ', '\\zeta': 'ζ', '\\eta': 'η',
      '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
      '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ',
      '\\omicron': 'ο', '\\pi': 'π', '\\varpi': 'ϖ', '\\rho': 'ρ',
      '\\varrho': 'ϱ', '\\sigma': 'σ', '\\varsigma': 'ς', '\\tau': 'τ',
      '\\upsilon': 'υ', '\\phi': 'φ', '\\varphi': 'ϕ', '\\chi': 'χ',
      '\\psi': 'ψ', '\\omega': 'ω',
      '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
      '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ',
      '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
      '\\times': '×', '\\cdot': '·', '\\div': '÷', '\\pm': '±', '\\mp': '∓',
      '\\ast': '∗', '\\star': '⋆', '\\circ': '∘', '\\bullet': '•',
      '\\oplus': '⊕', '\\ominus': '⊖', '\\otimes': '⊗', '\\oslash': '⊘',
      '\\odot': '⊙', '\\dagger': '†', '\\ddagger': '‡',
      '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈',
      '\\equiv': '≡', '\\sim': '∼', '\\simeq': '≃', '\\cong': '≅',
      '\\propto': '∝', '\\perp': '⊥', '\\parallel': '∥',
      '\\ll': '≪', '\\gg': '≫', '\\prec': '≺', '\\succ': '≻',
      '\\preceq': '≼', '\\succeq': '≽', '\\subset': '⊂', '\\supset': '⊃',
      '\\subseteq': '⊆', '\\supseteq': '⊇', '\\in': '∈', '\\ni': '∋',
      '\\notin': '∉', '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
      '\\emptyset': '∅', '\\varnothing': '∅', '\\infty': '∞',
      '\\partial': '∂', '\\nabla': '∇', '\\triangle': '△',
      '\\angle': '∠', '\\measuredangle': '∡',
      '\\rightarrow': '→', '\\Rightarrow': '⇒', '\\longrightarrow': '⟶',
      '\\Longrightarrow': '⟹', '\\leftarrow': '←', '\\Leftarrow': '⇐',
      '\\longleftarrow': '⟵', '\\Longleftarrow': '⟸',
      '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔',
      '\\uparrow': '↑', '\\downarrow': '↓', '\\updownarrow': '↕',
      '\\mapsto': '↦', '\\longmapsto': '⟼', '\\to': '→',
      '\\land': '∧', '\\lor': '∨', '\\lnot': '¬', '\\neg': '¬',
      '\\top': '⊤', '\\bot': '⊥',
      '\\cup': '∪', '\\cap': '∩', '\\setminus': '∖',
      '\\sum': '∑', '\\prod': '∏', '\\coprod': '∐', '\\int': '∫',
      '\\iint': '∬', '\\iiint': '∭', '\\oint': '∮',
      '\\ldots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
      '\\therefore': '∴', '\\because': '∵',
      '\\aleph': 'ℵ', '\\hbar': 'ℏ', '\\ell': 'ℓ', '\\wp': '℘',
      '\\Re': 'ℜ', '\\Im': 'ℑ', '\\prime': '′', '\\backslash': '\\',
      '\\Box': '□', '\\Diamond': '◇', '\\sharp': '♯', '\\flat': '♭',
      '\\natural': '♮', '\\clubsuit': '♣', '\\diamondsuit': '♢',
      '\\heartsuit': '♡', '\\spadesuit': '♠',
      '\\langle': '⟨', '\\rangle': '⟩', '\\lceil': '⌈', '\\rceil': '⌉',
      '\\lfloor': '⌊', '\\rfloor': '⌋', '\\|': '‖',
      '\\{': '{', '\\}': '}',
      '\\,': ' ', '\\:': ' ', '\\;': ' ', '\\!': '',
      '\\quad': ' ', '\\qquad': ' ',
    };

    const SUPERSCRIPT = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
      'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
      'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ',
      'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ',
      'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
      'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
      'A': 'ᴬ', 'B': 'ᴮ', 'D': 'ᴰ', 'E': 'ᴱ', 'G': 'ᴳ',
      'H': 'ᴴ', 'I': 'ᴵ', 'J': 'ᴶ', 'K': 'ᴷ', 'L': 'ᴸ',
      'M': 'ᴹ', 'N': 'ᴺ', 'O': 'ᴼ', 'P': 'ᴾ', 'R': 'ᴿ',
      'T': 'ᵀ', 'U': 'ᵁ', 'V': 'ⱽ', 'W': 'ᵂ',
      '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
      'α': 'ᵅ', 'β': 'ᵝ', 'γ': 'ᵞ', 'δ': 'ᵟ', 'ε': 'ᵋ',
      'θ': 'ᶿ', 'ι': 'ᶥ', 'φ': 'ᵠ', 'χ': 'ᵡ',
    };

    const SUBSCRIPT = {
      '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
      '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
      'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
      'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
      'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
      'v': 'ᵥ', 'x': 'ₓ',
      '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
      'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'φ': 'ᵩ', 'χ': 'ᵪ',
    };

    const SCRIPT = {
      'A': '𝒜', 'B': 'ℬ', 'C': '𝒞', 'D': '𝒟', 'E': 'ℰ',
      'F': 'ℱ', 'G': '𝒢', 'H': 'ℋ', 'I': 'ℐ', 'J': '𝒥',
      'K': '𝒦', 'L': 'ℒ', 'M': 'ℳ', 'N': '𝒩', 'O': '𝒪',
      'P': '𝒫', 'Q': '𝒬', 'R': 'ℛ', 'S': '𝒮', 'T': '𝒯',
      'U': '𝒰', 'V': '𝒱', 'W': '𝒲', 'X': '𝒳', 'Y': '𝒴',
      'Z': '𝒵',
    };

    let result = normalizeLatexForMarkdown(latex);
    const equationTags = [];
    result = result.replace(/\\tag\s*\{([^{}]*)\}/g, (_, tag) => {
      const cleanedTag = tag.trim();
      if (cleanedTag) equationTags.push(cleanedTag);
      return '';
    });

    // Remove outer delimiters
    result = result.replace(/^\\\[(.*)\\\]$/s, '$1').replace(/^\\\((.*)\\\)$/s, '$1');
    result = result.replace(/^\$\$(.*)\$\$$/s, '$1').replace(/^\$(.*)\$$/s, '$1');

    // Handle \text{...} and font commands
    result = result.replace(/\\operatorname\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\text\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathrm\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathbf\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathit\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathsf\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathtt\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\textrm\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathcal\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, content) => mapUnicodeStyle(content, SCRIPT));
    result = result.replace(/\\mathfrak\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
    result = result.replace(/\\mathscr\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, content) => mapUnicodeStyle(content, SCRIPT));
    result = result.replace(/\\mathbb\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, c) => {
      const BB = { 'C': 'ℂ', 'H': 'ℍ', 'N': 'ℕ', 'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'Z': 'ℤ' };
      return mapUnicodeStyle(c, BB);
    });

    // Replace known LaTeX commands (longest first to avoid partial matches)
    const sortedKeys = Object.keys(SYMBOLS).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      const regex = new RegExp(escapeRegExp(key), 'g');
      result = result.replace(regex, SYMBOLS[key]);
    }

    // Handle \frac{numerator}{denominator}
    result = result.replace(/\\frac\{((?:[^{}]|\{[^{}]*\})*)\}\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, num, den) => {
      return formatUnicodeFraction(num, den);
    });

    // Handle \sqrt[n]{x} and \sqrt{x}
    result = result.replace(/\\sqrt\[([^\]]+)\]\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, n, x) => {
      const superscriptN = [...n].map(c => SUPERSCRIPT[c] || c).join('');
      return `${superscriptN}√(${x})`;
    });
    result = result.replace(/\\sqrt\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, x) => `√(${x})`);

    // Handle superscripts: ^{...} or ^singleChar
    result = result.replace(/\^\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, content) => {
      return renderUnicodeScript(content, SUPERSCRIPT, '⁽', '⁾');
    });
    result = result.replace(/\^(\S)/g, (_, c) => renderUnicodeScript(c, SUPERSCRIPT, '⁽', '⁾'));

    // Handle subscripts: _{...} or _singleChar
    result = result.replace(/\_\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, content) => {
      return renderUnicodeScript(content, SUBSCRIPT, '₍', '₎');
    });
    result = result.replace(/\_(\S)/g, (_, c) => renderUnicodeScript(c, SUBSCRIPT, '₍', '₎'));

    // Handle \overline{...}
    result = result.replace(/\\overline\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̅');

    // Handle \underline{...}
    result = result.replace(/\\underline\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̲');

    // Handle \hat{...}
    result = result.replace(/\\hat\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̂');

    // Handle \tilde{...}
    result = result.replace(/\\tilde\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̃');

    // Handle \vec{...}
    result = result.replace(/\\vec\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1⃗');

    // Handle \dot{...}
    result = result.replace(/\\dot\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̇');

    // Handle \ddot{...}
    result = result.replace(/\\ddot\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̈');

    // Handle \bar{...}
    result = result.replace(/\\bar\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1̄');

    // Handle \not (strikethrough for relations, e.g., \not\leq → ≰)
    // Most \not combos are already handled by explicit symbols above

    // Handle \operatorname{...} and \DeclareMathOperator (extract argument)
    result = result.replace(/\\operatorname\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');

    // Strip \left, \right, \middle (keep the delimiter they prefix)
    result = result.replace(/\\left\b/g, '');
    result = result.replace(/\\right\b/g, '');
    result = result.replace(/\\middle\b/g, '');

    // Strip \big, \Big, \bigg, \Bigg and their l/r variants (keep the delimiter)
    result = result.replace(/\\big[lr]?\b/g, '');
    result = result.replace(/\\Big[lr]?\b/g, '');
    result = result.replace(/\\bigg[lr]?\b/g, '');
    result = result.replace(/\\Bigg[lr]?\b/g, '');

    // Remove \tag{...}, \label{...}, and other amsmath commands (must be before brace removal)
    result = result.replace(/\\tag\{((?:[^{}]|\{[^{}]*\})*)\}/g, '');
    result = result.replace(/\\label\{((?:[^{}]|\{[^{}]*\})*)\}/g, '');
    result = result.replace(/\\notag\b/g, '');
    result = result.replace(/\\(arccos|arcsin|arctan|argmax|argmin|cosh|sinh|tanh|cos|cot|csc|det|dim|exp|gcd|inf|lim|ln|log|max|min|mod|Pr|sec|sin|sup|tan)\b/g, '$1');

    // Remove remaining braces
    result = result.replace(/[{}]/g, '');

    // Remove leftover backslash-prefixed commands that weren't recognized
    result = result.replace(/\\[a-zA-Z]+/g, '');

    // Collapse all whitespace (including newlines) into single spaces
    result = result.replace(/\s+/g, ' ').trim();
    if (equationTags.length) {
      result = `${result} (${equationTags.join(', ')})`.trim();
    }

    return result;
  }

  function formatUnicodeFraction(num, den) {
    return `${formatUnicodeFractionPart(num)}/${formatUnicodeFractionPart(den)}`;
  }

  function formatUnicodeFractionPart(part) {
    const normalized = (part || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const compact = normalized.replace(/\s+/g, '');
    if (/^[A-Za-z0-9_.\u0370-\u03FF\u1D00-\u1DFF\u2070-\u209F\u2100-\u214F\u2200-\u22FF\u{1D400}-\u{1D7FF}]+$/u.test(compact)) {
      return compact;
    }
    return `(${normalized})`;
  }

  function renderUnicodeScript(content, glyphs, fallbackOpen, fallbackClose) {
    const compact = (content || '').replace(/\s+/g, '');
    if (!compact) return '';

    const chars = [...compact];
    if (chars.every(char => glyphs[char])) {
      return chars.map(char => glyphs[char]).join('');
    }
    return `${fallbackOpen}${compact}${fallbackClose}`;
  }

  function mapUnicodeStyle(content, styleMap) {
    return [...(content || '')].map(char => styleMap[char] || char).join('');
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    return stripMathDelimiters(text);
  }

  function stripMathDelimiters(text) {
    if (!text) return '';
    return String(text)
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
