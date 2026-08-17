(() => {
  'use strict';

  const TOOLKIT = globalThis.CGH_TOOLKIT;
  const DEFAULTS = TOOLKIT.DEFAULTS;

  let settings = { ...DEFAULTS };
  let panel = null;
  let listContainer = null;
  let toastEl = null;
  let updateTimer = null;
  let observer = null;
  let storageListenerAdded = false;
  let formulaFeedbackEl = null;
  let formulaFeedbackTimer = null;
  let hoveredFormulaNode = null;
  let formulaListenersBound = false;
  let currentMessages = [];
  let highlightedMessageNode = null;
  let highlightedMessageTimer = null;
  let lastConversationMutationAt = performance.now();
  let jumpSequence = 0;
  let jumpRunning = false;
  let pendingJump = null;
  let exportSelectionMode = false;
  let exportRendering = false;
  let activeExportFormat = null;
  let exportClickListenerBound = false;
  let activeConversationKey = getConversationKey();
  let timelineQuery = '';
  let starredOnly = false;
  let activeTimelineIndex = -1;
  let starredSignatures = new Set();
  let draftInput = null;
  let draftSaveTimer = null;
  let draftObserver = null;
  const selectedMessageSignatures = new Set();
  const CONVERSATION_READY_QUIET_MS = 500;
  const PRE_JUMP_SCROLL_IDLE_MS = 260;
  const PRE_JUMP_SCROLL_IDLE_TIMEOUT_MS = 2200;
  const AUTO_FOLLOW_ESCAPE_PX = 96;
  const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 80;
  const SCROLL_SETTLE_QUIET_MS = 180;
  const SCROLL_POSITION_EPSILON = 2;
  const STAR_STORAGE_KEY = 'cghStarredMessages';
  const DRAFT_STORAGE_PREFIX = 'cghDraft:';
  const COMPOSER_SELECTORS = '#prompt-textarea, textarea[data-id="root"], textarea, div[contenteditable="true"].ProseMirror';

  const MESSAGE_SELECTORS = [
    '[data-message-author-role]',
    'article[data-testid^="conversation-turn-"]',
    'main article',
    'main [role="article"]'
  ];

  const FORMULA_SELECTORS = [
    '.katex',
    '.katex-display',
    'mjx-container',
    'math',
    '[data-tex]',
    '[data-latex]',
    '[data-math]',
    '[data-mathml]',
    '[data-math-mode]',
    '[data-formula]',
    '[data-testid*="math"]',
    '[role="math"]',
    '[aria-roledescription="math"]',
    '.math',
    '.math-inline',
    '.math-display',
    '.math-block',
    '.math-container',
    '.MathJax_Display',
    '.MathJax'
  ].join(',');

  init();

  async function init() {
    settings = normalizeSettings(await chrome.storage.sync.get(DEFAULTS));
    await loadStarredMessages();
    createPanel();
    ensureFormulaUi();
    applyReadingSettings();
    observeDom();
    attachStorageListener();
    startDraftSave();
    scheduleRefresh();
    setInterval(scheduleRefresh, 5000);
  }

  function attachStorageListener() {
    if (storageListenerAdded) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const next = { ...settings };
      for (const [key, value] of Object.entries(changes)) next[key] = value.newValue;
      settings = normalizeSettings(next);
      applyReadingSettings();
      if (settings.draftSaveEnabled) attachDraftInput();
      scheduleRefresh();
    });
    storageListenerAdded = true;
  }

  function normalizeSettings(values) {
    return TOOLKIT.normalizeSettings(values);
  }

  function normalizeCopyMode(mode) {
    return TOOLKIT.normalizeCopyMode(mode);
  }

  function getConversationKey() {
    return TOOLKIT.getConversationKey(location.pathname);
  }

  function syncConversationState() {
    const conversationKey = getConversationKey();
    if (conversationKey === activeConversationKey) return;
    saveDraftNow();
    activeConversationKey = conversationKey;
    timelineQuery = '';
    activeTimelineIndex = -1;
    selectedMessageSignatures.clear();
    void loadStarredMessages().then(() => renderTimeline());
    window.setTimeout(() => {
      attachDraftInput();
      void restoreDraft();
    }, 500);
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
    if (node.id === 'cgh-panel' || node.id === 'cgh-toast' || node.id === 'cgh-formula-copy-feedback') return false;
    if (node.closest && (node.closest('#cgh-panel') || node.closest('#cgh-toast') || node.closest('#cgh-formula-copy-feedback'))) return false;
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
    syncConversationState();
    ensurePanelAlive();
    ensureFormulaUi();
    const messages = collectMessages();
    currentMessages = messages;
    syncSelectedMessagesWithCurrent();
    renderTimeline();
    updateExportUi();
    attachDraftInput();
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
        <div class="cgh-title">对话导航</div>
        <div class="cgh-actions">
          <button class="cgh-mini-btn" data-action="refresh">刷新</button>
          <button class="cgh-mini-btn" data-action="toggle">展开</button>
        </div>
      </div>
      <div class="cgh-timeline-tools">
        <input id="cgh-search" type="search" placeholder="搜索当前对话" autocomplete="off" />
        <button class="cgh-icon-btn" data-action="star-filter" type="button" title="仅显示星标" aria-label="仅显示星标" aria-pressed="false">★</button>
      </div>
      <div class="cgh-list" id="cgh-list"></div>
      <div class="cgh-export">
        <div class="cgh-export-buttons">
          <button class="cgh-mini-btn" data-action="export-select">选择</button>
          <button class="cgh-mini-btn" data-action="select-all">全选</button>
          <button class="cgh-mini-btn" data-action="export-png" disabled>PNG</button>
          <button class="cgh-mini-btn" data-action="export-pdf" disabled>PDF</button>
          <button class="cgh-mini-btn" data-action="export-markdown" disabled>MD</button>
          <button class="cgh-mini-btn" data-action="export-print-pdf" disabled>打印</button>
          <button class="cgh-mini-btn" data-action="export-cancel" hidden>取消</button>
        </div>
        <div class="cgh-export-status" id="cgh-export-status">未选择消息</div>
      </div>
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
      if (action === 'star-filter') {
        starredOnly = !starredOnly;
        target.setAttribute('aria-pressed', String(starredOnly));
        renderTimeline();
      }
      if (action === 'export-select') {
        setExportSelectionMode(true);
      }
      if (action === 'select-all') {
        const shouldSelect = selectedMessageSignatures.size !== currentMessages.length;
        selectedMessageSignatures.clear();
        if (shouldSelect) currentMessages.forEach(message => selectedMessageSignatures.add(message.signature));
        updateExportUi();
      }
      if (action === 'export-png') {
        void exportSelectedMessages('png');
      }
      if (action === 'export-pdf') {
        void exportSelectedMessages('pdf');
      }
      if (action === 'export-markdown') {
        void exportSelectedMessages('markdown');
      }
      if (action === 'export-print-pdf') {
        void exportSelectedMessages('print-pdf');
      }
      if (action === 'export-cancel') {
        setExportSelectionMode(false, { clearSelection: true });
      }
    });

    document.body.appendChild(panel);
    listContainer = panel.querySelector('#cgh-list');
    listContainer.addEventListener('click', handleMessageListClick);
    panel.querySelector('#cgh-search').addEventListener('input', (event) => {
      timelineQuery = event.target.value;
      renderTimeline();
    });
    ensureExportSelectionListener();
  }

  function ensureFormulaUi() {
    if (!formulaFeedbackEl) {
      formulaFeedbackEl = document.createElement('div');
      formulaFeedbackEl.id = 'cgh-formula-copy-feedback';
      formulaFeedbackEl.setAttribute('role', 'status');
      formulaFeedbackEl.setAttribute('aria-live', 'polite');
      formulaFeedbackEl.textContent = '✓ 公式已复制';
      formulaFeedbackEl.hidden = true;
    }
    if (!document.body.contains(formulaFeedbackEl)) {
      document.body.appendChild(formulaFeedbackEl);
    }

    if (!formulaListenersBound) {
      document.addEventListener('pointerover', handleFormulaPointerOver, true);
      document.addEventListener('pointerout', handleFormulaPointerOut, true);
      document.addEventListener('click', handleFormulaDocumentClick, true);
      window.addEventListener('blur', clearFormulaHover);
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
      if (!text.trim() && !hasExportableImages(node)) continue;
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

    clone.querySelectorAll('#cgh-panel, #cgh-toast, #cgh-formula-copy-feedback').forEach(el => el.remove());

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

  function renderTimeline() {
    if (!listContainer) return;
    const items = currentMessages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => TOOLKIT.matchesTimelineQuery(message, timelineQuery))
      .filter(({ message }) => !starredOnly || starredSignatures.has(message.signature));

    listContainer.innerHTML = items.map(({ message, index }) => {
      const starred = starredSignatures.has(message.signature);
      const selected = selectedMessageSignatures.has(message.signature);
      const preview = message.text.slice(0, 96).replace(/\s+/g, ' ');
      return `
        <div class="cgh-item${selected ? ' cgh-item-selected' : ''}${index === activeTimelineIndex ? ' cgh-item-active' : ''}" data-message-index="${index}">
          <button type="button" class="cgh-star-btn${starred ? ' cgh-starred' : ''}" data-action="toggle-star" title="${starred ? '取消星标' : '添加星标'}" aria-label="${starred ? '取消星标' : '添加星标'}" aria-pressed="${starred}">★</button>
          <button type="button" class="cgh-jump-btn" data-action="jump-message" aria-label="跳转到第 ${index + 1} 条消息">
            <span class="cgh-role">${message.role === 'user' ? '你' : 'GPT'}</span>
            <span class="cgh-preview">${escapeHtml(`${index + 1}. ${preview}`)}</span>
          </button>
        </div>`;
    }).join('') || '<div class="cgh-empty">没有匹配的消息</div>';
  }

  async function loadStarredMessages() {
    const data = await chrome.storage.local.get(STAR_STORAGE_KEY);
    const allStars = data[STAR_STORAGE_KEY] || {};
    starredSignatures = new Set(Array.isArray(allStars[activeConversationKey]) ? allStars[activeConversationKey] : []);
  }

  async function saveStarredMessages() {
    const data = await chrome.storage.local.get(STAR_STORAGE_KEY);
    const allStars = data[STAR_STORAGE_KEY] && typeof data[STAR_STORAGE_KEY] === 'object'
      ? data[STAR_STORAGE_KEY]
      : {};
    if (starredSignatures.size) allStars[activeConversationKey] = [...starredSignatures];
    else delete allStars[activeConversationKey];
    await chrome.storage.local.set({ [STAR_STORAGE_KEY]: allStars });
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
    if (target.closest('[data-action="toggle-star"]')) {
      const message = currentMessages[index];
      if (!message) return;
      if (starredSignatures.has(message.signature)) starredSignatures.delete(message.signature);
      else starredSignatures.add(message.signature);
      void saveStarredMessages();
      renderTimeline();
      return;
    }
    if (exportSelectionMode) {
      toggleMessageSelection(index);
      return;
    }

    activeTimelineIndex = index;
    queueMessageJump(index);
    renderTimeline();
  }

  function ensureExportSelectionListener() {
    if (exportClickListenerBound) return;
    document.addEventListener('click', handleExportSelectionClick, true);
    exportClickListenerBound = true;
  }

  function handleExportSelectionClick(event) {
    if (!exportSelectionMode) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#cgh-panel') || target.closest('#cgh-toast') || target.closest('#cgh-formula-copy-feedback')) {
      return;
    }

    const messageIndex = currentMessages.findIndex(message => message.node === target || message.node.contains(target));
    if (messageIndex < 0) return;

    event.preventDefault();
    event.stopPropagation();
    toggleMessageSelection(messageIndex);
  }

  function setExportSelectionMode(enabled, options = {}) {
    exportSelectionMode = enabled;
    document.documentElement.classList.toggle('cgh-export-mode', exportSelectionMode);

    if (!enabled && options.clearSelection) {
      selectedMessageSignatures.clear();
    }

    updateExportUi();
    if (enabled) {
      showToast('点击对话消息进行选择');
    }
  }

  function toggleMessageSelection(index) {
    const message = currentMessages[index];
    if (!message) return;

    if (selectedMessageSignatures.has(message.signature)) {
      selectedMessageSignatures.delete(message.signature);
    } else {
      selectedMessageSignatures.add(message.signature);
    }

    updateExportUi();
  }

  function syncSelectedMessagesWithCurrent() {
    const currentSignatures = new Set(currentMessages.map(message => message.signature));
    for (const signature of [...selectedMessageSignatures]) {
      if (!currentSignatures.has(signature)) {
        selectedMessageSignatures.delete(signature);
      }
    }
  }

  function getSelectedMessages() {
    return currentMessages.filter(message => selectedMessageSignatures.has(message.signature));
  }

  function updateExportUi() {
    updateSelectedMessageClasses();
    updateMessageListSelectionState();

    if (!panel) return;
    panel.classList.toggle('cgh-exporting', exportSelectionMode);

    const selectBtn = panel.querySelector('[data-action="export-select"]');
    const exportPngBtn = panel.querySelector('[data-action="export-png"]');
    const exportPdfBtn = panel.querySelector('[data-action="export-pdf"]');
    const exportMarkdownBtn = panel.querySelector('[data-action="export-markdown"]');
    const exportPrintPdfBtn = panel.querySelector('[data-action="export-print-pdf"]');
    const selectAllBtn = panel.querySelector('[data-action="select-all"]');
    const cancelBtn = panel.querySelector('[data-action="export-cancel"]');
    const statusEl = panel.querySelector('#cgh-export-status');
    const selectedCount = selectedMessageSignatures.size;

    if (selectBtn instanceof HTMLButtonElement) {
      selectBtn.textContent = exportSelectionMode ? '选择中' : '选择';
    }
    if (selectAllBtn instanceof HTMLButtonElement) {
      selectAllBtn.textContent = currentMessages.length > 0 && selectedCount === currentMessages.length ? '清空' : '全选';
    }
    if (exportPngBtn instanceof HTMLButtonElement) {
      exportPngBtn.disabled = selectedCount === 0 || exportRendering;
      exportPngBtn.textContent = exportRendering && activeExportFormat === 'png' ? '处理中' : 'PNG';
    }
    if (exportPdfBtn instanceof HTMLButtonElement) {
      exportPdfBtn.disabled = selectedCount === 0 || exportRendering;
      exportPdfBtn.textContent = exportRendering && activeExportFormat === 'pdf' ? '处理中' : 'PDF';
    }
    if (exportMarkdownBtn instanceof HTMLButtonElement) {
      exportMarkdownBtn.disabled = selectedCount === 0 || exportRendering;
      exportMarkdownBtn.textContent = exportRendering && activeExportFormat === 'markdown' ? '处理中' : 'MD';
    }
    if (exportPrintPdfBtn instanceof HTMLButtonElement) {
      exportPrintPdfBtn.disabled = selectedCount === 0 || exportRendering;
      exportPrintPdfBtn.textContent = exportRendering && activeExportFormat === 'print-pdf' ? '准备中' : '打印';
    }
    if (cancelBtn instanceof HTMLButtonElement) {
      cancelBtn.hidden = !exportSelectionMode && selectedCount === 0;
    }
    if (statusEl) {
      statusEl.textContent = selectedCount ? `已选择 ${selectedCount} 条消息` : (exportSelectionMode ? '点击消息选择导出内容' : '未选择消息');
    }
  }

  function updateSelectedMessageClasses() {
    for (const message of currentMessages) {
      if (!(message.node instanceof HTMLElement)) continue;
      message.node.classList.toggle('cgh-export-selected', selectedMessageSignatures.has(message.signature));
      message.node.classList.toggle('cgh-export-selectable', exportSelectionMode);
    }
  }

  function updateMessageListSelectionState() {
    if (!listContainer) return;
    listContainer.querySelectorAll('.cgh-item').forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      const index = Number(item.dataset.messageIndex);
      const message = currentMessages[index];
      const selected = !!message && selectedMessageSignatures.has(message.signature);
      item.classList.toggle('cgh-item-selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    renderTimeline();
  }

  async function exportSelectedMessages(format = 'png') {
    if (exportRendering) return;
    const exportFormat = ['pdf', 'print-pdf', 'markdown'].includes(format) ? format : 'png';
    const exportLabel = exportFormat === 'print-pdf' ? '打印 PDF' : exportFormat.toUpperCase();

    currentMessages = collectMessages();
    syncSelectedMessagesWithCurrent();
    const selectedMessages = getSelectedMessages();
    if (!selectedMessages.length) {
      showToast('请先选择消息');
      updateExportUi();
      return;
    }

    exportRendering = true;
    activeExportFormat = exportFormat;
    updateExportUi();
    showToast(exportFormat === 'print-pdf' ? '正在准备打印 PDF...' : `正在生成 ${exportLabel}...`, 0);

    let container = null;
    try {
      if (exportFormat === 'print-pdf') {
        await exportSelectedMessagesAsPrintPdf(selectedMessages);
        showToast('已打开打印窗口，请选择保存为 PDF', 4000);
        return;
      }
      if (exportFormat === 'markdown') {
        const markdown = buildMessagesMarkdown(selectedMessages);
        downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), buildExportFilename(0, 1, 'md'));
        showToast(`已导出 ${selectedMessages.length} 条消息`);
        return;
      }

      container = buildExportContainer(selectedMessages);
      document.body.appendChild(container);
      await waitForExportAssets(container);

      let dataUrls;
      let usedFallback = false;
      try {
        dataUrls = await renderElementToPngParts(container);
      } catch (primaryError) {
        console.warn('[CGH] DOM PNG export failed, using canvas fallback', primaryError);
        if (selectedMessages.some(message => hasExportableImages(message.node))) {
          throw new Error('图片导出被浏览器限制，请尝试重新打开页面后再导出');
        }
        dataUrls = [renderMessagesToCanvasPng(selectedMessages)];
        usedFallback = true;
      }

      if (exportFormat === 'pdf') {
        const pdfBlob = await buildPdfFromPngParts(dataUrls);
        downloadBlob(pdfBlob, buildExportFilename(0, 1, 'pdf'));
      } else {
        dataUrls.forEach((dataUrl, index) => {
          downloadDataUrl(dataUrl, buildExportFilename(index, dataUrls.length));
        });
      }

      const partText = exportFormat === 'pdf'
        ? (dataUrls.length > 1 ? `（${dataUrls.length} 页）` : '')
        : (dataUrls.length > 1 ? `（${dataUrls.length} 张）` : '');
      showToast(`已导出 ${selectedMessages.length} 条消息${partText}${usedFallback ? '（兼容模式）' : ''}`);
    } catch (error) {
      console.error(`[CGH] Failed to export ${exportLabel}`, error);
      showToast(`导出失败：${getErrorMessage(error)}`, 3000);
    } finally {
      container?.remove();
      exportRendering = false;
      activeExportFormat = null;
      updateExportUi();
    }
  }

  function buildMessagesMarkdown(messages) {
    const sections = messages.map((message, index) => {
      const role = message.role === 'user' ? '用户' : 'ChatGPT';
      const contentRoot = findMessageContentNode(message.node) || message.node;
      const content = domToMarkdown(contentRoot).trim() || message.text.trim();
      return `## ${index + 1}. ${role}\n\n${content}`;
    });
    return `# ChatGPT 对话摘录\n\n> 导出时间：${formatExportDate(new Date())}\n\n${sections.join('\n\n---\n\n')}\n`;
  }

  function domToMarkdown(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('button, script, style, svg, #cgh-panel, #cgh-toast').forEach(node => node.remove());
    clone.querySelectorAll(FORMULA_SELECTORS).forEach((formula) => {
      if (!formula.parentNode || formula.parentElement?.closest(FORMULA_SELECTORS)) return;
      const latex = extractLatexFromNode(formula);
      if (!latex) return;
      formula.replaceWith(document.createTextNode(isDisplayFormula(formula) ? `\n\n$$${normalizeLatexForMarkdown(latex)}$$\n\n` : `$${normalizeLatexForMarkdown(latex)}$`));
    });
    return markdownFromNode(clone)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function markdownFromNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof Element)) return '';

    const tag = node.tagName.toLowerCase();
    const children = () => [...node.childNodes].map(markdownFromNode).join('');
    if (tag === 'br') return '\n';
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === 'p') return `${children().trim()}\n\n`;
    if (tag === 'strong' || tag === 'b') return `**${children().trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${children().trim()}*`;
    if (tag === 'del' || tag === 's') return `~~${children().trim()}~~`;
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${children().trim()}\``;
    if (tag === 'pre') {
      const code = node.querySelector('code');
      const language = [...(code?.classList || [])].find(name => name.startsWith('language-'))?.slice(9) || '';
      return `\n\n\`\`\`${language}\n${(code?.textContent || node.textContent || '').trimEnd()}\n\`\`\`\n\n`;
    }
    if (tag === 'blockquote') {
      return `${children().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    }
    if (tag === 'ul' || tag === 'ol') {
      return `${[...node.children].filter(child => child.tagName.toLowerCase() === 'li').map((item, index) => `${tag === 'ol' ? `${index + 1}.` : '-'} ${markdownFromNode(item).trim()}`).join('\n')}\n\n`;
    }
    if (tag === 'li') return children();
    if (tag === 'a') {
      const label = children().trim() || node.getAttribute('href') || '';
      return node.getAttribute('href') ? `[${label}](${node.getAttribute('href')})` : label;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      return src ? `![${node.getAttribute('alt') || '图片'}](${src})` : '';
    }
    if (tag === 'table') return tableToMarkdown(node);
    const content = children();
    return ['div', 'section', 'article'].includes(tag) ? `${content}\n` : content;
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll('tr')].map(row =>
      [...row.querySelectorAll(':scope > th, :scope > td')].map(cell =>
        (cell.textContent || '').trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const normalized = rows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
    const header = normalized[0];
    return `\n\n| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${normalized.slice(1).map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
  }

  async function exportSelectedMessagesAsPrintPdf(messages) {
    let container = null;
    let printFrame = null;
    try {
      container = buildPrintPdfContainer(messages);
      container.style.position = 'fixed';
      container.style.left = '-10000px';
      container.style.top = '0';
      container.style.width = '794px';
      container.style.maxWidth = '794px';
      container.style.background = '#0d0d0d';
      container.style.color = '#f7f7f8';
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      document.body.appendChild(container);

      await waitForExportAssets(container);
      const title = buildPrintPdfTitle();
      const html = buildPrintPdfHtml(container.innerHTML, title);

      printFrame = await createPrintFrame(html);
      const printWindow = printFrame.contentWindow;
      if (!printWindow) {
        throw new Error('浏览器无法创建打印页面，请刷新后重试');
      }

      await waitForPrintWindowReady(printWindow);
      await printFromFrame(printWindow);
    } finally {
      printFrame?.remove();
      container?.remove();
    }
  }

  function createPrintFrame(html) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.className = 'cgh-print-frame';
      frame.title = 'ChatGPT 对话摘录打印页面';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.position = 'fixed';
      frame.style.left = '-10000px';
      frame.style.top = '0';
      frame.style.width = '794px';
      frame.style.height = '1123px';
      frame.style.border = '0';
      frame.style.opacity = '0';
      frame.style.pointerEvents = 'none';

      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        callback();
      };
      const timeoutId = window.setTimeout(() => {
        finish(() => {
          frame.remove();
          reject(new Error('打印页面加载超时，请重试'));
        });
      }, 3000);

      frame.addEventListener('load', () => finish(() => resolve(frame)), { once: true });
      frame.addEventListener('error', () => finish(() => {
        frame.remove();
        reject(new Error('打印页面加载失败，请重试'));
      }), { once: true });
      frame.srcdoc = html;
      document.body.appendChild(frame);
    });
  }

  async function printFromFrame(printWindow) {
    window.focus();
    printWindow.focus();

    // Let Chromium commit the frame focus before opening its modal print UI.
    await waitForAnimationFrames(printWindow, 2, 300);
    await new Promise((resolve, reject) => {
      printWindow.setTimeout(() => {
        try {
          printWindow.print();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 50);
    });
  }

  function buildPrintPdfContainer(messages) {
    const container = document.createElement('article');
    container.className = 'cgh-print-document';

    const title = document.createElement('h1');
    title.textContent = 'ChatGPT 对话摘录';
    container.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'cgh-print-meta';
    meta.textContent = `${formatExportDate(new Date())} · ${messages.length} 条消息`;
    container.appendChild(meta);

    for (const [index, message] of messages.entries()) {
      const section = document.createElement('section');
      section.className = `cgh-print-message cgh-print-${message.role === 'user' ? 'user' : 'assistant'}`;

      const role = document.createElement('div');
      role.className = 'cgh-print-role';
      role.textContent = `${index + 1}. ${message.role === 'user' ? '用户' : '助手'}`;
      section.appendChild(role);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'cgh-print-content';
      const content = message.role === 'user'
        ? buildUserExportContent(message)
        : extractExportContent(message.node);
      if (content.childNodes.length) {
        contentWrap.appendChild(content);
      } else {
        const paragraph = document.createElement('p');
        paragraph.textContent = message.text || `第 ${index + 1} 条消息`;
        contentWrap.appendChild(paragraph);
      }

      section.appendChild(contentWrap);
      container.appendChild(section);
    }

    return container;
  }

  function buildPrintPdfHtml(contentHtml, title) {
    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${escapeHtml(title)}</title>
          <style>${getPrintPdfCss()}</style>
        </head>
        <body>
          ${contentHtml}
        </body>
      </html>`;
  }

  function buildPrintPdfTitle() {
    return buildExportFilename(0, 1, 'pdf').replace(/\.pdf$/i, '');
  }

  function getPrintPdfCss() {
    return `
      @page {
        size: A4;
        margin: 1.8cm 1.8cm 1.6cm 1.8cm;
        background: #0d0d0d;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        padding: 0;
        background: #0d0d0d;
        color: #f7f7f8;
      }

      body {
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 12.5pt;
        line-height: 1.65;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: -1;
        background: #0d0d0d;
      }

      .cgh-print-document {
        width: 100%;
        color: #f7f7f8;
      }

      .cgh-print-document > h1 {
        margin: 0 0 20pt;
        color: #e5e7eb;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 13pt;
        font-weight: 700;
        line-height: 1.35;
        text-align: left;
        text-indent: 0;
        break-after: avoid;
        page-break-after: avoid;
      }

      .cgh-print-role {
        margin: 20pt 0 12pt;
        padding-top: 12pt;
        border-top: 0.75pt solid #2f2f2f;
        color: #a1a1aa;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 9pt;
        font-weight: 700;
        line-height: 1.3;
        text-align: left;
        text-indent: 0;
        break-after: avoid;
        page-break-after: avoid;
      }

      .cgh-print-content h1,
      .cgh-print-content h2 {
        margin: 20pt 0 12pt;
        color: #f7f7f8;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 24pt;
        font-weight: 700;
        line-height: 1.35;
        text-align: left;
        text-indent: 0;
        break-after: avoid;
        page-break-after: avoid;
      }

      .cgh-print-content h3 {
        margin: 18pt 0 10pt;
        color: #f7f7f8;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 18pt;
        font-weight: 700;
        line-height: 1.35;
        text-align: left;
        text-indent: 0;
        break-after: avoid;
        page-break-after: avoid;
      }

      .cgh-print-content h4,
      .cgh-print-content h5,
      .cgh-print-content h6 {
        margin: 14pt 0 8pt;
        color: #f7f7f8;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 15pt;
        font-weight: 700;
        line-height: 1.4;
        text-align: left;
        text-indent: 0;
        break-after: avoid;
        page-break-after: avoid;
      }

      .cgh-print-meta {
        margin: 0 0 18pt;
        color: #a1a1aa;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 9.5pt;
        line-height: 1.4;
        text-align: left;
        text-indent: 0;
      }

      .cgh-print-message {
        margin: 0 0 14pt;
        break-inside: auto;
        page-break-inside: auto;
      }

      .cgh-print-content,
      .cgh-print-content p,
      .cgh-print-content li,
      .cgh-print-content blockquote {
        color: #f7f7f8;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 13pt;
        line-height: 1.65;
        text-align: left;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .cgh-print-content > *,
      .cgh-print-content .markdown > * {
        max-width: 100% !important;
        min-width: 0 !important;
      }

      .cgh-print-content * {
        max-width: 100% !important;
        min-width: 0 !important;
        overflow: visible !important;
        overflow-x: visible !important;
        overflow-y: visible !important;
      }

      .cgh-print-content p {
        margin: 0 0 10pt;
        text-indent: 0;
      }

      .cgh-print-content p,
      .cgh-print-content li,
      .cgh-print-content span,
      .cgh-print-content strong,
      .cgh-print-content em,
      .cgh-print-content div {
        color: #f7f7f8 !important;
      }

      .cgh-print-content ul,
      .cgh-print-content ol {
        margin: 0 0 10pt 1.5em;
        padding: 0 0 0 1em;
      }

      .cgh-print-content li {
        margin: 0 0 5pt;
        padding-left: 0;
        text-indent: 0;
      }

      .cgh-print-content blockquote {
        margin: 10pt 0 10pt 1em;
        padding: 0 0 0 1em;
        border-left: 2pt solid #52525b;
        color: #d4d4d8;
        text-indent: 0;
      }

      .cgh-print-content a {
        color: #c7d2fe;
        text-decoration: underline;
      }

      .cgh-print-content pre,
      .cgh-print-content .cgh-export-code-block {
        margin: 12pt 0;
        padding: 10pt 12pt;
        color: #f4f4f5;
        background: #171717;
        border: 0.75pt solid #3f3f46;
        border-radius: 8pt;
        font-family: Consolas, "Courier New", monospace;
        font-size: 9.8pt;
        line-height: 1.55;
        max-width: 100%;
        min-width: 0;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        overflow: visible !important;
        overflow-x: visible !important;
        overflow-y: visible !important;
        text-align: left;
        text-indent: 0;
        break-inside: avoid;
        page-break-inside: avoid;
      }

      .cgh-print-content code,
      .cgh-print-content .cgh-export-code {
        color: #f4f4f5;
        font-family: Consolas, "Courier New", monospace;
        font-size: 9.8pt;
        background: transparent;
      }

      .cgh-print-content :not(pre) > code,
      .cgh-print-content :not(pre) > .cgh-export-code {
        padding: 1pt 3pt;
        background: #262626;
        border: 0.5pt solid #3f3f46;
        border-radius: 4pt;
      }

      .cgh-print-content img,
      .cgh-print-content .cgh-export-image {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 12pt auto;
        object-fit: contain;
        break-inside: avoid;
        page-break-inside: avoid;
      }

      .cgh-print-content .cgh-export-image-grid {
        display: block;
        margin: 12pt 0;
        text-align: center;
      }

      .cgh-print-content table,
      .cgh-print-content .cgh-export-table {
        width: auto;
        max-width: 100%;
        margin: 12pt auto;
        border-collapse: collapse;
        border-spacing: 0;
        color: #f7f7f8;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 10.5pt;
        line-height: 1.55;
        table-layout: auto;
        break-inside: auto;
        page-break-inside: auto;
      }

      .cgh-print-content th,
      .cgh-print-content td,
      .cgh-print-content .cgh-export-table-cell {
        padding: 6pt 8pt;
        border: 0.75pt solid #52525b;
        color: #f7f7f8;
        background: #111111;
        font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        font-size: 10.5pt;
        line-height: 1.55;
        text-align: left;
        vertical-align: top;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .cgh-print-content th {
        font-weight: 700;
        text-align: center;
        background: #1f1f1f;
      }

      .cgh-print-content .cgh-export-table-wrap {
        width: 100%;
        max-width: 100%;
        margin: 12pt auto;
        padding: 0;
        overflow: visible;
        text-align: center;
      }

      .cgh-print-content .cgh-export-overflow-wrap {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        height: auto !important;
        max-height: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        overflow: visible !important;
        overflow-x: visible !important;
        overflow-y: visible !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
        break-inside: auto !important;
        page-break-inside: auto !important;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }

      .cgh-print-content .cgh-export-overflow-wrap::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }

      .cgh-print-content .katex .katex-mathml,
      .cgh-print-content mjx-assistive-mml,
      .cgh-print-content semantics > annotation,
      .cgh-print-content semantics > annotation-xml {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
      }

      .cgh-print-content .katex,
      .cgh-print-content mjx-container,
      .cgh-print-content math,
      .cgh-print-content .cgh-export-formula {
        color: #f7f7f8;
        font-family: KaTeX_Main, MathJax_Main, "Times New Roman", "Cambria Math", serif;
        font-size: 18pt;
        line-height: 1.35;
        text-indent: 0;
      }

      .cgh-print-content .katex-display,
      .cgh-print-content mjx-container[display="true"],
      .cgh-print-content .cgh-export-formula-block {
        display: block;
        margin: 14pt auto;
        text-align: center;
        text-indent: 0;
        overflow: visible;
        break-inside: avoid;
        page-break-inside: avoid;
      }

      .cgh-print-content svg {
        max-width: 100%;
        overflow: visible;
      }

      .cgh-print-content .katex .fbox,
      .cgh-print-content .katex .fcolorbox {
        border-color: #f7f7f8 !important;
      }

      .cgh-print-content .katex .cancel-pad,
      .cgh-print-content .katex .boxpad {
        color: #f7f7f8 !important;
      }

      .cgh-print-content mjx-container svg [stroke]:not([stroke="none"]) {
        stroke: #f7f7f8 !important;
      }

      .cgh-print-content mjx-container svg [fill]:not([fill="none"]),
      .cgh-print-content .katex svg [fill]:not([fill="none"]) {
        fill: #f7f7f8 !important;
      }

      .cgh-print-content .cgh-export-formula,
      .cgh-print-content .cgh-export-formula * {
        background: transparent !important;
        box-shadow: none !important;
      }

      @media print {
        html,
        body {
          background: #0d0d0d !important;
          color: #f7f7f8 !important;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }

      ${collectMathFontCss()}
    `;
  }

  async function waitForPrintWindowReady(printWindow) {
    const doc = printWindow.document;
    const view = doc.defaultView || printWindow;

    await new Promise(resolve => {
      if (doc.readyState === 'complete') {
        resolve();
        return;
      }
      const done = () => resolve();
      view.addEventListener('load', done, { once: true });
      view.setTimeout(done, 1200);
    });

    if (doc.fonts?.ready) {
      try {
        await doc.fonts.ready;
      } catch (error) {
        // Font loading failures should not block the print dialog.
      }
    }

    const images = [...doc.images];
    await Promise.all(images.map(img => waitForPrintImage(img, view)));
    await waitForAnimationFrames(view);
  }

  function waitForAnimationFrames(view, frameCount = 2, timeoutMs = 250) {
    return new Promise(resolve => {
      let settled = false;
      let remainingFrames = frameCount;
      const finish = () => {
        if (settled) return;
        settled = true;
        view.clearTimeout(timeoutId);
        resolve();
      };
      const timeoutId = view.setTimeout(finish, timeoutMs);

      if (typeof view.requestAnimationFrame !== 'function') {
        return;
      }

      const onFrame = () => {
        remainingFrames -= 1;
        if (remainingFrames <= 0) {
          finish();
          return;
        }
        view.requestAnimationFrame(onFrame);
      };

      view.requestAnimationFrame(onFrame);
    });
  }

  function waitForPrintImage(img, view) {
    if (!img || String(img.tagName).toLowerCase() !== 'img') return Promise.resolve();
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      view.setTimeout(done, 2200);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildExportContainer(messages) {
    const container = document.createElement('div');
    container.className = 'cgh-export-canvas';

    const title = document.createElement('div');
    title.className = 'cgh-export-title';
    title.textContent = 'ChatGPT 对话摘录';
    container.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'cgh-export-meta';
    meta.textContent = `${formatExportDate(new Date())} · ${messages.length} 条消息`;
    container.appendChild(meta);

    for (const [index, message] of messages.entries()) {
      container.appendChild(buildExportMessage(message, index));
    }

    return container;
  }

  function buildExportMessage(message, index) {
    const wrapper = document.createElement('section');
    wrapper.className = `cgh-export-message cgh-export-${message.role === 'user' ? 'user' : 'assistant'}`;

    const label = document.createElement('div');
    label.className = 'cgh-export-label';
    label.textContent = message.role === 'user' ? '用户' : '助手';
    wrapper.appendChild(label);

    const bubble = document.createElement('div');
    bubble.className = 'cgh-export-bubble';

    const content = message.role === 'user'
      ? buildUserExportContent(message)
      : extractExportContent(message.node);
    if (content.childNodes.length) {
      bubble.appendChild(content);
    } else {
      bubble.textContent = message.text || `第 ${index + 1} 条消息`;
    }

    wrapper.appendChild(bubble);
    return wrapper;
  }

  function buildUserExportContent(message) {
    const container = buildPlainExportContent(message.text);
    appendExportImages(container, message.node);
    return container;
  }

  function buildPlainExportContent(text) {
    const container = document.createElement('div');
    container.className = 'cgh-export-plain';
    const blocks = normalizeWhitespacePreservingParagraphs(text || '').split(/\n{2,}/).filter(Boolean);
    for (const block of blocks) {
      const paragraph = document.createElement('p');
      paragraph.textContent = block;
      container.appendChild(paragraph);
    }
    return container;
  }

  function appendExportImages(container, sourceNode) {
    const images = collectExportableImages(sourceNode);
    if (!images.length) return;

    const grid = document.createElement('div');
    grid.className = 'cgh-export-image-grid';

    for (const sourceImage of images) {
      const image = sourceImage.cloneNode(false);
      const src = sourceImage.currentSrc || sourceImage.src || sourceImage.getAttribute('src') || '';
      if (src) {
        image.src = src;
      }
      image.className = 'cgh-export-image';
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
      image.removeAttribute('style');
      image.loading = 'eager';
      image.decoding = 'sync';
      image.referrerPolicy = 'no-referrer';
      grid.appendChild(image);
    }

    container.appendChild(grid);
  }

  function collectExportableImages(root) {
    if (!(root instanceof Element)) return [];
    return [...root.querySelectorAll('img')].filter((img) => {
      if (!(img instanceof HTMLImageElement)) return false;
      if (img.closest('#cgh-panel, #cgh-toast, #cgh-formula-copy-feedback')) return false;
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:image/svg+xml')) return false;
      if (/avatar|user|profile/i.test(`${img.alt || ''} ${img.className || ''}`) && !img.closest('[data-message-author-role="user"]')) return false;
      const rect = img.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || Number(img.getAttribute('width')) || rect.width;
      const naturalHeight = img.naturalHeight || Number(img.getAttribute('height')) || rect.height;
      return naturalWidth >= 24 && naturalHeight >= 24;
    });
  }

  function hasExportableImages(node) {
    return collectExportableImages(node).length > 0;
  }

  function extractExportContent(node) {
    const source = findMessageContentNode(node) || node;
    const clone = source.cloneNode(true);

    clone.querySelectorAll([
      '#cgh-panel',
      '#cgh-toast',
      '#cgh-formula-copy-feedback',
      '.cgh-export-selection-badge',
      'button',
      '[role="button"]',
      '[data-testid*="copy"]',
      '[data-testid*="turn-action"]',
    ].join(',')).forEach(el => el.remove());

    clone.classList?.remove('cgh-export-selected', 'cgh-export-selectable', 'cgh-target-message');
    stripInlineInteractionAttributes(clone);
    normalizeExportContent(clone);
    return clone;
  }

  function findMessageContentNode(node) {
    if (!(node instanceof Element)) return null;

    const candidates = [
      '[data-message-author-role] [data-message-id]',
      '[data-message-author-role] .markdown',
      '.markdown',
      '[data-testid="conversation-turn"] .markdown',
      '[class*="markdown"]',
    ];

    for (const selector of candidates) {
      const candidate = node.matches(selector) ? node : node.querySelector(selector);
      if (candidate instanceof Element && normalizeWhitespace(candidate.textContent || '')) {
        return candidate;
      }
    }

    return null;
  }

  function stripInlineInteractionAttributes(root) {
    const nodes = root.querySelectorAll('*');
    for (const node of [root, ...nodes]) {
      if (!(node instanceof Element)) continue;
      for (const attr of [...node.attributes]) {
        if (attr.name.startsWith('on')) {
          node.removeAttribute(attr.name);
        }
      }
      node.removeAttribute('contenteditable');
      node.removeAttribute('tabindex');
      node.classList.remove('cgh-formula-target', 'cgh-formula-hovered', 'cgh-formula-block', 'cgh-formula-copied');
    }
  }

  function normalizeExportContent(root) {
    normalizeExportTables(root);
    normalizeExportOverflow(root);

    root.querySelectorAll('pre').forEach((pre) => {
      pre.classList.add('cgh-export-code-block');
    });
    root.querySelectorAll('code').forEach((code) => {
      code.classList.add('cgh-export-code');
    });
    root.querySelectorAll(FORMULA_SELECTORS).forEach((formula) => {
      formula.classList.add('cgh-export-formula');
      if (isDisplayFormula(formula)) {
        formula.classList.add('cgh-export-formula-block');
      }
      stripFormulaContainerChrome(formula);
    });
    root.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      img.decoding = 'sync';
      img.referrerPolicy = 'no-referrer';
    });
  }

  function normalizeExportOverflow(root) {
    const elements = [root, ...root.querySelectorAll('*')];

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.matches('table, th, td, img, svg, math, .katex, mjx-container')) continue;
      if (!element.matches('pre') && !hasExportOverflowBehavior(element)) continue;
      element.classList.add('cgh-export-overflow-wrap');
      element.style.setProperty('max-width', '100%', 'important');
      element.style.setProperty('min-width', '0', 'important');
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('max-height', 'none', 'important');
      element.style.setProperty('overflow', 'visible', 'important');
      element.style.setProperty('overflow-x', 'visible', 'important');
      element.style.setProperty('overflow-y', 'visible', 'important');
      element.style.setProperty('overflow-wrap', 'anywhere', 'important');
      element.style.setProperty('word-break', 'break-word', 'important');
      if (element.matches('pre, code')) {
        element.style.setProperty('white-space', 'pre-wrap', 'important');
      } else {
        element.style.setProperty('white-space', 'normal', 'important');
      }
    }
  }

  function hasExportOverflowBehavior(element) {
    const className = typeof element.className === 'string' ? element.className : '';
    const inlineStyle = element.getAttribute('style') || '';
    const hints = `${className} ${inlineStyle}`;

    if (/(?:overflow(?:-[xy])?(?:-|\s*:\s*(?:auto|scroll|overlay|hidden))|scrollbar|whitespace-(?:nowrap|pre|pre-wrap|break-spaces)|text-nowrap|break-keep|white-space\s*:\s*(?:nowrap|pre|pre-wrap)|max-w-max|w-max)/i.test(hints)) {
      return true;
    }

    const style = window.getComputedStyle(element);
    return /(auto|scroll|overlay|hidden)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`) ||
      style.whiteSpace === 'nowrap' ||
      style.width === 'max-content' ||
      style.width === 'fit-content' ||
      style.minWidth === 'max-content';
  }

  function normalizeExportTables(root) {
    root.querySelectorAll('table').forEach((table) => {
      table.classList.add('cgh-export-table');
      table.removeAttribute('style');

      const columnCount = getTableColumnCount(table);
      if (columnCount > 0) {
        table.style.setProperty('--cgh-table-columns', String(columnCount));
      }

      markTableWrappersForExport(table, root);
    });

    root.querySelectorAll('th, td').forEach((cell) => {
      cell.removeAttribute('style');
      cell.classList.add('cgh-export-table-cell');
    });
  }

  function getTableColumnCount(table) {
    const rows = [...table.querySelectorAll('tr')];
    return rows.reduce((max, row) => {
      const count = [...row.children].reduce((sum, cell) => {
        const span = Number(cell.getAttribute('colspan') || '1');
        return sum + (Number.isFinite(span) ? Math.max(1, span) : 1);
      }, 0);
      return Math.max(max, count);
    }, 0);
  }

  function shouldFlattenTableWrapper(wrapper) {
    if (!(wrapper instanceof HTMLElement)) return false;
    const className = wrapper.className || '';
    const style = window.getComputedStyle(wrapper);
    return /overflow|table|scroll|markdown/i.test(String(className)) ||
      /(auto|scroll|overlay|hidden)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`);
  }

  function markTableWrappersForExport(table, root) {
    let current = table.parentElement;
    while (current && current !== root) {
      if (!(current instanceof HTMLElement)) break;

      if (shouldFlattenTableWrapper(current) || current.querySelector('table') === table) {
        current.classList.add('cgh-export-table-wrap');
        current.removeAttribute('style');
      }

      current = current.parentElement;
    }
  }

  function stripFormulaContainerChrome(formula) {
    if (!(formula instanceof HTMLElement || formula instanceof SVGElement)) return;

    const targets = [
      formula,
      ...formula.querySelectorAll('.katex-display, .katex, .katex-html, mjx-container, svg, math'),
    ];

    for (const target of targets) {
      if (!(target instanceof HTMLElement || target instanceof SVGElement)) continue;
      target.style.setProperty('background', 'transparent', 'important');
      target.style.setProperty('background-color', 'transparent', 'important');
      target.style.setProperty('border', '0', 'important');
      target.style.setProperty('box-shadow', 'none', 'important');
    }

    formula.querySelectorAll('.katex, .katex *').forEach((node) => {
      if (node instanceof HTMLElement) {
        node.style.removeProperty('font-family');
      }
    });

    formula.style.setProperty('padding', '0', 'important');
    formula.style.setProperty('border-radius', '0', 'important');
  }

  async function waitForExportAssets(container) {
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch (error) {
        // Font loading failures should not block image export.
      }
    }

    const images = [...container.querySelectorAll('img')];
    await Promise.all(images.map(waitForImage));
    await Promise.all(images.map(inlineImageForCanvas));
    await waitForLayoutStability(120);
  }

  function waitForImage(img) {
    if (!(img instanceof HTMLImageElement)) return Promise.resolve();
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      window.setTimeout(done, 1800);
    });
  }

  async function inlineImageForCanvas(img) {
    if (!(img instanceof HTMLImageElement)) return;
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:')) return;

    try {
      const fetchedDataUrl = await fetchImageAsDataUrl(src);
      if (fetchedDataUrl) {
        img.src = fetchedDataUrl;
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        return;
      }
    } catch (error) {
      console.warn('[CGH] Failed to fetch export image', error);
    }

    try {
      const canvas = document.createElement('canvas');
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) return;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(img, 0, 0, width, height);
      img.src = canvas.toDataURL('image/png');
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    } catch (error) {
      console.warn('[CGH] Failed to inline export image', error);
    }
  }

  async function fetchImageAsDataUrl(src) {
    const response = await fetch(src, { credentials: 'include', cache: 'force-cache' });
    if (!response.ok) return '';
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return '';
    return await blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error || new Error('Image read failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function renderElementToPngParts(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const scale = getExportScale(width, height);
    const exportClone = cloneElementWithInlineStyles(element);
    exportClone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    injectMathFontStyles(exportClone);
    const html = new XMLSerializer().serializeToString(exportClone);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <foreignObject width="100%" height="100%">
          ${html}
        </foreignObject>
      </svg>
    `;
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await loadImage(svgUrl);
    return renderImageToPngParts(image, width, height, scale);
  }

  function renderImageToPngParts(image, width, height, scale) {
    const maxCanvasPixels = 24000000;
    const maxPartHeight = Math.max(1200, Math.floor(maxCanvasPixels / Math.max(1, width * scale * scale)));
    const parts = [];

    for (let sourceY = 0; sourceY < height; sourceY += maxPartHeight) {
      const partHeight = Math.min(maxPartHeight, height - sourceY);
      parts.push(renderImageSliceToPng(image, width, partHeight, sourceY, scale));
    }

    return parts;
  }

  function renderImageSliceToPng(image, width, height, sourceY, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context unavailable');
    context.scale(scale, scale);
    context.drawImage(image, 0, sourceY, width, height, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  }

  function getExportScale(width, height) {
    const deviceScale = Math.min(2, window.devicePixelRatio || 1);
    const maxSide = 32767;
    const maxPixels = 24000000;
    const sideScale = Math.min(maxSide / Math.max(width, height), deviceScale);
    const pixelScale = Math.sqrt(maxPixels / Math.max(1, width * height));
    return Math.max(1, Math.min(deviceScale, sideScale, pixelScale));
  }

  function renderMessagesToCanvasPng(messages) {
    const width = 1040;
    const padding = 34;
    const maxBubbleWidth = 880;
    const bubblePaddingX = 18;
    const bubblePaddingY = 16;
    const lineHeight = 26;
    const paragraphGap = 10;
    const messageGap = 18;
    const labelHeight = 18;
    const labelGap = 8;
    const scale = Math.min(2, window.devicePixelRatio || 1);

    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    if (!measureContext) throw new Error('Canvas context unavailable');

    const measuredMessages = messages.map((message) => {
      measureContext.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
      const contentWidth = maxBubbleWidth - bubblePaddingX * 2;
      const blocks = buildCanvasTextBlocks(message.text || '');
      const measuredBlocks = blocks.map(block => {
        const lines = wrapCanvasText(measureContext, block.text, contentWidth);
        const maxLineWidth = lines.reduce((max, line) => Math.max(max, measureContext.measureText(line).width), 0);
        return { ...block, lines, maxLineWidth };
      });

      const textHeight = measuredBlocks.reduce((height, block, index) => {
        const blockHeight = Math.max(1, block.lines.length) * lineHeight;
        return height + blockHeight + (index === measuredBlocks.length - 1 ? 0 : paragraphGap);
      }, 0);
      const maxLineWidth = measuredBlocks.reduce((max, block) => Math.max(max, block.maxLineWidth), 0);
      const bubbleWidth = Math.min(maxBubbleWidth, Math.max(240, Math.ceil(maxLineWidth + bubblePaddingX * 2)));
      const bubbleHeight = bubblePaddingY * 2 + textHeight;

      return {
        role: message.role === 'user' ? 'user' : 'assistant',
        blocks: measuredBlocks,
        bubbleWidth,
        bubbleHeight,
        totalHeight: labelHeight + labelGap + bubbleHeight,
      };
    });

    const headerHeight = 30 + 6 + 20 + 24;
    const contentHeight = measuredMessages.reduce((height, message, index) => {
      return height + message.totalHeight + (index === measuredMessages.length - 1 ? 0 : messageGap);
    }, 0);
    const height = Math.ceil(padding * 2 + headerHeight + contentHeight);
    if (height > 32000) {
      throw new Error('图片过长，请分批导出');
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context unavailable');
    context.scale(scale, scale);
    context.fillStyle = '#0d0d0d';
    context.fillRect(0, 0, width, height);

    let y = padding;
    context.fillStyle = '#f9fafb';
    context.font = '800 24px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
    context.textBaseline = 'top';
    context.fillText('ChatGPT 对话摘录', padding, y);
    y += 36;

    context.fillStyle = '#94a3b8';
    context.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
    context.fillText(`${formatExportDate(new Date())} · ${messages.length} 条消息 · 兼容模式`, padding, y);
    y += 44;

    for (let index = 0; index < measuredMessages.length; index += 1) {
      const message = measuredMessages[index];
      const isUser = message.role === 'user';
      const bubbleX = isUser ? width - padding - message.bubbleWidth : padding;
      const contentX = isUser ? bubbleX + bubblePaddingX : bubbleX;
      const label = isUser ? '用户' : '助手';
      const labelWidth = context.measureText(label).width;

      context.fillStyle = '#94a3b8';
      context.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
      context.fillText(label, isUser ? bubbleX + message.bubbleWidth - labelWidth : bubbleX, y);
      y += labelHeight + labelGap;

      if (isUser) {
        drawRoundRect(context, bubbleX, y, message.bubbleWidth, message.bubbleHeight, 14);
        context.fillStyle = '#2f2f2f';
        context.fill();
        context.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        context.lineWidth = 1;
        context.stroke();
      }

      let textY = y + (isUser ? bubblePaddingY : 0);
      const textX = contentX;
      context.textBaseline = 'top';

      for (let blockIndex = 0; blockIndex < message.blocks.length; blockIndex += 1) {
        const block = message.blocks[blockIndex];
        const formulaLike = isFormulaTextBlock(block.text);
        context.fillStyle = formulaLike ? '#d8d8d8' : '#ececec';
        context.font = formulaLike
          ? '16px "Times New Roman", "Cambria Math", serif'
          : '16px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';

        for (const line of block.lines) {
          context.fillText(line, textX, textY);
          textY += lineHeight;
        }

        if (blockIndex !== message.blocks.length - 1) {
          textY += paragraphGap;
        }
      }

      y += (isUser ? message.bubbleHeight : message.bubbleHeight - bubblePaddingY * 2) + (index === measuredMessages.length - 1 ? 0 : messageGap);
    }

    return canvas.toDataURL('image/png');
  }

  function buildCanvasTextBlocks(text) {
    const normalized = normalizeWhitespacePreservingParagraphs(text || '');
    if (!normalized) return [{ text: '' }];
    return normalized.split(/\n{2,}/).map(block => ({ text: block.trim() })).filter(block => block.text);
  }

  function normalizeWhitespacePreservingParagraphs(text) {
    return String(text)
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function wrapCanvasText(context, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text || '').split('\n');
    for (const paragraph of paragraphs) {
      const tokens = tokenizeForCanvasWrap(paragraph);
      let line = '';

      for (const token of tokens) {
        const nextLine = line ? `${line}${token}` : token.trimStart();
        if (!nextLine) continue;

        if (context.measureText(nextLine).width <= maxWidth) {
          line = nextLine;
          continue;
        }

        if (line) {
          lines.push(line.trimEnd());
          line = '';
        }

        if (context.measureText(token).width <= maxWidth) {
          line = token.trimStart();
        } else {
          line = wrapLongCanvasToken(context, token, maxWidth, lines);
        }
      }

      if (line) {
        lines.push(line.trimEnd());
      } else if (!tokens.length) {
        lines.push('');
      }
    }

    return lines.length ? lines : [''];
  }

  function tokenizeForCanvasWrap(text) {
    return String(text || '').match(/[\u3400-\u9FFF\uF900-\uFAFF]|[^\s\u3400-\u9FFF\uF900-\uFAFF]+|\s+/g) || [];
  }

  function wrapLongCanvasToken(context, token, maxWidth, lines) {
    let line = '';
    for (const char of [...token]) {
      const nextLine = line + char;
      if (context.measureText(nextLine).width <= maxWidth) {
        line = nextLine;
      } else {
        if (line) lines.push(line);
        line = char;
      }
    }
    return line;
  }

  function isFormulaTextBlock(text) {
    const trimmed = String(text || '').trim();
    return /^\${1,2}[\s\S]+\${1,2}$/.test(trimmed) || /\\(?:frac|sqrt|sum|int|alpha|beta|gamma|theta|lambda|mu|sigma|omega|begin|end)\b/.test(trimmed);
  }

  function drawRoundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function cloneElementWithInlineStyles(element) {
    const clone = element.cloneNode(true);
    inlineComputedStyles(element, clone);
    applyExportTableInlineOverrides(clone);
    clone.style.setProperty('position', 'static');
    clone.style.setProperty('left', 'auto');
    clone.style.setProperty('top', 'auto');
    clone.style.setProperty('right', 'auto');
    clone.style.setProperty('bottom', 'auto');
    clone.style.setProperty('margin', '0');
    return clone;
  }

  function applyExportTableInlineOverrides(root) {
    root.querySelectorAll('.cgh-export-table-wrap').forEach((wrapper) => {
      if (!(wrapper instanceof HTMLElement)) return;
      wrapper.style.setProperty('width', '100%', 'important');
      wrapper.style.setProperty('max-width', '100%', 'important');
      wrapper.style.setProperty('overflow', 'visible', 'important');
      wrapper.style.setProperty('overflow-x', 'visible', 'important');
      wrapper.style.setProperty('overflow-y', 'visible', 'important');
      wrapper.style.setProperty('margin', '1em 0', 'important');
      wrapper.style.setProperty('padding', '0', 'important');
      wrapper.style.setProperty('scrollbar-width', 'none', 'important');
      wrapper.style.setProperty('-ms-overflow-style', 'none', 'important');
    });

    root.querySelectorAll('.cgh-export-table').forEach((table) => {
      if (!(table instanceof HTMLElement)) return;
      table.style.setProperty('width', '100%', 'important');
      table.style.setProperty('max-width', '100%', 'important');
      table.style.setProperty('min-width', '0', 'important');
      table.style.setProperty('table-layout', 'fixed', 'important');
      table.style.setProperty('border-collapse', 'separate', 'important');
      table.style.setProperty('border-spacing', '0', 'important');
      table.style.setProperty('overflow', 'hidden', 'important');
      table.style.setProperty('border', '1px solid rgba(255, 255, 255, 0.14)', 'important');
      table.style.setProperty('border-radius', '10px', 'important');
      table.style.setProperty('background', '#111111', 'important');
      table.style.setProperty('font-size', '0.86em', 'important');
      table.style.setProperty('line-height', '1.48', 'important');
    });

    root.querySelectorAll('.cgh-export-table-cell').forEach((cell) => {
      if (!(cell instanceof HTMLElement)) return;
      cell.style.setProperty('min-width', '0', 'important');
      cell.style.setProperty('max-width', 'none', 'important');
      cell.style.setProperty('border', '0', 'important');
      cell.style.setProperty('border-right', '1px solid rgba(255, 255, 255, 0.12)', 'important');
      cell.style.setProperty('border-bottom', '1px solid rgba(255, 255, 255, 0.12)', 'important');
      cell.style.setProperty('padding', '8px 10px', 'important');
      cell.style.setProperty('vertical-align', 'top', 'important');
      cell.style.setProperty('white-space', 'normal', 'important');
      cell.style.setProperty('overflow-wrap', 'anywhere', 'important');
      cell.style.setProperty('word-break', 'break-word', 'important');
    });
  }

  function injectMathFontStyles(root) {
    const cssText = collectMathFontCss();
    if (!cssText) return;

    const style = document.createElement('style');
    style.textContent = cssText;
    root.insertBefore(style, root.firstChild);
  }

  function collectMathFontCss() {
    const chunks = [];
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (error) {
        continue;
      }
      if (!rules) continue;

      for (const rule of [...rules]) {
        const text = rule.cssText || '';
        if (/(katex|KaTeX|MathJax|MJX|mjx|mjx-container|mjx-assistive-mml)/.test(text)) {
          chunks.push(text);
        }
      }
    }

    chunks.push(`
      .katex, .katex * {
        font-family: KaTeX_Main, KaTeX_Math, KaTeX_Size1, KaTeX_AMS, "Times New Roman", serif !important;
      }
      .katex .mathnormal, .katex .mord.mathnormal, .katex .mord.text {
        font-family: KaTeX_Math, KaTeX_Main, "Times New Roman", serif !important;
      }
      .katex .mathbf {
        font-family: KaTeX_Main, "Times New Roman", serif !important;
        font-weight: 700 !important;
      }
      mjx-container, mjx-container * {
        font-family: MathJax_Main, MathJax_Math, MJXZERO, "Times New Roman", serif !important;
      }
    `);

    return chunks.join('\n');
  }

  function inlineComputedStyles(source, target) {
    if (!(source instanceof Element) || !(target instanceof Element)) return;

    const computed = window.getComputedStyle(source);
    const importantProperties = [
      'align-items',
      'background',
      'background-color',
      'border',
      'border-bottom',
      'border-bottom-color',
      'border-bottom-left-radius',
      'border-bottom-right-radius',
      'border-bottom-style',
      'border-bottom-width',
      'border-collapse',
      'border-color',
      'border-left',
      'border-left-color',
      'border-left-style',
      'border-left-width',
      'border-radius',
      'border-right',
      'border-right-color',
      'border-right-style',
      'border-right-width',
      'border-spacing',
      'border-style',
      'border-top',
      'border-top-color',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-top-style',
      'border-top-width',
      'border-width',
      'box-shadow',
      'box-sizing',
      'color',
      'display',
      'flex-direction',
      'flex-wrap',
      'font',
      'font-family',
      'font-size',
      'font-style',
      'font-variant',
      'font-variant-numeric',
      'font-weight',
      'gap',
      'grid-template-columns',
      'height',
      'justify-content',
      'letter-spacing',
      'left',
      'line-height',
      'list-style',
      'list-style-position',
      'list-style-type',
      'margin',
      'margin-bottom',
      'margin-left',
      'margin-right',
      'margin-top',
      'max-height',
      'max-width',
      'min-height',
      'min-width',
      'object-fit',
      'opacity',
      'overflow',
      'overflow-wrap',
      'padding',
      'padding-bottom',
      'padding-left',
      'padding-right',
      'padding-top',
      'position',
      'right',
      'text-align',
      'text-decoration',
      'text-indent',
      'text-transform',
      'top',
      'transform',
      'transform-origin',
      'vertical-align',
      'white-space',
      'width',
      'word-break',
    ];

    for (const property of importantProperties) {
      const value = computed.getPropertyValue(property);
      if (value) {
        target.style.setProperty(property, value);
      }
    }

    if (computed.display === 'inline') {
      target.style.setProperty('display', 'inline');
    }

    const sourceChildren = [...source.children];
    const targetChildren = [...target.children];
    for (let index = 0; index < sourceChildren.length; index += 1) {
      inlineComputedStyles(sourceChildren[index], targetChildren[index]);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image load failed'));
      image.src = src;
    });
  }

  function downloadDataUrl(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function buildPdfFromPngParts(dataUrls) {
    if (!dataUrls.length) throw new Error('没有可写入 PDF 的图片');

    const images = [];
    for (const dataUrl of dataUrls) {
      const image = await loadImage(dataUrl);
      images.push(await preparePdfImage(image));
    }

    return createImagePdf(images);
  }

  async function preparePdfImage(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('图片尺寸无效');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas context unavailable');

    context.fillStyle = '#0d0d0d';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const rgba = context.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
      rgb[target] = rgba[source];
      rgb[target + 1] = rgba[source + 1];
      rgb[target + 2] = rgba[source + 2];
    }

    const compressed = await deflatePdfBytes(rgb);
    return {
      width,
      height,
      data: compressed.data,
      filter: compressed.filter,
    };
  }

  async function deflatePdfBytes(bytes) {
    if (typeof CompressionStream !== 'function') {
      return { data: bytes, filter: '' };
    }

    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      const blob = await new Response(stream).blob();
      return {
        data: new Uint8Array(await blob.arrayBuffer()),
        filter: '/Filter /FlateDecode',
      };
    } catch (error) {
      console.warn('[CGH] PDF compression failed, writing raw image stream', error);
      return { data: bytes, filter: '' };
    }
  }

  function createImagePdf(images) {
    const pageTreeId = 2;
    const objectCount = 2 + images.length * 3;
    const pageIds = images.map((_, index) => 3 + index * 3);
    const chunks = [];
    const offsets = new Array(objectCount + 1).fill(0);
    const encoder = new TextEncoder();
    let byteOffset = 0;

    const appendString = (value) => {
      const bytes = encoder.encode(value);
      chunks.push(bytes);
      byteOffset += bytes.length;
    };

    const appendBytes = (bytes) => {
      chunks.push(bytes);
      byteOffset += bytes.length;
    };

    const addObject = (id, parts) => {
      offsets[id] = byteOffset;
      appendString(`${id} 0 obj\n`);
      for (const part of Array.isArray(parts) ? parts : [parts]) {
        if (typeof part === 'string') appendString(part);
        else appendBytes(part);
      }
      appendString('\nendobj\n');
    };

    appendString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObject(pageTreeId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);

    images.forEach((image, index) => {
      const pageId = 3 + index * 3;
      const contentId = pageId + 1;
      const imageId = pageId + 2;
      const pageSize = getPdfPageSize(image.width, image.height);
      const pageWidth = formatPdfNumber(pageSize.width);
      const pageHeight = formatPdfNumber(pageSize.height);
      const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${index + 1} Do\nQ`;

      addObject(pageId, `<< /Type /Page /Parent ${pageTreeId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index + 1} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      addObject(contentId, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
      addObject(imageId, [
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false ${image.filter} /Length ${image.data.length} >>\nstream\n`,
        image.data,
        '\nendstream',
      ]);
    });

    const xrefOffset = byteOffset;
    appendString(`xref\n0 ${objectCount + 1}\n`);
    appendString('0000000000 65535 f \n');
    for (let id = 1; id <= objectCount; id += 1) {
      appendString(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    appendString(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  function getPdfPageSize(imageWidth, imageHeight) {
    const a4WidthPoints = 595.28;
    const maxPagePoints = 14400;
    const heightAtA4Width = a4WidthPoints * imageHeight / imageWidth;
    const width = heightAtA4Width > maxPagePoints
      ? maxPagePoints * imageWidth / imageHeight
      : a4WidthPoints;
    return {
      width,
      height: width * imageHeight / imageWidth,
    };
  }

  function formatPdfNumber(value) {
    return Number(value).toFixed(2).replace(/\.?0+$/, '') || '0';
  }

  function buildExportFilename(partIndex = 0, partCount = 1, extension = 'png') {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const suffix = partCount > 1 ? `-part-${String(partIndex + 1).padStart(2, '0')}` : '';
    return `chatgpt-conversation-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${suffix}.${extension}`;
  }

  function formatExportDate(date) {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function getErrorMessage(error) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return '未知错误';
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

  function isNodeVisibleEnough(node) {
    if (!(node instanceof Element)) return false;

    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
  }

  async function waitForLayoutStability(delayMs = 120) {
    if (document.visibilityState === 'hidden') return;
    await new Promise(resolve => window.setTimeout(resolve, delayMs));
    if (document.visibilityState === 'hidden') return;
    await waitForAnimationFrames(window);
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

  function applyReadingSettings() {
    document.documentElement.classList.toggle('cgh-reading-enabled', settings.readingEnabled);
    document.documentElement.style.setProperty('--cgh-reading-width', `${settings.readingWidth}px`);
    document.documentElement.style.setProperty('--cgh-font-scale', String(settings.fontScale / 100));
    document.documentElement.style.setProperty('--cgh-line-height', String(settings.lineHeight));
    document.documentElement.style.setProperty('--cgh-paragraph-spacing', `${settings.paragraphSpacing}em`);
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS.split(',').map(value => value.trim())) {
      const match = [...document.querySelectorAll(selector)].find(element => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (match) return match;
    }
    return null;
  }

  function readComposerText(input) {
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
    return input.innerText || input.textContent || '';
  }

  function insertIntoComposer(text, replace = false) {
    const input = findComposer();
    if (!input) return false;
    input.focus();

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const existing = replace ? '' : input.value;
      const prefix = existing && !existing.endsWith('\n') ? '\n\n' : '';
      input.value = `${existing}${prefix}${text}`;
      input.selectionStart = input.selectionEnd = input.value.length;
    } else {
      if (replace) input.textContent = '';
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const prefix = !replace && readComposerText(input).trim() ? '\n\n' : '';
      if (!document.execCommand('insertText', false, `${prefix}${text}`)) {
        input.appendChild(document.createTextNode(`${prefix}${text}`));
      }
    }

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  function startDraftSave() {
    attachDraftInput();
    draftObserver = new MutationObserver(() => attachDraftInput());
    draftObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', saveDraftNow);
    document.addEventListener('keydown', handleDraftSendKey, true);
    document.addEventListener('click', handleDraftSendClick, true);
    window.setTimeout(() => void restoreDraft(), 450);
  }

  function handleDraftSendKey(event) {
    if (!settings.draftSaveEnabled || event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    if (!(event.target instanceof Element) || !event.target.closest(COMPOSER_SELECTORS)) return;
    scheduleDraftClear(activeConversationKey);
  }

  function handleDraftSendClick(event) {
    if (!settings.draftSaveEnabled || !(event.target instanceof Element)) return;
    if (!event.target.closest('button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="发送"]')) return;
    scheduleDraftClear(activeConversationKey);
  }

  function scheduleDraftClear(conversationKey) {
    window.clearTimeout(draftSaveTimer);
    window.setTimeout(() => void chrome.storage.local.remove(`${DRAFT_STORAGE_PREFIX}${conversationKey}`), 800);
  }

  function attachDraftInput() {
    const input = findComposer();
    if (!input || input === draftInput) return;
    draftInput?.removeEventListener('input', scheduleDraftSave);
    draftInput = input;
    draftInput.addEventListener('input', scheduleDraftSave);
  }

  function scheduleDraftSave() {
    if (!settings.draftSaveEnabled) return;
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(saveDraftNow, 350);
  }

  function saveDraftNow() {
    if (!settings.draftSaveEnabled || !draftInput) return;
    const key = `${DRAFT_STORAGE_PREFIX}${activeConversationKey}`;
    const text = readComposerText(draftInput).trimEnd();
    if (text.trim()) {
      void chrome.storage.local.set({ [key]: { text, updatedAt: Date.now() } });
    } else {
      void chrome.storage.local.remove(key);
    }
  }

  async function restoreDraft() {
    if (!settings.draftSaveEnabled) return;
    attachDraftInput();
    if (!draftInput || readComposerText(draftInput).trim()) return;
    const key = `${DRAFT_STORAGE_PREFIX}${activeConversationKey}`;
    const data = await chrome.storage.local.get(key);
    const draft = data[key];
    if (!draft?.text || Date.now() - Number(draft.updatedAt || 0) > 30 * 24 * 60 * 60 * 1000) {
      if (draft) await chrome.storage.local.remove(key);
      return;
    }
    insertIntoComposer(draft.text, true);
  }

  function handleFormulaPointerOver(event) {
    const node = findFormulaNode(event.target);
    if (!node) return;

    const related = event.relatedTarget;
    if (node === hoveredFormulaNode && related instanceof Node && node.contains(related)) return;
    setFormulaHover(node);
  }

  function handleFormulaPointerOut(event) {
    const node = findFormulaNode(event.target) || hoveredFormulaNode;
    if (!node) return;

    const related = event.relatedTarget;
    if (related instanceof Node && node.contains(related)) return;
    const nextFormula = findFormulaNode(related);
    if (nextFormula) {
      setFormulaHover(nextFormula);
      return;
    }
    clearFormulaHover();
  }

  function handleFormulaDocumentClick(event) {
    const node = findFormulaNode(event.target);
    if (!node) return;
    void handleFormulaClick(event, node);
  }

  function findFormulaNode(target) {
    if (!(target instanceof Element)) return null;

    const candidates = [];
    let current = target;
    while (current instanceof Element) {
      if (current.matches(FORMULA_SELECTORS) &&
          !current.closest('#cgh-panel, #cgh-toast, #cgh-formula-copy-feedback')) {
        candidates.push(current);
      }
      current = current.parentElement;
    }

    // Prefer the first formula wrapper that contains usable source and has a
    // visible box. MathML assistive nodes are often hidden inside KaTeX or
    // MathJax, so selecting them first would make the button disappear.
    let fallback = null;
    const visibleCandidates = [];
    for (const candidate of candidates) {
      if (!extractLatexFromNode(candidate)) continue;
      if (!fallback) fallback = candidate;
      const rect = candidate.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) visibleCandidates.push(candidate);
    }
    return visibleCandidates.find(isDisplayFormula) || visibleCandidates[0] || fallback;
  }

  async function handleFormulaClick(event, node = event.currentTarget) {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    if (!(node instanceof Element)) return;

    event.preventDefault();
    event.stopPropagation();

    const latex = extractLatexFromNode(node);
    if (!latex) return;

    setFormulaHover(node);
    try {
      await copyFormulaText(latex, isDisplayFormula(node), settings.copyMode, node);
      showFormulaCopyFeedback(event.clientX, event.clientY, node);
      node.classList.remove('cgh-formula-copied');
      void node.getBoundingClientRect();
      node.classList.add('cgh-formula-copied');
      window.setTimeout(() => node.classList.remove('cgh-formula-copied'), 520);
    } catch (error) {
      console.error('[CGH] Failed to copy formula', error);
      showToast('公式复制失败', 2200);
    }
  }

  function isDisplayFormula(node) {
    if (node.matches('mjx-container[display="true"], .katex-display, .math-display, .math-block, .MathJax_Display')) return true;
    const displayAttr = node.getAttribute?.('display');
    if (displayAttr === 'block' || displayAttr === 'true' || node.getAttribute?.('data-display') === 'block') return true;
    return node.tagName === 'DIV' && !node.closest('p');
  }

  function setFormulaHover(node) {
    if (!(node instanceof Element)) return;
    if (hoveredFormulaNode && hoveredFormulaNode !== node) {
      hoveredFormulaNode.classList.remove('cgh-formula-hovered');
    }
    hoveredFormulaNode = node;
    node.classList.add('cgh-formula-target', 'cgh-formula-hovered');
    node.classList.toggle('cgh-formula-block', isDisplayFormula(node));
  }

  function clearFormulaHover() {
    hoveredFormulaNode?.classList.remove('cgh-formula-hovered');
    hoveredFormulaNode = null;
  }

  function showFormulaCopyFeedback(clientX, clientY, formulaNode) {
    ensureFormulaUi();
    const feedback = formulaFeedbackEl;
    const formulaRect = formulaNode.getBoundingClientRect();
    const pointerX = Number.isFinite(clientX) ? clientX : formulaRect.left + formulaRect.width / 2;
    const pointerY = Number.isFinite(clientY) ? clientY : formulaRect.top + formulaRect.height / 2;

    window.clearTimeout(formulaFeedbackTimer);
    feedback.hidden = false;
    feedback.classList.remove('cgh-visible');
    feedback.style.visibility = 'hidden';
    feedback.style.left = '0px';
    feedback.style.top = '0px';
    const rect = feedback.getBoundingClientRect();
    const gap = 14;
    const left = clamp(pointerX + gap, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const preferredTop = pointerY + gap;
    const top = preferredTop + rect.height <= window.innerHeight - 8
      ? preferredTop
      : pointerY - rect.height - gap;

    feedback.style.left = `${left}px`;
    feedback.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - rect.height - 8))}px`;
    feedback.style.visibility = 'visible';
    void feedback.offsetWidth;
    feedback.classList.add('cgh-visible');
    formulaFeedbackTimer = window.setTimeout(() => {
      feedback.classList.remove('cgh-visible');
      feedback.hidden = true;
    }, 1250);
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  async function copyFormulaText(latex, displayMode, mode, sourceNode = null) {
    let text;
    const normalizedMode = normalizeCopyMode(mode);
    if (normalizedMode === 'word') {
      await copyFormulaForWord(sourceNode, latex);
      return;
    }
    if (normalizedMode === 'markdown') {
      text = formatMarkdownFormula(latex, displayMode);
    } else {
      text = normalizeLatexForCopy(latex);
    }
    await copyText(text);
  }

  async function copyFormulaForWord(sourceNode, latex) {
    const math = sourceNode?.matches?.('math')
      ? sourceNode
      : sourceNode?.querySelector?.('math, mjx-assistive-mml math');
    if (!math || typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) {
      await copyText(normalizeLatexForCopy(latex));
      return;
    }

    const clone = math.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    const html = `<html><body>${clone.outerHTML}</body></html>`;
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([normalizeLatexForCopy(latex)], { type: 'text/plain' }),
      }),
    ]);
  }

  function normalizeLatexForCopy(latex) {
    if (!latex) return '';
    return normalizeLatexCommandSpacing(stripMathDelimiters(latex)
      .replace(/\u00A0/g, ' ')
      .replace(/\\tag\s*\{([^{}]*)\}/g, '#($1)')
      .replace(/\s+/g, ' ')
      .trim());
  }

  function normalizeLatexCommandSpacing(latex) {
    return String(latex || '').replace(
      /(\\(?:Rightarrow|Leftarrow|Leftrightarrow|Longrightarrow|Longleftarrow|to|mapsto|implies))(?=[A-Za-z])/g,
      '$1 ',
    );
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

    // Match Voyager's source-first behavior. The visible .katex/.katex-display
    // node is frequently nested inside the element that owns data-math, so
    // checking only attributes on `node` silently falls through to lossy DOM
    // reverse conversion (which drops \boxed, scripts, etc.). Search the
    // closest source-bearing ancestor first, then the current node/subtree.
    const sourceSelector = [
      '[data-math]',
      '[data-tex]',
      '[data-latex]',
      '[latex]',
      '[data-math-source]',
      '[data-tex-source]',
    ].join(',');
    const sourceNodes = [];
    const closestSource = node.closest(sourceSelector);
    if (closestSource) sourceNodes.push(closestSource);
    if (node.matches(sourceSelector) && !sourceNodes.includes(node)) sourceNodes.push(node);
    const nestedSource = node.querySelector(sourceSelector);
    if (nestedSource && !sourceNodes.includes(nestedSource)) sourceNodes.push(nestedSource);

    for (const sourceNode of sourceNodes) {
      const explicitCandidates = [
        sourceNode.getAttribute('data-math'),
        sourceNode.getAttribute('data-tex'),
        sourceNode.getAttribute('data-latex'),
        sourceNode.getAttribute('latex'),
        sourceNode.getAttribute('data-math-source'),
        sourceNode.getAttribute('data-tex-source'),
      ].filter(Boolean);

      for (const candidate of explicitCandidates) {
        const cleaned = cleanLatexCandidate(candidate);
        // On a rendered formula, an attribute can still be an accessibility or
        // display-text label. Only accept it as source when it has LaTeX syntax.
        // This keeps a plain value such as "dydf(x0,y)..." out of the clipboard.
        if (cleaned && (looksLikeLatexSource(cleaned) || !hasFormulaRenderingEvidence(sourceNode))) return cleaned;
      }
    }

    const annotation = node.querySelector([
      'annotation[encoding="application/x-tex" i]',
      'annotation[encoding="tex" i]',
      'annotation[encoding="application/x-latex" i]',
    ].join(','));
    if (annotation?.textContent) {
      const cleaned = cleanLatexCandidate(annotation.textContent);
      if (cleaned) return cleaned;
    }

    const texScript = node.querySelector('script[type^="math/tex" i]');
    if (texScript?.textContent) {
      const cleaned = cleanLatexCandidate(texScript.textContent);
      if (cleaned) return cleaned;
    }

    const adjacentTexScript = [node.previousElementSibling, node.nextElementSibling]
      .find(element => element?.matches?.('script[type^="math/tex" i]'));
    if (adjacentTexScript?.textContent) {
      const cleaned = cleanLatexCandidate(adjacentTexScript.textContent);
      if (cleaned) return cleaned;
    }

    const semantics = node.querySelector('semantics > annotation');
    if (semantics?.textContent) {
      const cleaned = cleanLatexCandidate(semantics.textContent);
      if (cleaned) return cleaned;
    }

    const hasRenderedFormula = hasFormulaRenderingEvidence(node);
    const hasKatexRendering = node.matches('.katex, .katex-display') || !!node.querySelector('.katex, .katex-html');

    // When both KaTeX HTML and assistive MathML are present, the visible
    // KaTeX tree preserves presentation details such as \boxed and scripts
    // more faithfully. Use it before trying to reverse-convert MathML.
    if (hasKatexRendering) {
      const convertedKatex = katexHtmlToLatex(node);
      if (looksLikeLatexSource(convertedKatex)) return convertedKatex;
    }

    const mathml = node.matches('math') ? node : node.querySelector('mjx-assistive-mml math, .katex-mathml math, math');
    if (mathml) {
      const mathmlSourceCandidates = [
        mathml.getAttribute('data-tex'),
        mathml.getAttribute('data-latex'),
        mathml.getAttribute('alttext'),
      ].filter(Boolean);
      for (const candidate of mathmlSourceCandidates) {
        const cleaned = cleanLatexCandidate(candidate);
        if (looksLikeLatexSource(cleaned)) return cleaned;
      }
    }

    const convertedMathml = mathMlToLatex(mathml);
    if (looksLikeLatexSource(convertedMathml)) return convertedMathml;

    if (hasRenderedFormula && !hasKatexRendering) {
      const convertedKatex = katexHtmlToLatex(node);
      if (looksLikeLatexSource(convertedKatex)) return convertedKatex;
    }

    // Never reverse-engineer a rendered formula from textContent. It loses
    // fractions, scripts and delimiters (for example: "dydf(x0,y)...").
    // Plain text fallback is only safe for a non-rendered, explicitly marked
    // formula-like node.
    if (!hasRenderedFormula) {
      const text = normalizeWhitespace(node.textContent || '');
      if (looksLikeLatex(text)) return text;
    }

    return '';
  }

  function looksLikeLatexSource(text) {
    const value = String(text || '').trim();
    if (!value || isGenericFormulaLabel(value)) return false;
    return /\\[A-Za-z]+|[_^{}]/.test(value);
  }

  function hasFormulaRenderingEvidence(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches([
      '.katex',
      '.katex-display',
      'mjx-container',
      'math',
      '.MathJax',
      '.MathJax_Display',
      '[role="math"]',
      '.math',
      '.math-inline',
      '.math-display',
      '.math-block',
      '.math-container',
      '[data-tex]',
      '[data-latex]',
      '[data-math]',
      '[data-mathml]',
      '[data-math-mode]',
      '[data-formula]',
      '[data-testid*="math"]',
      '[aria-roledescription="math"]',
    ].join(','))) return true;
    return !!node.querySelector('math, mjx-container, .katex, annotation, script[type^="math/tex" i]');
  }

  function isGenericFormulaLabel(text) {
    return /^(?:math|formula|equation|inline|block|display|true|false|数学|公式|数学公式)$/i.test(String(text || '').trim());
  }

  function mathMlToLatex(math) {
    if (!(math instanceof Element) || math.localName !== 'math') return '';

    const convert = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent || '';
        return node.parentElement?.localName === 'mtext' ? value : value.trim();
      }
      if (!(node instanceof Element)) return '';

      const childValues = () => [...node.childNodes].map(convert).join('');
      const child = (index) => convert(node.children[index]);
      switch (node.localName) {
        case 'math':
        case 'mpadded':
        case 'mstyle':
        case 'mphantom':
        case 'merror':
          return childValues();
        case 'menclose': {
          const notation = (node.getAttribute('notation') || '').split(/\s+/).filter(Boolean);
          const body = childValues();
          return notation.includes('box') || notation.includes('roundedbox')
            ? `\\boxed{${body}}`
            : body;
        }
        case 'mrow': {
          const values = childValues();
          const children = [...node.children];
          const first = children[0];
          const last = children[children.length - 1];
          const open = first?.localName === 'mo' && getMathMoRole(first) === 'open';
          const close = last?.localName === 'mo' && getMathMoRole(last) === 'close';
          return close && !open ? `\\left.${values}` : values;
        }
        case 'semantics':
          return node.children.length ? child(0) : '';
        case 'annotation':
        case 'annotation-xml':
          return '';
        case 'mi':
          return convertMathIdentifier(childValues());
        case 'mn':
          return childValues().trim();
        case 'mo': {
          const operator = convertMathOperator(childValues()).trim();
          const role = getMathMoRole(node);
          const delimiter = convertMathDelimiter(operator);
          if (role === 'open') return delimiter ? `\\left${delimiter}` : '\\left.';
          if (role === 'close') return delimiter ? `\\right${delimiter}` : '\\right.';
          return delimiter || operator;
        }
        case 'mtext':
          return `\\text{${childValues().replace(/[{}]/g, '\\$&').trim()}}`;
        case 'mfrac':
          return `\\frac{${child(0)}}{${child(1)}}`;
        case 'msqrt':
          return `\\sqrt{${childValues()}}`;
        case 'mroot':
          return `\\sqrt[${child(1)}]{${child(0)}}`;
        case 'msup':
          return `${formatMathScriptBase(child(0))}^${needsMathScriptBraces(child(1)) ? `{${child(1)}}` : child(1)}`;
        case 'msub':
          return `${formatMathScriptBase(child(0))}_${needsMathScriptBraces(child(1)) ? `{${child(1)}}` : child(1)}`;
        case 'msubsup':
          return `${formatMathScriptBase(child(0))}_${needsMathScriptBraces(child(1)) ? `{${child(1)}}` : child(1)}^${needsMathScriptBraces(child(2)) ? `{${child(2)}}` : child(2)}`;
        case 'mover':
          return `\\overset{${child(1)}}{${child(0)}}`;
        case 'munder':
          return `\\underset{${child(1)}}{${child(0)}}`;
        case 'munderover':
          return `\\overset{${child(2)}}{\\underset{${child(1)}}{${child(0)}}}`;
        case 'mfenced': {
          const open = convertMathDelimiter(node.getAttribute('open') ?? '(');
          const close = convertMathDelimiter(node.getAttribute('close') ?? ')');
          return `${open}${childValues()}${close}`;
        }
        case 'mtable':
          return `\\begin{matrix}${[...node.children].map(convert).join('\\\\')}\\end{matrix}`;
        case 'mtr':
          return [...node.children].map(convert).join('&');
        case 'mtd':
          return childValues();
        case 'mspace':
          return '';
        default:
          return childValues();
      }
    };

    return convert(math).replace(/\s+/g, ' ').trim();
  }

  function getMathMoRole(node) {
    const fence = node.getAttribute('fence') === 'true';
    const texClass = node.getAttribute('data-mjx-texclass');
    if (texClass === 'OPEN' || (fence && node.getAttribute('form') === 'prefix')) return 'open';
    if (texClass === 'CLOSE' || (fence && node.getAttribute('form') === 'postfix')) return 'close';
    if (!fence) return '';

    const siblings = [...(node.parentElement?.children || [])];
    if (siblings[0] === node) return 'open';
    if (siblings[siblings.length - 1] === node) return 'close';
    return '';
  }

  function convertMathIdentifier(value) {
    const text = value.trim();
    const identifiers = {
      'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
      'ε': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
      'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
      'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
      'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
      'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
      'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
      'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi',
      'Ψ': '\\Psi', 'Ω': '\\Omega',
    };
    return identifiers[text] || text;
  }

  function convertMathOperator(value) {
    const text = value.trim();
    const operators = {
      '−': '-', '×': '\\times ', '÷': '\\div ', '·': '\\cdot ',
      '≤': '\\leq ', '≥': '\\geq ', '≠': '\\neq ', '≈': '\\approx ',
      '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ', '∞': '\\infty ',
      '→': '\\to ', '⇒': '\\Rightarrow ', '∈': '\\in ', '∉': '\\notin ',
      '∣': '|', '‖': '\\Vert ', '′': '\\prime ',
    };
    return operators[text] || text;
  }

  function convertMathDelimiter(value) {
    const text = value.trim();
    const delimiters = {
      '{': '\\{', '}': '\\}', '∣': '|', '‖': '\\Vert',
      '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor',
      '⌈': '\\lceil', '⌉': '\\rceil', '\\': '\\backslash',
    };
    return delimiters[text] || text;
  }

  function needsMathScriptBraces(value) {
    const text = String(value || '').trim();
    if (/^[A-Za-z0-9]$/.test(text)) return false;
    if (/^\\[a-zA-Z]+$/.test(text)) return false;
    if (/^\\[a-zA-Z]+\{[^{}]*\}$/.test(text)) return false;
    return true;
  }

  function formatMathScriptBase(value) {
    const text = String(value || '').trim();
    if (!text) return '{}';
    if (/^[A-Za-z0-9]$/.test(text)) return text;
    if (/^\\[a-zA-Z]+$/.test(text)) return text;
    if (text.startsWith('\\left') && text.includes('\\right')) return text;
    if (/^\\[a-zA-Z]+[_^]\{/.test(text)) return text;
    return `{${text}}`;
  }

  function katexHtmlToLatex(root) {
    if (!(root instanceof Element)) return '';
    const html = root.matches('.katex-html') ? root : root.querySelector('.katex-html');
    if (!html) return '';

    const bases = [...html.children].filter(node => node.classList.contains('base'));
    const pieces = bases.map(base => convertKatexChildren(base)).filter(piece => piece.text);
    return joinKatexPieces(pieces).replace(/[ \t]+\n/g, '\n').replace(/\s+/g, ' ').trim();
  }

  function sanitizeKatexText(text) {
    return String(text || '').replace(/\u200B/g, '').replace(/\u00A0/g, ' ').trim();
  }

  function getKatexClasses(node) {
    return node.classList ? [...node.classList] : [];
  }

  function hasKatexClass(node, name) {
    return node?.classList?.contains(name) === true;
  }

  function hasKatexClassPrefix(node, prefix) {
    return getKatexClasses(node).some(name => name.startsWith(prefix));
  }

  function isKatexElement(node) {
    return node instanceof Element;
  }

  function isKatexIgnored(node) {
    if (!isKatexElement(node)) return false;
    if (['svg', 'path'].includes(node.tagName.toLowerCase())) return true;
    return getKatexClasses(node).some(name =>
      ['strut', 'pstrut', 'mspace', 'vlist-s', 'hide-tail', 'frac-line', 'svg-align'].includes(name));
  }

  function isKatexScript(node) {
    return hasKatexClass(node, 'msupsub');
  }

  function isKatexTransparent(node) {
    return getKatexClasses(node).some(name =>
      ['sizing', 'vlist-t', 'vlist-r', 'vlist', 'delimsizing'].includes(name));
  }

  function mapKatexText(text, classes) {
    const value = sanitizeKatexText(text);
    if (!value) return '';

    const greek = {
      'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon',
      'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa',
      'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi',
      'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
      'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega', 'Γ': '\\Gamma', 'Δ': '\\Delta',
      'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma',
      'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
    };
    const operators = {
      '−': '-', '×': '\\times', '÷': '\\div', '·': '\\cdot', '∗': '*',
      '∘': '\\circ', '±': '\\pm', '∓': '\\mp', '≤': '\\leq', '≥': '\\geq',
      '≠': '\\neq', '≈': '\\approx', '∑': '\\sum', '∏': '\\prod', '∫': '\\int',
      '∞': '\\infty', '→': '\\to', '⇒': '\\Rightarrow', '∈': '\\in', '∉': '\\notin',
      '∣': '|', '‖': '\\Vert', '′': '\\prime', '∇': '\\nabla', '∂': '\\partial',
    };
    const fontCommands = {
      mathrm: 'mathrm', mathit: 'mathit', mathbf: 'mathbf', mathsf: 'mathsf', mathtt: 'mathtt',
      mathcal: 'mathcal', mathscr: 'mathscr', mathfrak: 'mathfrak', mathbb: 'mathbb', boldsymbol: 'boldsymbol',
    };

    let mapped = '';
    for (const char of value) {
      if (greek[char]) mapped += greek[char];
      else if (operators[char]) mapped += operators[char];
      else mapped += char;
    }

    const fontClass = classes.find(name => fontCommands[name]);
    if (fontClass && !classes.includes('op-symbol')) {
      return `\\${fontCommands[fontClass]}{${mapped}}`;
    }
    return mapped;
  }

  function isKatexLeftRightGroup(text) {
    return typeof text === 'string' && text.startsWith('\\left') && text.includes('\\right');
  }

  function katexAtomNeedsGroup(node, text) {
    if (!text) return true;
    if (isKatexLeftRightGroup(text)) return false;
    if (hasKatexClass(node, 'mop') && text.startsWith('\\')) return false;
    if (/^\\[a-zA-Z]+$/.test(text)) return false;
    if (/^\\[a-zA-Z]+\{[^{}]*\}$/.test(text)) return false;
    if (/^\\sqrt(?:\[[^\]]*\])?\{[\s\S]*\}$/.test(text)) return false;
    if (/^\\frac\{[\s\S]*\}\{[\s\S]*\}$/.test(text)) return false;
    if (/^[A-Za-z0-9]$/.test(text)) return false;
    if (/^[^\sA-Za-z0-9\\]$/.test(text)) return false;
    if (/^[A-Za-z0-9][_^]\{/.test(text)) return false;
    if (/^\\[a-zA-Z]+[_^]\{/.test(text)) return false;
    return true;
  }

  function joinKatexPieces(pieces) {
    let output = '';
    for (const piece of pieces) {
      if (output && /\\[a-zA-Z]+$/.test(output) && /^[A-Za-z0-9]/.test(piece.text)) {
        output += ' ';
      }
      output += piece.text;
    }
    return output;
  }

  function convertKatexChildren(parent) {
    const pieces = [];
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = sanitizeKatexText(child.textContent);
        if (text) {
          pieces.push({ text: mapKatexText(text, getKatexClasses(parent)), needsGroup: text.length > 1 });
        }
        continue;
      }
      if (!isKatexElement(child)) continue;
      if (isKatexIgnored(child)) continue;

      if (isKatexScript(child)) {
        const scripts = parseKatexScripts(child);
        const base = pieces.pop() || { text: '', needsGroup: true };
        const baseText = base.needsGroup && base.text ? `{${base.text}}` : base.text;
        let text = baseText;
        if (scripts.sub) text += formatKatexScriptArg('_', scripts.sub);
        if (scripts.sup) text += formatKatexScriptArg('^', scripts.sup);
        pieces.push({ text, needsGroup: false });
        continue;
      }

      const converted = convertKatexElement(child);
      if (converted.text) pieces.push(converted);
    }

    if (!pieces.length) return { text: '', needsGroup: true };
    if (pieces.length === 1) return pieces[0];
    return { text: joinKatexPieces(pieces), needsGroup: true };
  }

  function needsKatexScriptArgBraces(text) {
    if (!text) return false;
    if (/^[A-Za-z0-9]$/.test(text)) return false;
    if (/^\\[a-zA-Z]+$/.test(text)) return false;
    if (/^\\[a-zA-Z]+\{[^{}]*\}$/.test(text)) return false;
    return true;
  }

  function formatKatexScriptArg(kind, text) {
    return needsKatexScriptArgBraces(text) ? `${kind}{${text}}` : `${kind}${text}`;
  }

  function getKatexPositionedTop(element, stop) {
    let current = element;
    while (current && current !== stop) {
      const style = current.getAttribute?.('style') || '';
      const match = style.match(/(?:^|;\s*)top:\s*(-?[\d.]+)em/);
      if (match) return Number(match[1]);
      current = current.parentElement;
    }
    return null;
  }

  function parseKatexScripts(script) {
    const result = { sub: '', sup: '' };
    const candidates = [...script.querySelectorAll('.mtight')];
    const wrappers = candidates.filter(node =>
      !candidates.some(other => other !== node && other.contains(node)));

    for (const wrapper of wrappers) {
      const top = getKatexPositionedTop(wrapper, script);
      const text = convertKatexChildren(wrapper).text;
      if (!text) continue;
      if (top !== null && top <= -2.85) result.sup = text;
      else result.sub = text;
    }
    return result;
  }

  function parseKatexFrac(frac) {
    let vlist = null;
    for (const child of frac.children) {
      if (!hasKatexClass(child, 'vlist-t')) continue;
      for (const child2 of child.children) {
        if (!hasKatexClass(child2, 'vlist-r')) continue;
        for (const child3 of child2.children) {
          if (hasKatexClass(child3, 'vlist') &&
              [...child3.children].some(row => /top:/.test(row.getAttribute?.('style') || ''))) {
            vlist = child3;
            break;
          }
        }
        if (vlist) break;
      }
      if (vlist) break;
    }

    if (!vlist) return { text: '', needsGroup: true };
    const rows = [];
    for (const row of vlist.children) {
      if (!isKatexElement(row)) continue;
      const style = row.getAttribute?.('style') || '';
      const match = style.match(/(?:^|;\s*)top:\s*(-?[\d.]+)em/);
      if (!match) continue;
      const converted = convertKatexChildren(row);
      if (converted.text) rows.push({ top: Number(match[1]), text: converted.text });
    }

    if (rows.length < 2) return { text: '', needsGroup: true };
    rows.sort((a, b) => a.top - b.top);
    return {
      text: `\\frac{${rows[0].text}}{${rows[rows.length - 1].text}}`,
      needsGroup: false,
    };
  }

  function parseKatexSqrt(element) {
    const root = element.querySelector('.root');
    const radicand = element.querySelector('.svg-align > .mord');
    const body = radicand ? convertKatexChildren(radicand).text : convertKatexChildren(element).text;
    if (root) {
      return { text: `\\sqrt[${convertKatexChildren(root).text}]{${body}}`, needsGroup: false };
    }
    return { text: `\\sqrt{${body}}`, needsGroup: false };
  }

  function parseKatexTable(table) {
    const columns = [...table.children].filter(node => hasKatexClassPrefix(node, 'col-align-'));
    const columnRows = columns.map((column) => {
      let vlist = null;
      for (const child of column.children) {
        if (!hasKatexClass(child, 'vlist-t')) continue;
        for (const child2 of child.children) {
          if (!hasKatexClass(child2, 'vlist-r')) continue;
          for (const child3 of child2.children) {
            if (hasKatexClass(child3, 'vlist') &&
                [...child3.children].some(row => /top:/.test(row.getAttribute?.('style') || ''))) {
              vlist = child3;
              break;
            }
          }
          if (vlist) break;
        }
        if (vlist) break;
      }

      const rows = [];
      if (!vlist) return rows;
      for (const row of vlist.children) {
        if (!isKatexElement(row)) continue;
        if (!/top:/.test(row.getAttribute?.('style') || '')) continue;
        rows.push(convertKatexChildren(row).text);
      }
      return rows;
    });

    const rowCount = Math.max(0, ...columnRows.map(rows => rows.length));
    const body = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      body.push(columnRows.map(rows => rows[rowIndex] || '').join(' & '));
    }
    return { text: `\\begin{matrix}${body.join(' \\\\ ')}\\end{matrix}`, needsGroup: false };
  }

  function parseKatexOverline(element, kind) {
    const base = element.querySelector('.vlist > [style*="top:"] .mord');
    const body = base ? convertKatexChildren(base).text : '';
    return { text: `\\${kind}{${body}}`, needsGroup: false };
  }

  function parseKatexAccent(element) {
    const base = element.querySelector('.vlist > [style*="top:"] .mord');
    const body = base ? convertKatexChildren(base).text : '';
    if (!body) return { text: '', needsGroup: true };

    const accentElement = element.querySelector('.accent-body');
    const accentText = sanitizeKatexText(accentElement?.textContent);
    const accents = {
      '^': 'hat', 'ˉ': 'bar', '¯': 'bar', '~': 'tilde', '˜': 'tilde',
      '´': 'acute', '`': 'grave', '˙': 'dot', '¨': 'ddot', 'ˇ': 'check', '˘': 'breve',
    };
    if (accentText && accents[accentText]) {
      return { text: `\\${accents[accentText]}{${body}}`, needsGroup: false };
    }
    if (accentElement?.querySelector('svg')) {
      return { text: `\\vec{${body}}`, needsGroup: false };
    }
    return { text: body, needsGroup: false };
  }

  function parseKatexDelimiter(element) {
    if (hasKatexClass(element, 'nulldelimiter')) return '.';
    const text = sanitizeKatexText(element.textContent);
    if (text) return mapKatexDelimiter(text);

    const svg = element.querySelector('svg');
    const viewBox = svg?.getAttribute?.('viewBox') || '';
    const width = Number.parseFloat(viewBox.split(/\s+/)[2] || '0');
    if (width === 333) return '|';
    if (width === 556) return '\\Vert';
    return '';
  }

  function mapKatexDelimiter(text) {
    const delimiters = {
      '{': '\\{', '}': '\\}', '∣': '|', '‖': '\\Vert',
      '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor',
      '⌈': '\\lceil', '⌉': '\\rceil', '\\': '\\backslash',
    };
    return delimiters[text] || text;
  }

  function parseKatexMinner(element) {
    const children = [...element.children].filter(node =>
      isKatexElement(node) && !isKatexIgnored(node) && !isKatexScript(node));
    const first = children[0];
    const last = children[children.length - 1];
    const hasOpen = first && hasKatexClass(first, 'mopen');
    const hasClose = last && hasKatexClass(last, 'mclose');

    if (children.length >= 2 && hasOpen && hasClose) {
      const left = parseKatexDelimiter(first);
      const right = parseKatexDelimiter(last);
      const middlePieces = children.slice(1, -1).map(convertKatexElement).filter(piece => piece.text);
      const middle = joinKatexPieces(middlePieces);
      const leftCommand = left === '.' ? '\\left.' : `\\left${left}`;
      const rightCommand = right === '.' ? '\\right.' : `\\right${right}`;
      return { text: `${leftCommand}${middle}${rightCommand}`, needsGroup: false };
    }

    return convertKatexChildren(element);
  }

  function parseKatexLimitsOp(element) {
    let vlist = null;
    for (const child of element.children) {
      if (!hasKatexClass(child, 'vlist-t')) continue;
      for (const child2 of child.children) {
        if (!hasKatexClass(child2, 'vlist-r')) continue;
        for (const child3 of child2.children) {
          if (hasKatexClass(child3, 'vlist') &&
              [...child3.children].some(row => /top:/.test(row.getAttribute?.('style') || ''))) {
            vlist = child3;
            break;
          }
        }
        if (vlist) break;
      }
      if (vlist) break;
    }

    const rows = [];
    if (vlist) {
      for (const row of vlist.children) {
        if (!isKatexElement(row)) continue;
        const style = row.getAttribute?.('style') || '';
        const match = style.match(/(?:^|;\s*)top:\s*(-?[\d.]+)em/);
        if (!match) continue;
        const text = convertKatexChildren(row).text;
        if (text) rows.push({ top: Number(match[1]), text, element: row });
      }
    }

    const operatorRow = rows.find(row =>
      row.element.querySelector('.op-symbol') || /^(?:lim|max|min|det|gcd|sup|inf|Pr)$/.test(row.text)) ||
      rows.find(row => !row.element.querySelector('.mtight'));

    let sup = '';
    let sub = '';
    if (operatorRow) {
      const above = rows.filter(row => row !== operatorRow && row.top < operatorRow.top);
      const below = rows.filter(row => row !== operatorRow && row.top > operatorRow.top);
      sup = above[above.length - 1]?.text || '';
      sub = below[0]?.text || '';
    }
    const operator = operatorRow?.text || '';

    let text = operator;
    if (sub) text += formatKatexScriptArg('_', sub);
    if (sup) text += formatKatexScriptArg('^', sup);
    return { text, needsGroup: false };
  }

  function parseKatexMop(element) {
    if (hasKatexClass(element, 'op-limits')) return parseKatexLimitsOp(element);
    const converted = convertKatexChildren(element);
    let text = converted.text;
    if (!text || text.startsWith('\\')) return { text, needsGroup: false };

    const match = text.match(/^([A-Za-z]+)(.*)$/);
    const names = new Set([
      'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lim', 'det', 'gcd', 'Pr',
      'sup', 'inf', 'max', 'min', 'arg', 'dim', 'exp', 'ker', 'deg', 'hom', 'limsup', 'liminf',
    ]);
    if (match && names.has(match[1])) return { text: `\\${match[1]}${match[2]}`, needsGroup: false };
    return { text: `\\operatorname{${text}}`, needsGroup: false };
  }

  function convertKatexElement(element) {
    if (!isKatexElement(element)) return { text: '', needsGroup: true };
    const classes = getKatexClasses(element);

    if (classes.includes('katex-html')) {
      const bases = [...element.children].filter(node => hasKatexClass(node, 'base'));
      return { text: joinKatexPieces(bases.map(base => convertKatexChildren(base)).filter(piece => piece.text)), needsGroup: true };
    }
    if (classes.includes('base')) return convertKatexChildren(element);
    if (classes.includes('mfrac')) return parseKatexFrac(element);
    if (classes.includes('sqrt')) return parseKatexSqrt(element);
    if (classes.includes('minner')) return parseKatexMinner(element);
    if (classes.includes('text')) {
      return { text: `\\text{${convertKatexChildren(element).text}}`, needsGroup: false };
    }
    if (classes.includes('fbox')) {
      return { text: `\\boxed{${convertKatexChildren(element).text}}`, needsGroup: false };
    }
    if (classes.includes('fcolorbox')) {
      return { text: `\\boxed{${convertKatexChildren(element).text}}`, needsGroup: false };
    }
    if (classes.includes('mopen') || classes.includes('mclose')) {
      return { text: parseKatexDelimiter(element), needsGroup: false };
    }
    if (classes.includes('mop')) return parseKatexMop(element);
    if (classes.includes('msupsub')) {
      const scripts = parseKatexScripts(element);
      return { text: `${scripts.sub ? formatKatexScriptArg('_', scripts.sub) : ''}${scripts.sup ? formatKatexScriptArg('^', scripts.sup) : ''}`, needsGroup: false };
    }
    if (classes.includes('mtable')) return parseKatexTable(element);
    if (classes.includes('overline')) return parseKatexOverline(element, 'overline');
    if (classes.includes('underline')) return parseKatexOverline(element, 'underline');
    if (classes.includes('accent')) return parseKatexAccent(element);
    if (isKatexTransparent(element)) return convertKatexChildren(element);

    if (classes.includes('mord')) {
      const hasSemanticChildren = [...element.children].some(node =>
        isKatexElement(node) && !isKatexIgnored(node) && !isKatexTransparent(node));
      if (!hasSemanticChildren) {
        return { text: mapKatexText(element.textContent, classes), needsGroup: false };
      }
      if (element.querySelector('.mfrac')) {
        return parseKatexFrac(element.querySelector('.mfrac'));
      }
      if (element.querySelector('.sqrt')) {
        return parseKatexSqrt(element.querySelector('.sqrt'));
      }
      return convertKatexChildren(element);
    }

    if (classes.some(name => [
      'mbin', 'mrel', 'mpunct', 'mathnormal', 'mathcal', 'mathbb', 'mathbf', 'boldsymbol',
      'mathrm', 'mathit', 'mathsf', 'mathtt', 'mathfrak', 'mathscr',
    ].includes(name))) {
      const hasSemanticChildren = [...element.children].some(node =>
        isKatexElement(node) && !isKatexIgnored(node));
      if (!hasSemanticChildren) {
        return { text: mapKatexText(element.textContent, classes), needsGroup: false };
      }
    }

    return convertKatexChildren(element);
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
    const value = String(text).trim();
    if (!value || /[\u200B-\u200D\uFEFF]/.test(value)) return false;
    if (/[\\_{}]/.test(value)) return true;
    if (/\b(frac|sqrt|sum|int|alpha|beta|gamma|sin|cos|tan|cdot|times|leq|geq)\b/.test(value)) return true;
    if (/^[0-9A-Za-z+\-*/=().,\s^]+$/.test(value) && /[=+\-*/^]/.test(value)) return true;
    return false;
  }
})();
