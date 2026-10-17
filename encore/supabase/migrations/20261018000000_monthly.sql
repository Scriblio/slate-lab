-- Encore Monthly (functions/stripe-webhook and functions/encore-license): a subscription to the
-- whole app, with Encore Cloud included while it lasts. Encore bought once is still the main
-- sale; this is the cheaper way in for someone who isn't ready for $149.
--
-- It is paid by Stripe invoice, and worked out the way a Cloud year is: as the sum of the
-- periods that were paid for. Nothing has to hear that a subscription was cancelled; when the
-- last paid month runs out, so does the access. The license service adds a few days of grace on
-- top (SUBSCRIPTION_GRACE_DAYS in functions/encore-license/core.ts), so a renewal that lands
-- while a laptop is offline at a gig doesn't lock anyone out.
--
-- app_until is the end of the last paid month. app_forever (Encore bought, or an unlock code)
-- outranks it, and the owner is never asked about it.

alter table public.licenses add column app_until timestamptz;

-- license_stripe_apply gains the paid month. The ten-argument version goes, so that PostgREST
-- has exactly one function of that name to find.
drop function public.license_stripe_apply(text, text, uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz);

-- One Stripe event, applied to the account it belongs to. As before (see the Stripe migration), plus:
--
--   p_app_from/to     a paid month of Encore Monthly: its length is added after the later of
--                     the access already there and the period's start, so paying early loses
--                     nothing and paying late doesn't give back the days in between
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
  p_cloud_grace_until timestamptz,
  p_app_from timestamptz default null,
  p_app_to timestamptz default null
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
  v_app timestamptz;
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

  v_app := lic.app_until;
  if p_app_from is not null and p_app_to is not null and p_app_to > p_app_from then
    v_app := greatest(coalesce(v_app, p_app_from), p_app_from) + (p_app_to - p_app_from);
  end if;

  update public.licenses
  set app_forever = app_forever or coalesce(p_app, false),
      cloud_until = v_cloud,
      app_until = v_app,
      stripe_customer_id = coalesce(stripe_customer_id, p_customer),
      stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
      source = case when coalesce(p_app, false) or coalesce(p_cloud_add_year, false) or p_cloud_to is not null or p_app_to is not null then 'stripe' else source end,
      updated_at = now()
  where user_id = v_user;
  return 'ok';
end;
$$;

-- For the owner, in the SQL editor: take a purchase back after a refund. The trial and
-- any unlock codes the account has used are left alone. (Now it ends a monthly subscription's
-- paid time too.)
--   select revoke_purchase('them@example.com');
create or replace function public.revoke_purchase(email text)
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
  set app_forever = false, cloud_until = null, app_until = null, stripe_subscription_id = null, updated_at = now()
  where user_id = uid;
  return revoke_purchase.email || ' no longer has a purchase (their trial and unlock codes are untouched).';
end;
$$;

-- Only the service (and you, in the SQL editor) can run it; the public keys can't. (New functions in
-- public are runnable by everyone until this says otherwise.)
revoke execute on function
  public.license_stripe_apply(text, text, uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
from public, anon, authenticated;
grant execute on function
  public.license_stripe_apply(text, text, uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
to service_role;
