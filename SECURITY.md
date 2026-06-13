# Security setup

## Supabase

Run `supabase/security-hardening.sql` in the Supabase SQL Editor. It replaces
all existing policies on the two user-data tables. Then test with two different
users that neither account can read, update, or delete the other account's rows.

Run `supabase/media-type-migration.sql` once before deploying clients that use
media-type-aware watchlist keys. The migration preserves existing rows.

The public Supabase anon key is expected in the browser. Never expose a
`service_role` key in this repository or in client-side code.

## Optional private access

TrackMyMovie currently allows any Google account to register. Only follow these
steps if the deployment should become private:

1. Run `supabase/signup-allowlist.sql` in the Supabase SQL Editor.
2. Insert every allowed email address in lowercase into
   `public.allowed_signup_emails`.
3. In Supabase Dashboard, open Authentication > Hooks and configure the
   `Before User Created` hook to use `public.hook_allowlisted_signup`.

Existing users are not removed by this hook. Remove unwanted existing users in
Authentication > Users.

## TMDB

TMDB requests use the rate-limited notifier Worker endpoint at `/api/tmdb/*`.

1. Rotate any TMDB key that has ever appeared in Git history.
2. In the notifier Worker, store `TMDB_API_KEY` as an encrypted secret.
3. Redeploy the notifier Worker.

## Public repository

- Keep secrets in Cloudflare or Supabase settings, never in Git.
- The Supabase anon key is public by design; RLS is the security boundary.
- Enable GitHub secret scanning, push protection, Dependabot alerts, and
  Dependabot security updates.
- Protect `main` from force pushes and deletion.
