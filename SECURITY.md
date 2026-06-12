# Security setup

## Supabase

Run `supabase/security-hardening.sql` in the Supabase SQL Editor. It replaces
all existing policies on the two user-data tables. Then test with two different
users that neither account can read, update, or delete the other account's rows.

The public Supabase anon key is expected in the browser. Never expose a
`service_role` key in this repository or in client-side code.

## Private access

1. Run `supabase/signup-allowlist.sql` in the Supabase SQL Editor.
2. Insert every allowed email address in lowercase into
   `public.allowed_signup_emails`.
3. In Supabase Dashboard, open Authentication > Hooks and configure the
   `Before User Created` hook to use `public.hook_allowlisted_signup`.

Existing users are not removed by this hook. Remove unwanted existing users in
Authentication > Users.

## TMDB

TMDB requests use the Cloudflare Pages Function at `/api/tmdb/*`.

1. Rotate the currently exposed TMDB key.
2. In Cloudflare Pages > Settings > Variables and Secrets, add the encrypted
   secret `TMDB_API_KEY` for both Preview and Production.
3. Redeploy both branches.
4. Optionally add a Cloudflare rate-limiting rule for `/api/tmdb/*`.
