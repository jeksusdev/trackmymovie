-- Run this in the Supabase SQL Editor, then add allowed email addresses below.

create table if not exists public.allowed_signup_emails (
  email text primary key check (email = lower(email))
);

alter table public.allowed_signup_emails enable row level security;
revoke all on table public.allowed_signup_emails from anon, authenticated, public;
grant select on table public.allowed_signup_emails to supabase_auth_admin;

create or replace function public.hook_allowlisted_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  signup_email text := lower(event->'user'->>'email');
begin
  if exists (select 1 from public.allowed_signup_emails where email = signup_email) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This TrackMyMovie account is not allowlisted.'
    )
  );
end;
$$;

grant execute on function public.hook_allowlisted_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_allowlisted_signup(jsonb) from anon, authenticated, public;

-- Replace these examples before enabling the hook:
-- insert into public.allowed_signup_emails (email) values
--   ('you@example.com'),
--   ('friend@example.com');
