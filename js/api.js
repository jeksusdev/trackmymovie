(function initTrackMyMovieApi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrackMyMovieApi = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createApiModule() {
  function createTmdbClient(basePath, origin, fetchImpl) {
    return async function tmdbFetch(path, params = {}) {
      const url = new URL(`${basePath}/${path.replace(/^\/+/, '')}`, origin);
      Object.entries(params).forEach(([key, value]) => {
        if (key === 'signal') return;
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      });
      const response = await fetchImpl(url, params.signal ? { signal: params.signal } : undefined);
      if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
      return response.json();
    };
  }

  return { createTmdbClient };
}));
