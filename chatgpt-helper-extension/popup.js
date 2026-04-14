const DEFAULTS = {
  warnThreshold: 30000,
  dangerThreshold: 60000,
  copyMode: 'latex',
  showPerMessage: true,
};

async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById('warnThreshold').value = data.warnThreshold;
  document.getElementById('dangerThreshold').value = data.dangerThreshold;
  document.getElementById('copyMode').value = data.copyMode;
  document.getElementById('showPerMessage').value = String(data.showPerMessage);
}

async function saveSettings() {
  const warnThreshold = Number(document.getElementById('warnThreshold').value || DEFAULTS.warnThreshold);
  const dangerThreshold = Number(document.getElementById('dangerThreshold').value || DEFAULTS.dangerThreshold);
  const copyMode = document.getElementById('copyMode').value;
  const showPerMessage = document.getElementById('showPerMessage').value === 'true';

  await chrome.storage.sync.set({
    warnThreshold,
    dangerThreshold,
    copyMode,
    showPerMessage,
  });

  const status = document.getElementById('status');
  status.textContent = '已保存';
  setTimeout(() => {
    status.textContent = '';
  }, 1600);
}

document.getElementById('saveBtn').addEventListener('click', saveSettings);
loadSettings();
