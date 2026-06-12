const ALLOWED_PATHS = [
  /^genre\/(?:movie|tv)\/list$/,
  /^search\/multi$/,
  /^trending\/all\/week$/,
  /^tv\/top_rated$/,
  /^(?:movie|tv)\/\d+$/,
  /^tv\/\d+\/season\/\d+$/
];

const ALLOWED_PARAMS = new Set([
  'language',
  'query',
  'include_adult',
  'append_to_response'
]);

export async function onRequestGet(context) {
  const apiKey = context.env.TMDB_API_KEY;
  if (!apiKey) return json({ error: 'TMDB proxy is not configured' }, 503);

  const rawPath = Array.isArray(context.params.path)
    ? context.params.path.join('/')
    : String(context.params.path || '');
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  if (!ALLOWED_PATHS.some(pattern => pattern.test(path))) {
    return json({ error: 'TMDB endpoint is not allowed' }, 404);
  }

  const incoming = new URL(context.request.url);
  const upstream = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [key, value] of incoming.searchParams) {
    if (ALLOWED_PARAMS.has(key)) upstream.searchParams.set(key, value.slice(0, 300));
  }
  upstream.searchParams.set('api_key', apiKey);

  const response = await fetch(upstream, { headers: { Accept: 'application/json' } });
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': path === 'search/multi'
        ? 'private, no-store'
        : 'public, max-age=300, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
