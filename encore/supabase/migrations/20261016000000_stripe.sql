-- Payments, step 2 of docs/LICENSING.md (functions/stripe-webhook, and the checkout and
-- portal questions of functions/encore-license).
--
-- Stripe is the only thing that sets what a purchase gives. The webhook function turns
-- Stripe's events into calls to license_stripe_apply below, each event once. A purchase
-- is only ever written to the same two columns the unlock codes' grants sit beside
-- (licenses.app_forever and licenses.cloud_until), so the pass and the app need no new
-- idea of what a customer has.

alter table public.licenses
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text;

-- Stripe's own event ids, so a delivery that is retried, or sent twice, counts once.
create table public.stripe_events (
  id text primary key,
  type text not null,
  user_id uuid references auth.users (id) on delete set null,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
revoke all on table public.stripe_events from anon, authenticated;

-- One Stripe event, applied to the account it belongs to.
--
--   p_user            the account, when the event names one (a completed checkout does);
--                     otherwise it's found from p_customer
--   p_app             Encore is bought
--   p_cloud_add_year  add a year of Cloud after whatever Cloud the account already has
--                     (the purchase includes the first year)
--   p_cloud_from/to   a paid Cloud period: its length is added after the later of the
--                     Cloud already there and the period's start, so paying early
--                     loses nothing
--   p_cloud_grace_until  a renewal failed: keep Cloud on until this date (never moves back)
--
-- Returns 'ok', 'duplicate' (this event was already applied) or 'unknown-account' (no
-- account yet for that customer: nothing is recorded, so Stripe's retry can find it once
-- the checkout that links them has been seen).
create function public.license_stripe_apply(
  p_event text,
  p_type text,
  p_user uuid,
  p_customer text,
  p_subscription text,
  p_app boolean,
  p_cloud_add_year boolean,
  p_cloud_from timestamptz,
  p_cloud_to timestamptz,
  p_cloud_grace_until timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := p_user;
  lic public.licenses;
  v_cloud timestamptz;
begin
  if exists (select 1 from public.stripe_events e where e.id = p_event) then
    return 'duplicate';
  end if;

  if v_user is null and p_customer is not null then
    select l.user_id into v_user from public.licenses l where l.stripe_customer_id = p_customer;
  end if;
  if v_user is null or not exists (select 1 from auth.users u where u.id = v_user) then
    return 'unknown-account';
  end if;

  insert into public.stripe_events (id, type, user_id) values (p_event, p_type, v_user) on conflict (id) do nothing;
  if not found then
    return 'duplicate'; -- the same event, delivered twice at once
  end if;

  insert into public.licenses (user_id) values (v_user) on conflict (user_id) do nothing;
  select * into lic from public.licenses where user_id = v_user for update;

  v_cloud := lic.cloud_until;
  if coalesce(p_cloud_add_year, false) then
    v_cloud := greatest(coalesce(v_cloud, now()), now()) + interval '1 year';
  end if;
  if p_cloud_from is not null and p_cloud_to is not null and p_cloud_to > p_cloud_from then
    v_cloud := greatest(coalesce(v_cloud, p_cloud_from), p_cloud_from) + (p_cloud_to - p_cloud_from);
  end if;
  if p_cloud_grace_until is not null then
    v_cloud := greatest(coalesce(v_cloud, p_cloud_grace_until), p_cloud_grace_until);
  end if;

  update public.licenses
  set app_forever = app_forever or coalesce(p_app, false),
      cloud_until = v_cloud,
      stripe_customer_id = coalesce(stripe_customer_id, p_customer),
      stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
      source = case when coalesce(p_app, false) or coalesce(p_cloud_add_year, false) or p_cloud_to is not null then 'stripe' else source end,
      updated_at = now()
  where user_id = v_user;
  return 'ok';
end;
$$;

-- For the owner, in the SQL editor: take a purchase back after a refund. The trial and
-- any unlock codes the account has used are left alone.
--   select revoke_purchase('them@example.com');
create function public.revoke_purchase(email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(revoke_purchase.email)) limit 1;
  if uid is null then
    raise exception 'Nobody has signed in to Encore with "%".', revoke_purchase.email;
  end if;
  update public.licenses
  set app_forever = false, cloud_until = null, stripe_subscription_id = null, updated_at = now()
  where user_id = uid;
  return revoke_purchase.email || ' no longer has a purchase (their trial and unlock codes are untouched).';
end;
$$;

-- Only the service (and you, in the SQL editor) can run these; the public keys can't.
revoke execute on function
  public.license_stripe_apply(text, text, uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz),
  public.revoke_purchase(text)
from public, anon, authenticated;
grant execute on function
  public.license_stripe_apply(text, text, uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz),
  public.revoke_purchase(text)
to service_role;
