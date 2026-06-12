-- Run this in the Supabase SQL Editor after reviewing existing policies.

alter table public.watchlist enable row level security;
alter table public.episode_checks enable row level security;

do $$
declare policy_record record;
begin
  for policy_record in select policyname from pg_policies where schemaname = 'public' and tablename = 'watchlist'
  loop
    execute format('drop policy if exists %I on public.watchlist', policy_record.policyname);
  end loop;
  for policy_record in select policyname from pg_policies where schemaname = 'public' and tablename = 'episode_checks'
  loop
    execute format('drop policy if exists %I on public.episode_checks', policy_record.policyname);
  end loop;
end $$;

revoke all on table public.watchlist from anon;
revoke all on table public.episode_checks from anon;

grant select, insert, update, delete on table public.watchlist to authenticated;
grant select, insert, update, delete on table public.episode_checks to authenticated;

create policy "users manage own watchlist"
on public.watchlist
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "users manage own episode checks"
on public.episode_checks
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
