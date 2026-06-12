# TrackMyMovie

A lightweight movie and TV series tracker powered by TMDB, Supabase, and
Cloudflare Pages.

## Structure

- `index.html`, `css/`, `js/`: client application
- `functions/api/tmdb/`: server-side TMDB proxy
- `supabase/`: RLS and optional signup allowlist SQL
- `_headers`: Cloudflare Pages security headers
- `SECURITY.md`: deployment security setup

Never commit private API keys or service-role credentials. The Supabase anon key
is intentionally public and must always be protected by RLS.

## Development

Run `node --test tests/*.test.js` and `node --check js/app.js` before publishing.

Before deploying the media-type-aware client to production, run
`supabase/media-type-migration.sql` once in the Supabase SQL Editor. It preserves
existing watchlist rows and allows movies and series with the same TMDB ID to
coexist.
