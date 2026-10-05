-- Supabase's API refuses a DELETE without a WHERE clause (pg_safeupdate), so
-- yt_catalog_commit failed when it cleared the staging table, and the whole
-- commit rolled back. Same function, with the clear spelled "where true".

create or replace function public.yt_catalog_commit(p_keep integer)
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
  delete from public.yt_catalog_staging where true;
  return kept;
end;
$$;

revoke execute on function public.yt_catalog_commit(integer) from public, anon, authenticated;
grant execute on function public.yt_catalog_commit(integer) to service_role;
