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
  const suffix = id === 'readingWidth' ? 'px' : id === 'fontScale' ? '%' : '';
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
      field.value = settings[id];
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
      : field.value;
  }
  return normalizeSettings(values);
}

async function loadSettings() {
  renderSettings(await chrome.storage.sync.get(DEFAULTS));
}

async function saveSettings() {
  await chrome.storage.sync.set(readSettings());
  const status = getField('status');
  status.textContent = '已保存';
  window.setTimeout(() => { status.textContent = ''; }, 1400);
}

document.querySelectorAll('input[type="range"]').forEach((input) => {
  input.addEventListener('input', () => updateRangeOutput(input.id));
});
getField('saveBtn').addEventListener('click', saveSettings);
void loadSettings();
