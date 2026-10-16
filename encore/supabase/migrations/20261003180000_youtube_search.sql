-- YouTube search service (functions/youtube-search): a shared result cache
-- and daily usage counters. Only the function touches these, with a secret
-- key; RLS is on with no policies, so the public keys can't read or write them.

create table public.yt_search_cache (
  query_key text primary key,
  results jsonb not null,
  fetched_at timestamptz not null default now()
);

create table public.yt_search_usage (
  bucket text not null,
  day date not null,
  searches integer not null default 0,
  primary key (bucket, day)
);

alter table public.yt_search_cache enable row level security;
alter table public.yt_search_usage enable row level security;

-- Count one search against every bucket, but only if all are under their
-- limit. Returns the first bucket that is full, or null when counted.
create function public.yt_take(p_buckets text[], p_limits integer[], p_day date)
returns text
language plpgsql
set search_path = ''
as $$
declare
  full_bucket text;
begin
  if coalesce(array_length(p_buckets, 1), 0) = 0 or array_length(p_buckets, 1) <> array_length(p_limits, 1) then
    raise exception 'buckets and limits must match';
  end if;

  insert into public.yt_search_usage (bucket, day)
  select b, p_day from unnest(p_buckets) as b order by b
  on conflict (bucket, day) do nothing;

  -- Lock in a fixed order so concurrent searches can't deadlock.
  perform 1 from public.yt_search_usage u
  where u.day = p_day and u.bucket = any (p_buckets)
  order by u.bucket
  for update;

  select l.bucket into full_bucket
  from unnest(p_buckets, p_limits) with ordinality as l(bucket, lim, i)
  join public.yt_search_usage u on u.bucket = l.bucket and u.day = p_day
  where u.searches >= l.lim
  order by l.i
  limit 1;
  if full_bucket is not null then
    return full_bucket;
  end if;

  update public.yt_search_usage u set searches = u.searches + 1
  where u.day = p_day and u.bucket = any (p_buckets);
  return null;
end;
$$;

-- YouTube's policies allow keeping API data for at most 30 days.
create function public.yt_prune()
returns void
language sql
set search_path = ''
as $$
  delete from public.yt_search_cache where fetched_at < now() - interval '30 days';
  delete from public.yt_search_usage where day < current_date - 3;
$$;

revoke all on table public.yt_search_cache, public.yt_search_usage from anon, authenticated;
revoke execute on function public.yt_take(text[], integer[], date), public.yt_prune() from public, anon, authenticated;
grant execute on function public.yt_take(text[], integer[], date), public.yt_prune() to service_role;
