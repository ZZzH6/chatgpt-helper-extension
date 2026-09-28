(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    copyMode: 'latex',
    readingEnabled: false,
    readingWidth: 0,
    fontScale: 0,
    lineHeight: 0,
    paragraphSpacing: 0,
    draftSaveEnabled: true,
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

  function normalizeReadingRange(value, min, max, fallback, precision = 0) {
    if (value === undefined) return fallback;
    if (Number(value) === 0) return 0;
    return clampNumber(value, min, max, fallback, precision);
  }

  function normalizeSettings(values = {}) {
    return {
      ...DEFAULTS,
      ...values,
      copyMode: normalizeCopyMode(values.copyMode),
      readingEnabled: values.readingEnabled === true,
      readingWidth: normalizeReadingRange(values.readingWidth, 640, 1200, DEFAULTS.readingWidth),
      fontScale: normalizeReadingRange(values.fontScale, 85, 130, DEFAULTS.fontScale),
      lineHeight: normalizeReadingRange(values.lineHeight, 1.35, 2.1, DEFAULTS.lineHeight, 2),
      paragraphSpacing: normalizeReadingRange(values.paragraphSpacing, 0.2, 1.6, DEFAULTS.paragraphSpacing, 2),
      draftSaveEnabled: values.draftSaveEnabled !== false,
    };
  }

  function getConversationKey(pathname) {
    return String(pathname || '').match(/\/c\/([^/?#]+)/)?.[1] || 'new-chat';
  }

  const api = {
    DEFAULTS,
    clampNumber,
    normalizeCopyMode,
    normalizeSettings,
    getConversationKey,
  };

  globalThis.CGH_TOOLKIT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
