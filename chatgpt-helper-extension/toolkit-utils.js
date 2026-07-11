(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    copyMode: 'latex',
    readingEnabled: false,
    readingWidth: 820,
    fontScale: 100,
    lineHeight: 1.7,
    paragraphSpacing: 0.8,
    draftSaveEnabled: true,
    notificationsEnabled: false,
    shortcutsEnabled: true,
  });

  function clampNumber(value, min, max, fallback, precision = 0) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : fallback;
    const clamped = Math.min(max, Math.max(min, safe));
    const factor = 10 ** precision;
    return Math.round(clamped * factor) / factor;
  }

  function normalizeCopyMode(mode) {
    return ['latex', 'markdown', 'word'].includes(mode) ? mode : DEFAULTS.copyMode;
  }

  function normalizeSettings(values = {}) {
    return {
      ...DEFAULTS,
      ...values,
      copyMode: normalizeCopyMode(values.copyMode),
      readingEnabled: values.readingEnabled === true,
      readingWidth: clampNumber(values.readingWidth, 640, 1200, DEFAULTS.readingWidth),
      fontScale: clampNumber(values.fontScale, 85, 130, DEFAULTS.fontScale),
      lineHeight: clampNumber(values.lineHeight, 1.35, 2.1, DEFAULTS.lineHeight, 2),
      paragraphSpacing: clampNumber(values.paragraphSpacing, 0.2, 1.6, DEFAULTS.paragraphSpacing, 2),
      draftSaveEnabled: values.draftSaveEnabled !== false,
      notificationsEnabled: values.notificationsEnabled === true,
      shortcutsEnabled: values.shortcutsEnabled !== false,
    };
  }

  function getConversationKey(pathname) {
    return String(pathname || '').match(/\/c\/([^/?#]+)/)?.[1] || 'new-chat';
  }

  function matchesTimelineQuery(message, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) return true;
    return String(message?.text || '').toLocaleLowerCase().includes(normalized);
  }

  const api = {
    DEFAULTS,
    clampNumber,
    normalizeCopyMode,
    normalizeSettings,
    getConversationKey,
    matchesTimelineQuery,
  };

  globalThis.CGH_TOOLKIT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
