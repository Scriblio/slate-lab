-- Shared reports from every copy of Encore, so a YouTube video one KJ finds
-- broken (YouTube won't play it inside Encore) or not karaoke is skipped for
-- everyone. Kept: the video id, the kind of report, and one-way hashes of who
-- reported it (their installation, and their network address with a secret
-- salt), for 30 days. A video is hidden only once enough different networks
-- agree, so one person can't remove a video for everybody. RLS is on with no
-- policies: only the search function, with the secret key, can touch it.

create table public.yt_reports (
  video_id text not null,
  kind text not null check (kind in ('refused', 'not_karaoke')),
  reporter text not null,
  network text not null,
  reported_at timestamptz not null default now(),
  primary key (video_id, kind, reporter)
);

create index yt_reports_recent on public.yt_reports (video_id, kind, reported_at);

alter table public.yt_reports enable row level security;

-- The videos among p_ids that enough different networks reported in the last
-- 30 days: p_refused for "won't play here", p_not_karaoke for "not karaoke".
create function public.yt_blocked(p_ids text[], p_refused integer, p_not_karaoke integer)
returns table (video_id text, kind text)
language sql
stable
set search_path = ''
as $$
  select r.video_id, r.kind
  from public.yt_reports r
  where r.video_id = any (p_ids) and r.reported_at > now() - interval '30 days'
  group by r.video_id, r.kind
  having count(distinct r.network) >= case r.kind when 'refused' then p_refused else p_not_karaoke end;
$$;

-- YouTube's policies allow keeping API data for at most 30 days; reports go with it.
create or replace function public.yt_prune()
returns void
language sql
set search_path = ''
as $$
  delete from public.yt_search_cache where fetched_at < now() - interval '30 days';
  delete from public.yt_search_usage where day < current_date - 3;
  delete from public.yt_reports where reported_at < now() - interval '30 days';
$$;

revoke all on table public.yt_reports from anon, authenticated;
revoke execute on function public.yt_blocked(text[], integer, integer) from public, anon, authenticated;
grant execute on function public.yt_blocked(text[], integer, integer) to service_role;
revoke execute on function public.yt_prune() from public, anon, authenticated;
grant execute on function public.yt_prune() to service_role;
