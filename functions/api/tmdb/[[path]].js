const WORKER_TMDB_BASE = 'https://trackmymovie-notifier.jeksusdev.workers.dev/api/tmdb';

export function onRequestGet(context) {
  const path = Array.isArray(context.params.path)
    ? context.params.path.join('/')
    : String(context.params.path || '');
  const incoming = new URL(context.request.url);
  const target = new URL(`${WORKER_TMDB_BASE}/${path.replace(/^\/+/, '')}`);
  target.search = incoming.search;
  return Response.redirect(target, 307);
}
