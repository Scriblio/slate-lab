// The payments migration's functions and permissions, against a real Postgres.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLicenseDb, type TestDb } from './licensedb.ts';

let t: TestDb;
beforeAll(async () => {
  t = await openLicenseDb();
}, 60_000);
afterAll(async () => {
  await t.db.close();
});

interface Event {
  event?: string;
  type?: string;
  user?: string | null;
  customer?: string | null;
  subscription?: string | null;
  app?: boolean;
  addYear?: boolean;
  from?: string | null;
  to?: string | null;
  grace?: string | null;
  appFrom?: string | null;
  appTo?: string | null;
}

let counter = 0;
const apply = (e: Event) =>
  t.value<string>('select license_stripe_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
    e.event ?? `evt_${++counter}`,
    e.type ?? 'test.event',
    e.user ?? null,
    e.customer ?? null,
    e.subscription ?? null,
    e.app ?? false,
    e.addYear ?? false,
    e.from ?? null,
    e.to ?? null,
    e.grace ?? null,
    e.appFrom ?? null,
    e.appTo ?? null,
  ]);

const row = async (user: string) =>
  (await t.rows<{ app_forever: boolean; stripe_customer_id: string | null; stripe_subscription_id: string | null; source: string | null; trial: boolean }>(
    'select app_forever, stripe_customer_id, stripe_subscription_id, source, trial_ends_at is not null as trial from licenses where user_id = $1',
    [user],
  ))[0];
/** Days from now to the end of someone's Cloud (null if none). */
const cloudDays = (user: string) =>
  t.value<number | null>('select extract(epoch from (cloud_until - now())) / 86400 from licenses where user_id = $1', [user]);
const setCloud = (user: string, days: number) =>
  t.db.query("insert into licenses (user_id, cloud_until) values ($1, now() + make_interval(days => $2)) on conflict (user_id) do update set cloud_until = excluded.cloud_until", [user, days]);
const inDays = (n: number) => t.value<string>("select (now() + make_interval(days => $1))::text", [n]);
/** Days from now to the end of someone's paid Encore Monthly (null if none). */
const appDays = (user: string) => t.value<number | null>('select extract(epoch from (app_until - now())) / 86400 from licenses where user_id = $1', [user]);
const setApp = (user: string, days: number) =>
  t.db.query('insert into licenses (user_id, app_until) values ($1, now() + make_interval(days => $2)) on conflict (user_id) do update set app_until = excluded.app_until', [user, days]);
/** Days from now to `ahead` days from now plus `years` calendar years, worked out by Postgres so leap years don't matter. */
const span = (ahead: number, years: number) =>
  t.value<number>('select extract(epoch from ((now() + make_interval(days => $1)) + make_interval(years => $2) - now())) / 86400', [ahead, years]);

describe('applying a purchase', () => {
  it('makes Encore theirs and adds a year of Cloud', async () => {
    const user = await t.addUser('buyer@example.com');
    expect(await apply({ user, customer: 'cus_buyer', app: true, addYear: true })).toBe('ok');
    expect(await row(user)).toMatchObject({ app_forever: true, stripe_customer_id: 'cus_buyer', source: 'stripe' });
    expect(await cloudDays(user)).toBeCloseTo(await span(0, 1), 1);
  });

  it('counts the same event once, however many times Stripe sends it', async () => {
    const user = await t.addUser('twice@example.com');
    expect(await apply({ event: 'evt_same', user, customer: 'cus_twice', app: true, addYear: true })).toBe('ok');
    expect(await apply({ event: 'evt_same', user, customer: 'cus_twice', app: true, addYear: true })).toBe('duplicate');
    expect(await cloudDays(user)).toBeCloseTo(await span(0, 1), 1);
    expect(await t.value<number>("select count(*)::int from stripe_events where id = 'evt_same'")).toBe(1);
  });

  it('puts a second purchase’s year after the first, like the year-of-Cloud codes', async () => {
    const user = await t.addUser('stack@example.com');
    await apply({ user, customer: 'cus_stack', app: true, addYear: true });
    await apply({ user, addYear: true });
    expect(await cloudDays(user)).toBeCloseTo(await span(0, 2), 1);
  });

  it('starts the year after Cloud that is already there, and from today if it has run out', async () => {
    const early = await t.addUser('early@example.com');
    await setCloud(early, 100);
    await apply({ user: early, app: true, addYear: true });
    expect(await cloudDays(early)).toBeCloseTo(await span(100, 1), 1);

    const late = await t.addUser('late@example.com');
    await setCloud(late, -40);
    await apply({ user: late, app: true, addYear: true });
    expect(await cloudDays(late)).toBeCloseTo(await span(0, 1), 1);
  });

  it('leaves the trial alone', async () => {
    const user = await t.addUser('trial@example.com');
    await t.value('select license_start_trial($1, $2, 14)', [user, 'trial-laptop-1234567']);
    await apply({ user, app: true, addYear: true });
    expect(await row(user)).toMatchObject({ app_forever: true, trial: true });
  });

  it('refuses an account that does not exist, and records nothing so a retry can work', async () => {
    const ghost = '11111111-2222-3333-4444-555555555555';
    expect(await apply({ event: 'evt_ghost', user: ghost, app: true })).toBe('unknown-account');
    expect(await t.value<number>("select count(*)::int from stripe_events where id = 'evt_ghost'")).toBe(0);
  });
});

describe('Cloud subscriptions', () => {
  it('adds the length of a paid period after the Cloud already there, so paying early loses nothing', async () => {
    const user = await t.addUser('sub-early@example.com');
    await setCloud(user, 30);
    const from = await inDays(0);
    const to = await inDays(365);
    expect(await apply({ user, customer: 'cus_sub1', subscription: 'sub_1', from, to })).toBe('ok');
    expect(await cloudDays(user)).toBeCloseTo(395, 1);
    expect(await row(user)).toMatchObject({ stripe_customer_id: 'cus_sub1', stripe_subscription_id: 'sub_1' });
  });

  it('ends a paid year a year from its start when nothing was left', async () => {
    const user = await t.addUser('sub-new@example.com');
    await setCloud(user, -10);
    expect(await apply({ user, customer: 'cus_sub2', subscription: 'sub_2', from: await inDays(0), to: await inDays(365) })).toBe('ok');
    expect(await cloudDays(user)).toBeCloseTo(365, 1);
  });

  it('renews: the next year starts where the last one ended', async () => {
    const user = await t.addUser('renew@example.com');
    await setCloud(user, 0);
    const start = await t.value<string>('select cloud_until::text from licenses where user_id = $1', [user]);
    const end = await t.value<string>("select (cloud_until + interval '365 days')::text from licenses where user_id = $1", [user]);
    await apply({ user, customer: 'cus_renew', subscription: 'sub_r', from: start, to: end });
    expect(await cloudDays(user)).toBeCloseTo(365, 1);
  });

  it('finds the account from the customer', async () => {
    const user = await t.addUser('lookup@example.com');
    await apply({ user, customer: 'cus_lookup', app: true });
    expect(await apply({ customer: 'cus_lookup', from: await inDays(0), to: await inDays(365) })).toBe('ok');
    expect(await cloudDays(user)).toBeCloseTo(365, 1);
  });

  it('waits for a customer it has not met yet (Stripe sends the invoice and the checkout in either order)', async () => {
    const event = 'evt_early_invoice';
    expect(await apply({ event, customer: 'cus_late_link', from: await inDays(0), to: await inDays(365) })).toBe('unknown-account');
    const user = await t.addUser('latelink@example.com');
    await apply({ user, customer: 'cus_late_link', subscription: 'sub_ll' });
    expect(await apply({ event, customer: 'cus_late_link', from: await inDays(0), to: await inDays(365) })).toBe('ok');
    expect(await cloudDays(user)).toBeCloseTo(365, 1);
  });

  it('keeps Cloud on while a failed renewal is retried, and never shortens it', async () => {
    const user = await t.addUser('grace@example.com');
    await setCloud(user, -1);
    await apply({ user, customer: 'cus_grace', grace: await inDays(7) });
    expect(await cloudDays(user)).toBeCloseTo(7, 1);

    const paid = await t.addUser('grace-paid@example.com');
    await setCloud(paid, 200);
    await apply({ user: paid, customer: 'cus_grace2', grace: await inDays(7) });
    expect(await cloudDays(paid)).toBeCloseTo(200, 1);
  });
});

describe('Encore Monthly', () => {
  it('adds a paid month to the app’s paid time, and moves nothing else', async () => {
    const user = await t.addUser('monthly@example.com');
    expect(await apply({ user, customer: 'cus_m1', subscription: 'sub_m1', appFrom: await inDays(0), appTo: await inDays(30) })).toBe('ok');
    expect(await appDays(user)).toBeCloseTo(30, 1);
    expect(await row(user)).toMatchObject({ app_forever: false, stripe_customer_id: 'cus_m1', stripe_subscription_id: 'sub_m1', source: 'stripe' });
    // Cloud comes with Encore Monthly in the license service, not as a date in this row.
    expect(await cloudDays(user)).toBeNull();
  });

  it('renews: the next month starts where the last one ended, and paying early loses nothing', async () => {
    const user = await t.addUser('monthly-renew@example.com');
    await setApp(user, 10);
    await apply({ user, appFrom: await inDays(10), appTo: await inDays(40) });
    expect(await appDays(user)).toBeCloseTo(40, 1);

    const early = await t.addUser('monthly-early@example.com');
    await setApp(early, 10);
    await apply({ user: early, appFrom: await inDays(0), appTo: await inDays(30) });
    expect(await appDays(early)).toBeCloseTo(40, 1);
  });

  it('after a lapse, counts from the month’s own start, so the days in between are not given back', async () => {
    const lapsed = await t.addUser('monthly-lapsed@example.com');
    await setApp(lapsed, -20);
    await apply({ user: lapsed, appFrom: await inDays(0), appTo: await inDays(30) });
    expect(await appDays(lapsed)).toBeCloseTo(30, 1);

    // The same renewal, paid five days late: its month began five days ago.
    const late = await t.addUser('monthly-late@example.com');
    await setApp(late, -5);
    await apply({ user: late, appFrom: await inDays(-5), appTo: await inDays(25) });
    expect(await appDays(late)).toBeCloseTo(25, 1);
  });

  it('counts the same invoice once, and finds the account from the customer like a Cloud invoice does', async () => {
    const user = await t.addUser('monthly-twice@example.com');
    await apply({ user, customer: 'cus_m2', subscription: 'sub_m2' });
    const month = { event: 'evt_month_1', customer: 'cus_m2', subscription: 'sub_m2', appFrom: await inDays(0), appTo: await inDays(30) };
    expect(await apply(month)).toBe('ok');
    expect(await apply(month)).toBe('duplicate');
    expect(await appDays(user)).toBeCloseTo(30, 1);
  });

  it('waits for a customer it has not met yet, like any other invoice', async () => {
    expect(await apply({ event: 'evt_month_early', customer: 'cus_m_late', appFrom: await inDays(0), appTo: await inDays(30) })).toBe('unknown-account');
    expect(await t.value<number>("select count(*)::int from stripe_events where id = 'evt_month_early'")).toBe(0);
  });

  it('leaves Encore bought outright, Cloud and the trial alone', async () => {
    const user = await t.addUser('monthly-and-owner@example.com');
    await t.value('select license_start_trial($1, $2, 14)', [user, 'monthly-trial-laptop-12']);
    await apply({ user, customer: 'cus_m3', app: true, addYear: true });
    const cloud = await cloudDays(user);
    await apply({ user, appFrom: await inDays(0), appTo: await inDays(30) });
    expect(await row(user)).toMatchObject({ app_forever: true, trial: true });
    expect(await cloudDays(user)).toBeCloseTo(cloud!, 3);
  });

  it('ignores a month with no length, or that ends before it starts', async () => {
    const user = await t.addUser('monthly-empty@example.com');
    const now = await inDays(0);
    await apply({ user, appFrom: now, appTo: now });
    await apply({ user, appFrom: await inDays(10), appTo: await inDays(5) });
    expect(await appDays(user)).toBeNull();
  });
});

describe('taking a purchase back', () => {
  it('takes back a month of Encore Monthly too', async () => {
    const user = await t.addUser('refund-monthly@example.com');
    await apply({ user, customer: 'cus_rm', subscription: 'sub_rm', appFrom: await inDays(0), appTo: await inDays(30) });
    await t.value("select revoke_purchase('refund-monthly@example.com')");
    expect(await appDays(user)).toBeNull();
    expect(await row(user)).toMatchObject({ stripe_subscription_id: null });
  });

  it('turns off the app and Cloud, and keeps the trial', async () => {
    const user = await t.addUser('refund@example.com');
    await t.value('select license_start_trial($1, $2, 14)', [user, 'refund-laptop-12345678']);
    await apply({ user, customer: 'cus_refund', subscription: 'sub_refund', app: true, addYear: true });
    expect(await t.value<string>("select revoke_purchase('Refund@Example.com')")).toMatch(/no longer has a purchase/);
    expect(await row(user)).toMatchObject({ app_forever: false, stripe_subscription_id: null, trial: true });
    expect(await cloudDays(user)).toBeNull();
  });

  it('says so when nobody has that email', async () => {
    await expect(t.rows("select revoke_purchase('nobody@example.com')")).rejects.toThrow(/Nobody has signed in/);
  });
});

describe('who can touch what', () => {
  const FUNCTIONS = [
    "select license_stripe_apply('x', 'x', null, null, null, false, false, null, null, null)",
    "select license_stripe_apply('x', 'x', null, null, null, false, false, null, null, null, null, null)",
    "select revoke_purchase('boss@example.com')",
  ];

  it.each(['anon', 'authenticated'] as const)('keeps every function away from the %s key', async (role) => {
    for (const sql of FUNCTIONS) {
      await expect(
        t.as(role, () => t.rows(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('keeps Stripe’s event log away from the public keys', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(t.as(role, () => t.rows('select * from stripe_events')), role).rejects.toThrow(/permission denied/);
    }
  });

  it('lets the service run them', async () => {
    const user = await t.addUser('service@example.com');
    await expect(t.as('service_role', () => t.value<string>('select license_stripe_apply($1, $2, $3, null, null, true, false, null, null, null)', ['evt_service', 'test', user]))).resolves.toBe('ok');
  });
});
