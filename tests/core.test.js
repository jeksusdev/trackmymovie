const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, itemKey, itemType, normalizeStoredWatchlist } = require('../js/core.js');
const { createTmdbClient } = require('../js/api.js');

test('movie and TV IDs never collide', () => {
  assert.notEqual(itemKey(42, 'movie'), itemKey(42, 'tv'));
});

test('legacy watchlist keys are migrated from item shape', () => {
  const result = normalizeStoredWatchlist({
    42: { status: 'watching', item: { id: 42, name: 'Series' } },
    7: { status: 'watched', item: { id: 7, title: 'Movie' } }
  });
  assert.equal(result['tv:42'].status, 'watching');
  assert.equal(result['movie:7'].status, 'watched');
});

test('item type and escaping are safe defaults', () => {
  assert.equal(itemType({ name: 'Series' }), 'tv');
  assert.equal(itemType({ title: 'Movie' }), 'movie');
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('TMDB client builds proxy URLs and forwards abort signals', async () => {
  const signal = AbortSignal.abort();
  let captured;
  const client = createTmdbClient('/api/tmdb', 'https://example.com', async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await client('/search/multi', { query: 'Silo', signal });
  assert.equal(captured.url, 'https://example.com/api/tmdb/search/multi?query=Silo');
  assert.equal(captured.options.signal, signal);
});

test('TMDB client supports a cross-origin rate-limited proxy', async () => {
  let requested;
  const tmdbFetch = createTmdbClient(
    'https://worker.example/api/tmdb',
    'https://staging.example',
    async url => {
      requested = url;
      return { ok: true, json: async () => ({ ok: true }) };
    }
  );

  await tmdbFetch('tv/42', { language: 'en-US' });
  assert.equal(requested.origin, 'https://worker.example');
  assert.equal(requested.pathname, '/api/tmdb/tv/42');
});
