-- A catalog of popular karaoke videos, so most searches never use YouTube's
-- daily quota. It's built through the YouTube Data API (never by scraping):
-- listing a channel's uploads costs 1 unit per 50 videos, versus 100 units
-- for one search. The search function keeps the most-viewed embeddable
-- videos from a few karaoke channels, and rebuilds the catalog before it's
-- 30 days old (YouTube's storage limit). View counts are only used while
-- choosing, in the staging table, and are never kept. RLS is on with no
-- policies: only the function, with the secret key, can touch these.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table public.yt_catalog (
  video_id text primary key,
  title text not null,
  channel text not null,
  thumbnail text,
  duration_sec integer,
  fetched_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('simple', title || ' ' || channel)) stored
);
create index yt_catalog_search on public.yt_catalog using gin (search);
alter table public.yt_catalog enable row level security;

-- One import in progress: every video id on the channels, then its details.
create table public.yt_catalog_staging (
  video_id text primary key,
  title text,
  channel text,
  thumbnail text,
  duration_sec integer,
  views bigint,
  embeddable boolean,
  fetched boolean not null default false
);
alter table public.yt_catalog_staging enable row level security;

-- Where the import is up to, and the token the timer uses to nudge it along
-- (made here, and never leaves the database).
create table public.yt_catalog_job (
  id integer primary key default 1 check (id = 1),
  -- Which channels (handles or UC… ids), how many videos to keep, and the
  -- quota units the import may use per day (searches need the rest).
  channels text[] not null default array['@SingKingKaraoke', '@karafun'],
  keep integer not null default 5000,
  units_per_day integer not null default 2000,
  state jsonb not null default '{"phase":"idle"}',
  token text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  updated_at timestamptz not null default now()
);
insert into public.yt_catalog_job default values;
alter table public.yt_catalog_job enable row level security;

-- Catalog videos matching a search, best match first.
create function public.yt_catalog_search(p_query text, p_limit integer)
returns table (video_id text, title text, channel text, thumbnail text, duration_sec integer)
language sql
stable
set search_path = ''
as $$
  select c.video_id, c.title, c.channel, c.thumbnail, c.duration_sec
  from public.yt_catalog c, websearch_to_tsquery('simple', p_query) q
  where c.search @@ q and c.fetched_at > now() - interval '30 days'
  order by ts_rank(c.search, q) desc, c.title
  limit p_limit;
$$;

-- Put a finished import live: the p_keep most-viewed embeddable videos
-- replace the catalog. An import that found nothing never empties it.
create function public.yt_catalog_commit(p_keep integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  kept integer;
begin
  select count(*) into kept from (
    select 1 from public.yt_catalog_staging
    where fetched and embeddable and title is not null
    limit p_keep
  ) s;
  if kept = 0 then
    return 0;
  end if;
  with keep as (
    select s.video_id, s.title, s.channel, s.thumbnail, s.duration_sec
    from public.yt_catalog_staging s
    where s.fetched and s.embeddable and s.title is not null
    order by s.views desc nulls last
    limit p_keep
  ),
  gone as (
    delete from public.yt_catalog c where c.video_id not in (select k.video_id from keep k)
  )
  insert into public.yt_catalog (video_id, title, channel, thumbnail, duration_sec, fetched_at)
  select k.video_id, k.title, k.channel, k.thumbnail, k.duration_sec, now() from keep k
  on conflict (video_id) do update
    set title = excluded.title, channel = excluded.channel, thumbnail = excluded.thumbnail,
        duration_sec = excluded.duration_sec, fetched_at = excluded.fetched_at;
  delete from public.yt_catalog_staging;
  return kept;
end;
$$;

-- How old the catalog's oldest video is, in seconds (null when it's empty).
create function public.yt_catalog_age()
returns double precision
language sql
stable
set search_path = ''
as $$
  select extract(epoch from now() - min(fetched_at)) from public.yt_catalog;
$$;

-- YouTube data is kept at most 30 days; anything the rebuild missed goes too.
create or replace function public.yt_prune()
returns void
language sql
set search_path = ''
as $$
  delete from public.yt_search_cache where fetched_at < now() - interval '30 days';
  delete from public.yt_search_usage where day < current_date - 3;
  delete from public.yt_reports where reported_at < now() - interval '30 days';
  delete from public.yt_catalog where fetched_at < now() - interval '30 days';
$$;

revoke all on table public.yt_catalog, public.yt_catalog_staging, public.yt_catalog_job from anon, authenticated;
revoke execute on function public.yt_catalog_search(text, integer), public.yt_catalog_commit(integer), public.yt_catalog_age(), public.yt_prune()
  from public, anon, authenticated;
grant execute on function public.yt_catalog_search(text, integer), public.yt_catalog_commit(integer), public.yt_catalog_age(), public.yt_prune()
  to service_role;

-- Every 2 minutes, nudge the import along (it does nothing while the catalog
-- is fresh). Uses the publishable key, like Encore, plus the job's token.
select cron.schedule(
  'yt-catalog-tick',
  '*/2 * * * *',
  $cron$
  select net.http_post(
    url := 'https://oohgawkfnwhjlqlihhju.supabase.co/functions/v1/youtube-search',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_izlrNWtAjB1ilWhDeArfqA_p80ODhal'),
    body := jsonb_build_object('action', 'catalog', 'token', (select token from public.yt_catalog_job where id = 1)),
    timeout_milliseconds := 120000
  );
  $cron$
);
