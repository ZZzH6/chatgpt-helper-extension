const { DEFAULTS, normalizeSettings } = globalThis.CGH_TOOLKIT;
const FIELD_IDS = Object.keys(DEFAULTS);

const versionEl = document.getElementById('extensionVersion');
if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

function getField(id) {
  return document.getElementById(id);
}

function updateRangeOutput(id) {
  const field = getField(id);
  const output = document.querySelector(`output[data-for="${id}"]`);
  if (!field || !output) return;
  const value = Number(field.value);
  const isOriginal = value === Number(field.min);
  output.classList.toggle('range-output-original', isOriginal);
  if (isOriginal) {
    output.value = '原版';
    return;
  }
  const suffix = id === 'readingWidth' ? 'px' : id === 'fontScale' ? '%' : id === 'lineHeight' ? '倍' : 'em';
  output.value = `${field.value}${suffix}`;
}

function renderSettings(values) {
  const settings = normalizeSettings(values);
  for (const id of FIELD_IDS) {
    const field = getField(id);
    if (!field) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = settings[id];
    } else {
      field.value = settings[id] === 0 ? field.min : settings[id];
    }
  }
  ['readingWidth', 'fontScale', 'lineHeight', 'paragraphSpacing'].forEach(updateRangeOutput);
}

function readSettings() {
  const values = {};
  for (const id of FIELD_IDS) {
    const field = getField(id);
    if (!field) continue;
    values[id] = field instanceof HTMLInputElement && field.type === 'checkbox'
      ? field.checked
      : Number(field.value) === Number(field.min) ? 0 : field.value;
  }
  return normalizeSettings(values);
}

async function loadSettings() {
  renderSettings(await chrome.storage.sync.get(DEFAULTS));
}

function isChatGptTab(tab) {
  if (!tab?.id || !tab.url) return false;
  try {
    const url = new URL(tab.url);
    return url.protocol === 'https:' && (
      url.hostname === 'chatgpt.com' ||
      url.hostname.endsWith('.chatgpt.com') ||
      url.hostname === 'chat.openai.com'
    );
  } catch {
    return false;
  }
}

async function saveSettings() {
  const status = getField('status');
  const diagnostics = getField('diagnostics');
  diagnostics.hidden = true;
  diagnostics.textContent = '';
  const button = getField('saveBtn');
  button.disabled = true;
  try {
    const settings = readSettings();
    await chrome.storage.sync.set(settings);
    status.textContent = '已保存';
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      status.textContent = '已保存，请刷新聊天页';
      return;
    }
    if (!isChatGptTab(tab)) {
      status.textContent = '已保存，打开聊天页后生效';
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'cgh:apply-settings', settings });
      if (!response?.applied || response.readingEngineVersion !== 7 || !Number.isInteger(response.readingTargets)
        || !Number.isInteger(response.navigationTargets)
        || (settings.readingEnabled && typeof response.diagnostics?.route !== 'string')) {
        throw new Error('Content script did not confirm settings');
      }
      if (settings.readingEnabled && response.diagnostics) {
        const info = response.diagnostics;
        diagnostics.textContent = `页面 ${info.route} · main文字 ${info.mainChars} · 段落 ${info.paragraphs} · iframe ${info.frames}\n定位 ${info.source} · section ${info.sections} · role ${info.roles} · turn ${info.legacyTurns} · markdown ${info.markdown} · width ${response.widthTargets}`;
        diagnostics.textContent += `\n消息识别 ${response.navigationTargets} (${response.navigationSource}) · message-id ${info.messageIds} · 操作锚点 ${info.actions}`;
        diagnostics.textContent += `\n文字 ${info.textTargets} · 段距 ${info.spacingTargets} · 原字号 ${info.baseFontSize ?? '-'}→${info.fontSize ?? '-'}px · 行高 ${info.lineHeight ?? '-'} · 段距 ${info.marginBlock ?? '-'}`;
        diagnostics.hidden = false;
      }
      if (settings.readingEnabled && response.readingTargets === 0) {
        status.textContent = response.diagnostics?.route === 'conversation'
          ? '已保存，未找到聊天正文'
          : '已保存，当前不是对话页';
      } else if (settings.readingEnabled && !response.readingVerified) {
        status.textContent = '已保存，但排版未生效';
      } else if (settings.readingEnabled && response.widthTargets === 0) {
        status.textContent = '已保存，宽度容器未识别';
      } else if (response.navigationTargets === 0 && /(?:^|\/)c\/[^/]+/.test(new URL(tab.url).pathname)) {
        status.textContent = '已保存，但未识别到对话消息';
      } else {
        status.textContent = '已保存，聊天页已更新';
      }
    } catch {
      try {
        await chrome.tabs.reload(tab.id);
        status.textContent = '已保存，正在刷新聊天页';
      } catch {
        status.textContent = '已保存，请手动刷新聊天页';
      }
    }
  } catch (error) {
    status.textContent = `保存失败：${error.message || error}`;
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('input[type="range"]').forEach((input) => {
  input.addEventListener('input', () => updateRangeOutput(input.id));
});
getField('saveBtn').addEventListener('click', saveSettings);
void loadSettings();
