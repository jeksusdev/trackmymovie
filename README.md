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
