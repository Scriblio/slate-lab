// The Stripe webhook: the signature check, what each kind of event means, and whole
// payments run through the real database functions.

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleWebhook, plan, type ApplyResult, type WebhookStore } from '../supabase/functions/stripe-webhook/core.ts';
import { verifyStripeSignature } from '../supabase/functions/stripe-webhook/signature.ts';
import { openLicenseDb, type TestDb } from './licensedb.ts';

const SECRET = 'whsec_test_secret_for_tests_only';
const sign = (body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) => `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;

describe('checking the signature', () => {
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const now = Date.now();

  it('accepts what Stripe signed', async () => {
    expect(await verifyStripeSignature(body, sign(body), SECRET, now)).toBe(true);
  });

  it('turns away a body that was changed after signing', async () => {
    expect(await verifyStripeSignature(body.replace('evt_1', 'evt_2'), sign(body), SECRET, now)).toBe(false);
  });

  it('turns away the wrong secret, and a missing one', async () => {
    expect(await verifyStripeSignature(body, sign(body, 'whsec_someone_else'), SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body), '', now)).toBe(false);
  });

  it('turns away a correct signature that is too old, or from the future', async () => {
    const old = Math.floor(now / 1000) - 600;
    expect(await verifyStripeSignature(body, sign(body, SECRET, old), SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body, SECRET, old + 500), SECRET, now)).toBe(true);
    const future = Math.floor(now / 1000) + 600;
    expect(await verifyStripeSignature(body, sign(body, SECRET, future), SECRET, now)).toBe(false);
  });

  it('turns away a missing or broken header', async () => {
    for (const header of [null, undefined, '', 'nonsense', 't=abc,v1=00', 't=123', 'v1=abcd', `t=${Math.floor(now / 1000)}`, `t=${Math.floor(now / 1000)},v1=`]) {
      expect(await verifyStripeSignature(body, header, SECRET, now), String(header)).toBe(false);
    }
  });

  it('accepts when any one of several signatures matches (a secret being rotated)', async () => {
    const at = Math.floor(now / 1000);
    const good = sign(body, SECRET, at).split(',v1=')[1]!;
    expect(await verifyStripeSignature(body, `t=${at},v1=${'0'.repeat(64)},v1=${good}`, SECRET, now)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${at},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, SECRET, now)).toBe(false);
  });

  it('ignores a signature of the wrong length without trouble', async () => {
    const at = Math.floor(now / 1000);
    expect(await verifyStripeSignature(body, `t=${at},v1=abc`, SECRET, now)).toBe(false);
  });
});

// --- Stripe's events, as it sends them ---------------------------------------------------

let n = 0;
const event = (type: string, object: Record<string, unknown>, id = `evt_${++n}`) => ({ id, type, data: { object } });
const SECONDS_IN_YEAR = 365 * 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const appCheckout = (user: string, over: Record<string, unknown> = {}) =>
  event('checkout.session.completed', { id: 'cs_app', mode: 'payment', payment_status: 'paid', client_reference_id: user, customer: 'cus_A', metadata: { user_id: user, kind: 'app' }, ...over });
const cloudCheckout = (user: string, over: Record<string, unknown> = {}) =>
  event('checkout.session.completed', { id: 'cs_cloud', mode: 'subscription', payment_status: 'paid', client_reference_id: user, customer: 'cus_A', subscription: 'sub_A', metadata: { user_id: user, kind: 'cloud' }, ...over });
const invoice = (type: 'invoice.paid' | 'invoice.payment_failed', over: Record<string, unknown> = {}) =>
  event(type, { customer: 'cus_A', subscription: 'sub_A', attempt_count: 1, lines: { data: [{ period: { start: nowSeconds(), end: nowSeconds() + SECONDS_IN_YEAR } }] }, ...over });

describe('reading an event', () => {
  const read = (e: unknown) => plan(e, Date.UTC(2026, 9, 20), 7);

  it('treats a paid app checkout as Encore bought, with a year of Cloud', () => {
    expect(read(appCheckout('user-1'))).toEqual({
      event: expect.stringMatching(/^evt_/),
      type: 'checkout.session.completed',
      user: 'user-1',
      customer: 'cus_A',
      subscription: null,
      app: true,
      addYear: true,
      from: null,
      to: null,
      grace: null,
    });
  });

  it('waits for a payment that has not settled, and takes it when it does', () => {
    expect(read(appCheckout('user-1', { payment_status: 'unpaid' }))).toBeNull();
    const later = event('checkout.session.async_payment_succeeded', { mode: 'payment', payment_status: 'paid', client_reference_id: 'user-1', customer: 'cus_A', metadata: { kind: 'app' } });
    expect(read(later)).toMatchObject({ user: 'user-1', app: true, addYear: true });
  });

  it('only links the customer when a Cloud subscription starts; the paid year comes with its invoice', () => {
    expect(read(cloudCheckout('user-1'))).toMatchObject({ user: 'user-1', customer: 'cus_A', subscription: 'sub_A', app: false, addYear: false, from: null, to: null });
  });

  it('finds the account in the metadata when client_reference_id is missing', () => {
    expect(read(appCheckout('user-1', { client_reference_id: null }))).toMatchObject({ user: 'user-1' });
  });

  it('ignores a checkout it did not start', () => {
    expect(read(appCheckout('user-1', { client_reference_id: null, metadata: {} }))).toBeNull();
    expect(read(appCheckout('user-1', { metadata: { user_id: 'user-1', kind: 'something-else' } }))).toBeNull();
    expect(read(appCheckout('user-1', { mode: 'setup' }))).toBeNull();
  });

  it('adds the paid span of a Cloud invoice, taken from its lines', () => {
    const start = 1_800_000_000;
    const e = invoice('invoice.paid', { lines: { data: [{ period: { start, end: start + SECONDS_IN_YEAR } }] } });
    expect(read(e)).toMatchObject({ customer: 'cus_A', subscription: 'sub_A', from: new Date(start * 1000).toISOString(), to: new Date((start + SECONDS_IN_YEAR) * 1000).toISOString() });
  });

  it('reads the newer shape of an invoice, with the subscription under parent', () => {
    const start = 1_800_000_000;
    const e = event('invoice.paid', {
      customer: 'cus_A',
      parent: { subscription_details: { subscription: 'sub_new', metadata: { user_id: 'user-9' } } },
      lines: { data: [{ period: { start, end: start + 100_000 } }] },
    });
    expect(read(e)).toMatchObject({ subscription: 'sub_new', user: 'user-9' });
  });

  it('ignores the receipt for the one-time purchase, which has no subscription', () => {
    expect(read(invoice('invoice.paid', { subscription: null }))).toBeNull();
  });

  it('ignores an invoice that covers no span', () => {
    expect(read(invoice('invoice.paid', { lines: { data: [] } }))).toBeNull();
    expect(read(invoice('invoice.paid', { lines: { data: [{ period: { start: 5, end: 5 } }] } }))).toBeNull();
  });

  it('starts a week of grace on the first failed renewal only', () => {
    expect(read(invoice('invoice.payment_failed'))).toMatchObject({ grace: new Date(Date.UTC(2026, 9, 27)).toISOString(), from: null, to: null });
    expect(read(invoice('invoice.payment_failed', { attempt_count: 2 }))).toBeNull();
    expect(read(invoice('invoice.payment_failed', { subscription: null }))).toBeNull();
  });

  it('ignores every other kind of event', () => {
    for (const type of ['customer.created', 'customer.subscription.deleted', 'charge.refunded', 'payment_intent.succeeded', 'invoice.created']) {
      expect(read(event(type, { id: 'x', customer: 'cus_A' })), type).toBeNull();
    }
  });

  it('calls something that is not an event bad', () => {
    for (const e of [null, 'text', 42, {}, { id: 'evt', type: 'invoice.paid' }, { type: 'invoice.paid', data: { object: { a: 1 } } }]) {
      expect(read(e), JSON.stringify(e)).toBe('bad');
    }
  });
});

// --- through the whole handler, against the real SQL ----------------------------------------

let t: TestDb;
beforeAll(async () => {
  t = await openLicenseDb();
}, 60_000);
afterAll(async () => {
  await t.db.close();
});

const store: WebhookStore = {
  apply: (a) =>
    t.value<ApplyResult>('select license_stripe_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [a.event, a.type, a.user, a.customer, a.subscription, a.app, a.addYear, a.from, a.to, a.grace]),
};
const deps = { secret: SECRET, store };
const deliver = (e: unknown, over: { signature?: string | null; secret?: string | undefined } = {}) => {
  const body = typeof e === 'string' ? e : JSON.stringify(e);
  return handleWebhook(body, over.signature === undefined ? sign(body) : over.signature, 'secret' in over ? { ...deps, secret: over.secret } : deps);
};
const license = async (user: string) =>
  (await t.rows<{ app_forever: boolean; stripe_customer_id: string | null; stripe_subscription_id: string | null; days: number | null }>(
    'select app_forever, stripe_customer_id, stripe_subscription_id, extract(epoch from (cloud_until - now())) / 86400 as days from licenses where user_id = $1',
    [user],
  ))[0]!;
const yearDays = () => t.value<number>("select extract(epoch from ((now() + interval '1 year') - now())) / 86400");

describe('a purchase, start to finish', () => {
  it('buying Encore makes it theirs with a year of Cloud, once however often Stripe says so', async () => {
    const user = await t.addUser('buys@example.com');
    const e = appCheckout(user, { customer: 'cus_buys' });
    expect(await deliver(e)).toEqual({ status: 200, body: { ok: true, result: 'ok' } });
    expect(await deliver(e)).toEqual({ status: 200, body: { ok: true, result: 'duplicate' } });
    const lic = await license(user);
    expect(lic).toMatchObject({ app_forever: true, stripe_customer_id: 'cus_buys' });
    expect(lic.days).toBeCloseTo(await yearDays(), 1);
  });

  it('a Cloud subscription: the checkout links the customer, the invoice adds the year, the renewal adds the next', async () => {
    const user = await t.addUser('cloud@example.com');
    await deliver(appCheckout(user, { customer: 'cus_cloud' }));
    // Their included year is nearly used up.
    await t.db.query("update licenses set cloud_until = now() + interval '10 days' where user_id = $1", [user]);

    await deliver(cloudCheckout(user, { customer: 'cus_cloud', subscription: 'sub_cloud' }));
    expect((await license(user)).stripe_subscription_id).toBe('sub_cloud');

    const start = nowSeconds();
    const first = invoice('invoice.paid', { customer: 'cus_cloud', subscription: 'sub_cloud', lines: { data: [{ period: { start, end: start + SECONDS_IN_YEAR } }] } });
    expect((await deliver(first)).body.result).toBe('ok');
    // The year starts after the 10 days that were left, so nothing paid for is lost.
    expect((await license(user)).days).toBeCloseTo(10 + 365, 1);

    // A year on, the renewal's invoice covers the next year.
    await t.db.query("update licenses set cloud_until = now() + interval '1 hour' where user_id = $1", [user]);
    const next = invoice('invoice.paid', { customer: 'cus_cloud', subscription: 'sub_cloud', lines: { data: [{ period: { start: nowSeconds(), end: nowSeconds() + SECONDS_IN_YEAR } }] } });
    expect((await deliver(next)).body.result).toBe('ok');
    expect((await license(user)).days).toBeCloseTo(365 + 1 / 24, 1);
  });

  it('copes with the invoice arriving before the checkout that links the customer', async () => {
    const user = await t.addUser('order@example.com');
    const start = nowSeconds();
    const early = invoice('invoice.paid', { customer: 'cus_order', subscription: 'sub_order', lines: { data: [{ period: { start, end: start + SECONDS_IN_YEAR } }] } });
    // Stripe is told to try again later...
    expect(await deliver(early)).toMatchObject({ status: 409, body: { ok: false, code: 'unknown-account' } });
    await deliver(cloudCheckout(user, { customer: 'cus_order', subscription: 'sub_order' }));
    // ...and the retry of the very same event now works.
    expect(await deliver(early)).toEqual({ status: 200, body: { ok: true, result: 'ok' } });
    expect((await license(user)).days).toBeCloseTo(365, 1);
  });

  it('keeps Cloud on for a week after a renewal fails, once, and does not take any away', async () => {
    const user = await t.addUser('fails@example.com');
    await deliver(appCheckout(user, { customer: 'cus_fails' }));
    await t.db.query("update licenses set cloud_until = now() - interval '1 day' where user_id = $1", [user]);
    expect((await deliver(invoice('invoice.payment_failed', { customer: 'cus_fails' }))).body.result).toBe('ok');
    expect((await license(user)).days).toBeCloseTo(7, 1);
    // The retries Stripe makes later change nothing.
    expect((await deliver(invoice('invoice.payment_failed', { customer: 'cus_fails', attempt_count: 2 }))).body.result).toBe('ignored');
    expect((await license(user)).days).toBeCloseTo(7, 1);
  });

  it('gives nothing for a payment that has not gone through', async () => {
    const user = await t.addUser('unpaid@example.com');
    expect((await deliver(appCheckout(user, { payment_status: 'unpaid', customer: 'cus_unpaid' }))).body.result).toBe('ignored');
    expect(await t.rows('select 1 from licenses where user_id = $1', [user])).toHaveLength(0);
  });
});

describe('what the endpoint refuses', () => {
  const e = () => appCheckout('00000000-0000-0000-0000-000000000000');

  it('is not switched on until the secret exists', async () => {
    expect(await deliver(e(), { secret: undefined })).toMatchObject({ status: 503, body: { code: 'not-configured' } });
  });

  it('refuses a call that is not signed by Stripe, and changes nothing', async () => {
    const user = await t.addUser('forged@example.com');
    const forged = appCheckout(user, { customer: 'cus_forged' });
    for (const signature of [null, 'nope', sign(JSON.stringify(forged), 'whsec_attacker')]) {
      expect(await deliver(forged, { signature }), String(signature)).toMatchObject({ status: 400, body: { code: 'bad-signature' } });
    }
    expect(await t.rows('select 1 from licenses where user_id = $1', [user])).toHaveLength(0);
  });

  it('refuses a signed body that is not an event', async () => {
    expect(await deliver('not json at all')).toMatchObject({ status: 400, body: { code: 'bad-event' } });
    expect(await deliver({ hello: 'world' })).toMatchObject({ status: 400, body: { code: 'bad-event' } });
  });

  it('says ok to events it ignores, so Stripe does not keep sending them', async () => {
    expect(await deliver(event('customer.created', { id: 'cus_x' }))).toEqual({ status: 200, body: { ok: true, result: 'ignored' } });
  });
});
