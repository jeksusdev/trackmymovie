(function initTrackMyMovieCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.TrackMyMovieCore = core;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCore() {
  function itemType(item, fallback = 'movie') {
    return item?.media_type === 'tv' || (!item?.media_type && item?.name) ? 'tv' : fallback;
  }

  function itemKey(id, type) {
    return `${type === 'tv' ? 'tv' : 'movie'}:${Number(id)}`;
  }

  function normalizeStoredWatchlist(value) {
    const normalized = {};
    Object.entries(value || {}).forEach(([key, entry]) => {
      const type = itemType(entry?.item);
      normalized[key.includes(':') ? key : itemKey(key, type)] = entry;
    });
    return normalized;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  return { escapeHtml, itemKey, itemType, normalizeStoredWatchlist };
}));
