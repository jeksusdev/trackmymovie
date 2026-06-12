-- Preserve existing watchlist rows while allowing a movie and TV show
-- with the same TMDB numeric ID to coexist.

alter table public.watchlist
add column if not exists media_type text;

update public.watchlist
set media_type = case
  when item->>'media_type' in ('movie', 'tv') then item->>'media_type'
  when item ? 'name' then 'tv'
  else 'movie'
end
where media_type is null;

alter table public.watchlist
alter column media_type set default 'movie';

alter table public.watchlist
alter column media_type set not null;

alter table public.watchlist
drop constraint if exists watchlist_media_type_check;

alter table public.watchlist
add constraint watchlist_media_type_check
check (media_type in ('movie', 'tv'));

alter table public.watchlist
drop constraint if exists watchlist_user_id_show_id_key;

create unique index if not exists watchlist_user_show_media_key
on public.watchlist (user_id, show_id, media_type);
