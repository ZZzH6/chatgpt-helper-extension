chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'cgh-response-complete') return;

  const title = typeof message.title === 'string' && message.title.trim()
    ? message.title.trim().slice(0, 80)
    : 'ChatGPT';
  const notificationId = `cgh-response-${sender.tab?.id || 'unknown'}-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'ChatGPT 回答完成',
    message: title,
    priority: 1,
  });

  if (sender.tab?.id) {
    chrome.storage.local.set({
      [`cghNotificationTab:${notificationId}`]: sender.tab.id,
    });
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const key = `cghNotificationTab:${notificationId}`;
  const data = await chrome.storage.local.get(key);
  const tabId = data[key];
  if (Number.isInteger(tabId)) {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.storage.local.remove(key);
  chrome.notifications.clear(notificationId);
});
