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
  const boundFormulaNodes = new WeakSet();

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
    const stats = computeStats(messages);
    renderPanel(stats, messages);
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
    panel.innerHTML = `
      <div class="cgh-header">
        <div class="cgh-title">上下文估算</div>
        <div style="display:flex;gap:6px;">
          <button class="cgh-mini-btn" data-action="refresh">刷新</button>
          <button class="cgh-mini-btn" data-action="toggle">收起</button>
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
      messages.push({ role, text, node });
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
        <div class="cgh-item">
          <div class="cgh-role">${item.role === 'user' ? '用户' : '助手'}</div>
          <div class="cgh-preview">${escapeHtml(`${idx + 1}. ${item.preview}`)}</div>
          <div class="cgh-token">${formatNumber(item.tokens)}</div>
        </div>
      `)
      .join('') || '<div style="font-size:11px;opacity:.75;">未检测到消息</div>';
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

  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'cgh-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      if (toastEl) toastEl.hidden = true;
    }, 1400);
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
