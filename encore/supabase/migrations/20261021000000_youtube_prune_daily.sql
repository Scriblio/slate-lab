-- YouTube's policies allow keeping API data for at most 30 days. yt_prune() deletes anything older (the
-- search cache, the reports and the catalog), but until now it ran only when a search happened to trigger
-- it (one search in fifty), so a quiet month could leave old rows in place. Run it every day, whatever else
-- happens. Scheduling under the same name again just replaces the job.

select cron.schedule('yt-prune-daily', '17 4 * * *', $$select public.yt_prune();$$);
