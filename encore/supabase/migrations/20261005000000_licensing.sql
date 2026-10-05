-- Licensing (functions/encore-license): who may run Encore and for how long,
-- the free trials, and the unlock codes the owner gives out.
--
-- Only the function touches these, with the project's secret key. RLS is on
-- everywhere and the public keys get nothing, except that a signed-in KJ may
-- read their own license row. The owner makes and turns off codes, and marks
-- their own account, from the SQL editor with the functions at the end.
--
-- What a code grants isn't copied into the license row. The service works it out
-- from the codes an account has redeemed each time it's asked, so turning a code
-- off takes effect the next time that KJ's laptop checks in.

create table public.licenses (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Encore is theirs forever (a purchase; set by the payment step, not by a code).
  app_forever boolean not null default false,
  -- Encore Cloud: until this date, or forever.
  cloud_until timestamptz,
  cloud_forever boolean not null default false,
  -- The free trial: set once, when it starts.
  trial_ends_at timestamptz,
  -- The owner's own account: everything, forever.
  owner boolean not null default false,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.unlock_codes (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of the code in its proper form. The code itself is never stored.
  code_hash text not null unique,
  note text not null default '',
  -- 'forever': the app and Cloud for good. 'app': the app for good. 'cloud_year': a year of Cloud.
  grants text not null default 'forever' check (grants in ('forever', 'app', 'cloud_year')),
  max_uses integer not null default 1 check (max_uses >= 1),
  uses integer not null default 0 check (uses >= 0),
  revoked boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.code_redemptions (
  code_id uuid not null references public.unlock_codes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  install_id text not null,
  redeemed_at timestamptz not null default now(),
  primary key (code_id, user_id)
);
create index code_redemptions_user_idx on public.code_redemptions (user_id);

-- One free trial per laptop. If the account is deleted the row stays, without the
-- link to a person, so deleting an account doesn't hand its laptop another trial.
create table public.trials (
  install_id text primary key,
  user_id uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now()
);

-- How many times each account and network has tried something this hour (unlock codes).
create table public.license_attempts (
  bucket text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  primary key (bucket, window_start)
);

alter table public.licenses enable row level security;
alter table public.unlock_codes enable row level security;
alter table public.code_redemptions enable row level security;
alter table public.trials enable row level security;
alter table public.license_attempts enable row level security;

create policy licenses_read_own on public.licenses for select to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.licenses, public.unlock_codes, public.code_redemptions, public.trials, public.license_attempts from anon, authenticated;
grant select on public.licenses to authenticated;

-- --- what the service asks the database --------------------------------------------

-- Everything the service needs to work out one account's pass, in one trip.
create function public.license_snapshot(p_user uuid, p_install text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'license', (select to_jsonb(l) from public.licenses l where l.user_id = p_user),
    'grants', coalesce(
      (
        select jsonb_agg(jsonb_build_object('grants', c.grants, 'redeemedAt', r.redeemed_at) order by r.redeemed_at)
        from public.code_redemptions r
        join public.unlock_codes c on c.id = r.code_id
        where r.user_id = p_user and not c.revoked
      ),
      '[]'::jsonb
    ),
    'installHadTrial', exists (select 1 from public.trials t where t.install_id = p_install)
  );
$$;

-- Start the free trial, once per account and once per laptop. Returns 'started',
-- 'account' (this account has had its trial), 'install' (this laptop has, under
-- another account) or 'owned' (the app is already theirs).
create function public.license_start_trial(p_user uuid, p_install text, p_days integer default 14)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  lic public.licenses;
begin
  insert into public.licenses (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into lic from public.licenses where user_id = p_user for update;
  if lic.owner or lic.app_forever then
    return 'owned';
  end if;
  if lic.trial_ends_at is not null then
    return 'account';
  end if;
  insert into public.trials (install_id, user_id) values (p_install, p_user) on conflict (install_id) do nothing;
  if not found then
    return 'install';
  end if;
  update public.licenses
  set trial_ends_at = now() + make_interval(days => p_days), source = coalesce(source, 'trial'), updated_at = now()
  where user_id = p_user;
  return 'started';
end;
$$;

-- Use a code (by its hash) for an account. Returns 'ok', or why not: 'not-found',
-- 'revoked', 'expired', 'already' (this account has used it) or 'used-up'.
create function public.license_redeem_code(p_code_hash text, p_user uuid, p_install text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.unlock_codes;
begin
  -- Locked, so two KJs using the last use of a code at once can't both get it.
  select * into c from public.unlock_codes where code_hash = p_code_hash for update;
  if not found then
    return 'not-found';
  end if;
  if c.revoked then
    return 'revoked';
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return 'expired';
  end if;
  if exists (select 1 from public.code_redemptions r where r.code_id = c.id and r.user_id = p_user) then
    return 'already';
  end if;
  if c.uses >= c.max_uses then
    return 'used-up';
  end if;
  insert into public.code_redemptions (code_id, user_id, install_id) values (c.id, p_user, p_install);
  update public.unlock_codes set uses = uses + 1 where id = c.id;
  return 'ok';
end;
$$;

-- Count one try against every bucket, but only if all are under their limit. Returns
-- the first bucket that is full, or null once counted. (Like yt_take, by the hour.)
create function public.license_take(p_buckets text[], p_limits integer[], p_window timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  full_bucket text;
begin
  if coalesce(array_length(p_buckets, 1), 0) = 0 or array_length(p_buckets, 1) <> array_length(p_limits, 1) then
    raise exception 'buckets and limits must match';
  end if;

  insert into public.license_attempts (bucket, window_start)
  select b, p_window from unnest(p_buckets) as b order by b
  on conflict (bucket, window_start) do nothing;

  -- Lock in a fixed order so two tries at once can't deadlock.
  perform 1 from public.license_attempts a
  where a.window_start = p_window and a.bucket = any (p_buckets)
  order by a.bucket
  for update;

  select l.bucket into full_bucket
  from unnest(p_buckets, p_limits) with ordinality as l(bucket, lim, i)
  join public.license_attempts a on a.bucket = l.bucket and a.window_start = p_window
  where a.attempts >= l.lim
  order by l.i
  limit 1;
  if full_bucket is not null then
    return full_bucket;
  end if;

  update public.license_attempts a set attempts = a.attempts + 1
  where a.window_start = p_window and a.bucket = any (p_buckets);
  return null;
end;
$$;

create function public.license_prune()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.license_attempts where window_start < now() - interval '2 days';
$$;

-- --- for the owner, in the SQL editor ---------------------------------------------

-- A code as a KJ might type it, in its one proper form (ENC-XXXX-XXXX-XXXX), or null
-- if it can't be a code. Case, spaces, dashes and the ENC prefix don't matter, and O, I
-- and L read as 0, 1 and 1. functions/encore-license/codes.ts does exactly the same.
create function public.normalize_unlock_code(p_code text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  s text := translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011');
begin
  if length(s) = 15 and left(s, 3) = 'ENC' then
    s := substr(s, 4);
  end if;
  if s !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$' then
    return null;
  end if;
  return 'ENC-' || substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4);
end;
$$;

create function public.hash_unlock_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

-- Make a code and show it, once; only its hash is kept.
--   select make_unlock_code('for Dave');                 -- Encore and Cloud forever, one KJ
--   select make_unlock_code('for the band', 'app', 3);   -- the app forever, three KJs
--   select make_unlock_code('prize', 'cloud_year', 1, 30);  -- a year of Cloud, good for 30 days
create function public.make_unlock_code(
  note text,
  grants text default 'forever',
  max_uses integer default 1,
  expires_in_days integer default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bits bigint;
  body text;
  code text;
begin
  if make_unlock_code.grants not in ('forever', 'app', 'cloud_year') then
    raise exception 'grants must be forever, app or cloud_year (not %).', make_unlock_code.grants;
  end if;
  if coalesce(make_unlock_code.max_uses, 0) < 1 then
    raise exception 'max_uses must be 1 or more.';
  end if;
  loop
    -- 60 random bits: the 15 hex digits of a random uuid that carry no version or variant marker.
    bits := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 18, 15))::bit(60)::bigint;
    body := '';
    for i in reverse 11..0 loop
      body := body || substr(alphabet, ((bits >> (5 * i)) & 31)::integer + 1, 1);
    end loop;
    code := 'ENC-' || substr(body, 1, 4) || '-' || substr(body, 5, 4) || '-' || substr(body, 9, 4);
    begin
      insert into public.unlock_codes (code_hash, note, grants, max_uses, expires_at)
      values (
        public.hash_unlock_code(code),
        coalesce(make_unlock_code.note, ''),
        make_unlock_code.grants,
        make_unlock_code.max_uses,
        case when make_unlock_code.expires_in_days is null then null else now() + make_interval(days => make_unlock_code.expires_in_days) end
      );
      return code;
    exception
      when unique_violation then
        null; -- the same code twice in a quintillion: just make another
    end;
  end loop;
end;
$$;

-- Turn a code off, by the code or by its note (every code with that note). It stops working
-- the next time that KJ's laptop checks in. Returns how many were turned off.
--   select revoke_unlock_code('for Dave');
--   select revoke_unlock_code('ENC-7K4Q-M2XP-9R8T');
create function public.revoke_unlock_code(code_or_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical text := public.normalize_unlock_code(code_or_note);
  n integer := 0;
begin
  if canonical is not null then
    update public.unlock_codes set revoked = true where code_hash = public.hash_unlock_code(canonical) and not revoked;
    get diagnostics n = row_count;
  end if;
  if n = 0 then
    update public.unlock_codes set revoked = true where lower(btrim(note)) = lower(btrim(coalesce(code_or_note, ''))) and not revoked;
    get diagnostics n = row_count;
  end if;
  if n = 0 then
    raise exception 'No unlock code that is still on matches "%". Check the code or note; it may already be turned off.', code_or_note;
  end if;
  return n;
end;
$$;

-- Mark an account as the owner's: everything, forever, no code needed. The account has
-- to exist, so sign in to Encore with that email first. set_owner('me@example.com', false) undoes it.
create function public.set_owner(email text, make_owner boolean default true)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(set_owner.email)) limit 1;
  if uid is null then
    raise exception 'Nobody has signed in to Encore with "%" yet. Sign in once with that email, then run this again.', set_owner.email;
  end if;
  insert into public.licenses (user_id, owner, source) values (uid, set_owner.make_owner, case when set_owner.make_owner then 'owner' end)
  on conflict (user_id) do update
  set owner = set_owner.make_owner, source = case when set_owner.make_owner then 'owner' else public.licenses.source end, updated_at = now();
  return set_owner.email || case when set_owner.make_owner then ' is now the owner.' else ' is no longer the owner.' end;
end;
$$;

-- Only the service (and you, in the SQL editor) can run any of these; the public keys can't.
revoke execute on function
  public.license_snapshot(uuid, text),
  public.license_start_trial(uuid, text, integer),
  public.license_redeem_code(text, uuid, text),
  public.license_take(text[], integer[], timestamptz),
  public.license_prune(),
  public.normalize_unlock_code(text),
  public.hash_unlock_code(text),
  public.make_unlock_code(text, text, integer, integer),
  public.revoke_unlock_code(text),
  public.set_owner(text, boolean)
from public, anon, authenticated;
grant execute on function
  public.license_snapshot(uuid, text),
  public.license_start_trial(uuid, text, integer),
  public.license_redeem_code(text, uuid, text),
  public.license_take(text[], integer[], timestamptz),
  public.license_prune(),
  public.normalize_unlock_code(text),
  public.hash_unlock_code(text),
  public.make_unlock_code(text, text, integer, integer),
  public.revoke_unlock_code(text),
  public.set_owner(text, boolean)
to service_role;
