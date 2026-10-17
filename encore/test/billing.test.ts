// Buying, from the license service's side (supabase/functions/encore-license/billing.ts and
// stripe.ts): when a Stripe page is offered, when it's refused, and exactly what is asked of
// Stripe. Asking for a page gives nothing; the webhook does (stripe-webhook.test.ts).
// Every scenario runs against the in-memory store and the real SQL functions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleCheckout, handlePortal } from '../supabase/functions/encore-license/billing.ts';
import { handleRedeem, handleStatus, type Caller, type Deps, type LinkReply, type Payments } from '../supabase/functions/encore-license/core.ts';
import { readPass } from '../supabase/functions/encore-license/pass.ts';
import { encodeForm, StripeError, stripePage, stripePayments, type StripeConfig } from '../supabase/functions/encore-license/stripe.ts';
import { DAY, fakePayments, makeKeys } from './licensekit.ts';
import { memoryWorld, sqlWorld, type World } from './licenseworld.ts';

let counter = 0;
const laptop = () => `laptop-${String(++counter).padStart(8, '0')}-abcdef`;

const refusal = (reply: LinkReply) => (reply.body.ok ? undefined : { status: reply.status, code: reply.body.code });

describe.each([
  { name: 'the in-memory store', open: async () => memoryWorld() },
  { name: 'the real SQL functions', open: sqlWorld },
])('buying, on $name', ({ open }) => {
  let w: World;
  let keys: Awaited<ReturnType<typeof makeKeys>>;
  beforeAll(async () => {
    w = await open();
    keys = await makeKeys();
  }, 60_000);
  afterAll(() => w.close());

  const deps = (over: Partial<Deps> = {}): Deps => ({ store: w.store, signing: { key: keys.signing, kid: keys.kid }, ...over });
  const checkout = (kj: Caller, kind: unknown, d: Deps, installId = laptop()) => handleCheckout({ installId, kind }, kj, d);
  const portal = (kj: Caller, d: Deps, installId = laptop()) => handlePortal({ installId }, kj, d);
  const bought = async (email: string, over: { cloudUntil?: number | null; cloudForever?: boolean; customer?: string } = {}) => {
    const kj = await w.kj(email);
    await w.purchase(kj.userId, { appForever: true, cloudUntil: over.cloudUntil === undefined ? Date.now() + 300 * DAY : over.cloudUntil, cloudForever: over.cloudForever, customer: over.customer ?? `cus_${counter++}` });
    return kj;
  };
  /** Someone on Encore Monthly, paid up to a moment (default: three weeks from now). */
  const subscribed = async (email: string, over: { paidUntil?: number; customer?: string } = {}) => {
    const kj = await w.kj(email);
    await w.subscribe(kj.userId, over.paidUntil ?? Date.now() + 20 * DAY, over.customer ?? `cus_${counter++}`);
    return kj;
  };

  describe('a page to buy Encore on', () => {
    it('is made for an account with no plan yet, with what Stripe needs to know who is paying', async () => {
      const kj = await w.kj('new-buyer@example.com');
      const { payments, asked } = fakePayments();
      const reply = await checkout(kj, 'app', deps({ payments }));
      expect(reply).toEqual({ status: 200, body: { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_1' } });
      expect(asked.checkout).toEqual([{ kind: 'app', userId: kj.userId, email: kj.email, customer: null }]);
    });

    it('is made for someone whose free trial is running or over', async () => {
      const running = await w.kj('trial-buyer@example.com');
      const over = await w.kj('trial-over@example.com');
      await handleStatus({ installId: laptop() }, running, deps());
      const { payments, asked } = fakePayments();
      await w.store.startTrial(running.userId, laptop(), 14);
      await w.store.startTrial(over.userId, laptop(), 14);
      await w.endTrialAt(over.userId, Date.now() - DAY);
      expect((await checkout(running, 'app', deps({ payments }))).status).toBe(200);
      expect((await checkout(over, 'app', deps({ payments }))).status).toBe(200);
      expect(asked.checkout).toHaveLength(2);
    });

    it('reuses the Stripe customer the account already has, so a returning buyer keeps their record', async () => {
      const kj = await w.kj('returning@example.com');
      await w.purchase(kj.userId, { appForever: false, customer: 'cus_returning' });
      const { payments, asked } = fakePayments();
      expect((await checkout(kj, 'app', deps({ payments }))).status).toBe(200);
      expect(asked.checkout[0]).toMatchObject({ kind: 'app', customer: 'cus_returning' });
    });

    it('is refused for the owner, who has everything', async () => {
      const kj = await w.kj('owner-buyer@example.com');
      await w.setOwner(kj.email);
      const { payments, asked } = fakePayments();
      for (const kind of ['app', 'cloud']) expect(refusal(await checkout(kj, kind, deps({ payments })))).toEqual({ status: 400, code: 'owner' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('is refused when Encore is already theirs, however they got it', async () => {
      const { payments, asked } = fakePayments();
      const purchased = await bought('already-bought@example.com');
      expect(refusal(await checkout(purchased, 'app', deps({ payments })))).toEqual({ status: 400, code: 'already-owned' });

      for (const grants of ['forever', 'app'] as const) {
        const kj = await w.kj(`code-${grants}@example.com`);
        const install = laptop();
        const code = await w.makeCode(`buy-${grants}`, grants);
        expect((await handleRedeem({ installId: install, code }, kj, '198.51.100.9', deps())).status).toBe(200);
        expect(refusal(await checkout(kj, 'app', deps({ payments }), install)), grants).toEqual({ status: 400, code: 'already-owned' });
      }
      expect(asked.checkout).toHaveLength(0);
    });
  });

  describe('a page to buy Cloud on', () => {
    it('is made for someone who has Encore, with their Stripe customer', async () => {
      const kj = await bought('cloud-buyer@example.com', { customer: 'cus_cloud_buyer' });
      const { payments, asked } = fakePayments();
      const reply = await checkout(kj, 'cloud', deps({ payments }));
      expect(reply.status).toBe(200);
      expect(asked.checkout).toEqual([{ kind: 'cloud', userId: kj.userId, email: kj.email, customer: 'cus_cloud_buyer' }]);
      expect(asked.looked).toEqual(['cus_cloud_buyer']);
    });

    it('is made for someone whose Encore came from an unlock code, who has no Stripe customer yet', async () => {
      const kj = await w.kj('code-then-cloud@example.com');
      const install = laptop();
      await handleRedeem({ installId: install, code: await w.makeCode('app only', 'app') }, kj, '198.51.100.10', deps());
      const { payments, asked } = fakePayments();
      expect((await checkout(kj, 'cloud', deps({ payments }), install)).status).toBe(200);
      expect(asked.checkout[0]).toMatchObject({ kind: 'cloud', customer: null });
      expect(asked.looked).toEqual([]); // nobody to look up
    });

    it('is refused without Encore: Cloud only goes with it', async () => {
      const { payments, asked } = fakePayments();
      expect(refusal(await checkout(await w.kj('cloud-first@example.com'), 'cloud', deps({ payments })))).toEqual({ status: 400, code: 'app-first' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('is refused when their Cloud never runs out', async () => {
      const kj = await bought('cloud-forever@example.com', { cloudForever: true });
      const { payments, asked } = fakePayments();
      expect(refusal(await checkout(kj, 'cloud', deps({ payments })))).toEqual({ status: 400, code: 'cloud-forever' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('is refused when a Cloud subscription is already running, so nobody pays twice', async () => {
      const kj = await bought('double-sub@example.com', { customer: 'cus_double' });
      const { payments, asked } = fakePayments(['cus_double']);
      expect(refusal(await checkout(kj, 'cloud', deps({ payments })))).toEqual({ status: 400, code: 'already-subscribed' });
      expect(asked.checkout).toHaveLength(0);
    });
  });

  describe('a page to subscribe to Encore Monthly on', () => {
    it('is made for an account with no plan yet, and for someone whose free trial is over', async () => {
      const fresh = await w.kj('monthly-new@example.com');
      const over = await w.kj('monthly-trial-over@example.com');
      await w.store.startTrial(over.userId, laptop(), 14);
      await w.endTrialAt(over.userId, Date.now() - DAY);
      const { payments, asked } = fakePayments();
      expect((await checkout(fresh, 'monthly', deps({ payments }))).status).toBe(200);
      expect((await checkout(over, 'monthly', deps({ payments }))).status).toBe(200);
      expect(asked.checkout).toEqual([
        { kind: 'monthly', userId: fresh.userId, email: fresh.email, customer: null },
        { kind: 'monthly', userId: over.userId, email: over.email, customer: null },
      ]);
    });

    it('reuses the Stripe customer the account has, after making sure no subscription is still running there', async () => {
      const kj = await w.kj('monthly-returning@example.com');
      await w.purchase(kj.userId, { appForever: false, customer: 'cus_monthly_back' });
      const { payments, asked } = fakePayments();
      expect((await checkout(kj, 'monthly', deps({ payments }))).status).toBe(200);
      expect(asked.checkout[0]).toMatchObject({ kind: 'monthly', customer: 'cus_monthly_back' });
      expect(asked.looked).toEqual(['cus_monthly_back']);
    });

    it('is made again for someone whose subscription ended, even in the few days of grace after the last paid month, since a cancelled subscription has stopped', async () => {
      const { payments, asked } = fakePayments(); // Stripe has nothing running for any of them
      for (const [email, paidUntil] of [
        ['monthly-lapsed@example.com', Date.now() - 4 * DAY],
        ['monthly-cancelled-in-grace@example.com', Date.now() - 2 * DAY],
      ] as const) {
        expect((await checkout(await subscribed(email, { paidUntil }), 'monthly', deps({ payments }))).status, email).toBe(200);
      }
      expect(asked.checkout).toHaveLength(2);
    });

    it('is refused while Stripe still has the subscription going (paid up, set to end, or a card being retried), so nobody pays twice', async () => {
      const { payments, asked } = fakePayments(['cus_current', 'cus_retry']);
      for (const [email, customer, paidUntil] of [
        ['monthly-current@example.com', 'cus_current', Date.now() + 20 * DAY],
        ['monthly-retry@example.com', 'cus_retry', Date.now() - 2 * DAY],
      ] as const) {
        expect(refusal(await checkout(await subscribed(email, { paidUntil, customer }), 'monthly', deps({ payments }))), email).toEqual({ status: 400, code: 'already-subscribed' });
      }
      expect(asked.checkout).toHaveLength(0);
    });

    it('is refused when Encore is theirs for good, however they got it, and for the owner', async () => {
      const { payments, asked } = fakePayments();
      const owner = await w.kj('monthly-owner@example.com');
      await w.setOwner(owner.email);
      expect(refusal(await checkout(owner, 'monthly', deps({ payments })))).toEqual({ status: 400, code: 'owner' });
      expect(refusal(await checkout(await bought('monthly-bought@example.com'), 'monthly', deps({ payments })))).toEqual({ status: 400, code: 'already-owned' });
      const kj = await w.kj('monthly-code@example.com');
      const install = laptop();
      await handleRedeem({ installId: install, code: await w.makeCode('monthly code', 'app') }, kj, '198.51.100.20', deps());
      expect(refusal(await checkout(kj, 'monthly', deps({ payments }), install))).toEqual({ status: 400, code: 'already-owned' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('is not offered when Encore Monthly has no price in Stripe, though Encore and Cloud still are', async () => {
      const kj = await w.kj('monthly-off@example.com');
      const { payments, asked } = fakePayments([], false);
      expect(refusal(await checkout(kj, 'monthly', deps({ payments })))).toEqual({ status: 503, code: 'payments-off' });
      expect(asked.checkout).toHaveLength(0);
      expect((await checkout(kj, 'app', deps({ payments }))).status).toBe(200);
    });
  });

  describe('a subscriber', () => {
    it('may buy Encore outright (the webhook then stops the renewals), without being asked whether a subscription is running', async () => {
      const kj = await subscribed('sub-buys@example.com', { customer: 'cus_sub_buys' });
      const { payments, asked } = fakePayments(['cus_sub_buys']);
      expect((await checkout(kj, 'app', deps({ payments }))).status).toBe(200);
      expect(asked.checkout[0]).toMatchObject({ kind: 'app', customer: 'cus_sub_buys' });
      expect(asked.looked).toEqual([]);
    });

    it('is not sold Cloud, which comes with their subscription', async () => {
      const kj = await subscribed('sub-cloud@example.com');
      const { payments, asked } = fakePayments();
      expect(refusal(await checkout(kj, 'cloud', deps({ payments })))).toEqual({ status: 400, code: 'cloud-included' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('has a pass that says so: Encore and Cloud until a few days after the paid month, with the month’s end named', async () => {
      const paidUntil = Date.now() + 20 * DAY;
      const kj = await subscribed('sub-pass@example.com', { paidUntil });
      const reply = await handleStatus({ installId: laptop() }, kj, deps({ payments: fakePayments().payments }));
      if (!reply.body.ok) throw new Error('not ok');
      const pass = await readPass(reply.body.pass, keys.keys);
      expect(pass).toMatchObject({ app: true, source: 'subscription', owner: false, appUntil: new Date(paidUntil).toISOString(), cloudUntil: new Date(paidUntil + 3 * DAY).toISOString() });
      expect(pass!.exp * 1000).toBeLessThanOrEqual(paidUntil + 3 * DAY);
      expect(reply.body).toMatchObject({ payments: true, monthly: true, billing: true });
    });
  });

  describe('Stripe’s billing page', () => {
    it('is made for someone who has paid by card', async () => {
      const kj = await bought('portal@example.com', { customer: 'cus_portal' });
      const { payments, asked } = fakePayments();
      expect(await portal(kj, deps({ payments }))).toEqual({ status: 200, body: { ok: true, url: 'https://billing.stripe.com/p/session/test_cus_portal' } });
      expect(asked.portal).toEqual(['cus_portal']);
    });

    it('is refused when nothing was paid by card: an unlock code or the owner has nothing to manage', async () => {
      const { payments, asked } = fakePayments();
      const owner = await w.kj('portal-owner@example.com');
      await w.setOwner(owner.email);
      for (const kj of [await w.kj('portal-nobody@example.com'), owner]) expect(refusal(await portal(kj, deps({ payments })))).toEqual({ status: 400, code: 'no-billing' });
      expect(asked.portal).toHaveLength(0);
    });
  });

  describe('when payments are not switched on', () => {
    it('offers nothing, and says so', async () => {
      const kj = await bought('off@example.com');
      expect(refusal(await checkout(kj, 'cloud', deps()))).toEqual({ status: 503, code: 'payments-off' });
      expect(refusal(await portal(kj, deps()))).toEqual({ status: 503, code: 'payments-off' });
    });

    it('takes no money for a license that could not be issued', async () => {
      const kj = await w.kj('no-key-buyer@example.com');
      const { payments, asked } = fakePayments();
      expect(refusal(await checkout(kj, 'app', deps({ payments, signing: undefined })))).toEqual({ status: 503, code: 'not-configured' });
      expect(asked.checkout).toHaveLength(0);
    });

    it('tells the console whether Encore Monthly can be offered, which needs both payments and its own price', async () => {
      const kj = await w.kj('monthly-flags@example.com');
      const install = laptop();
      const body = async (d: Deps) => (await handleStatus({ installId: install }, kj, d)).body;
      expect(await body(deps())).toMatchObject({ payments: false, monthly: false });
      expect(await body(deps({ payments: fakePayments([], false).payments }))).toMatchObject({ payments: true, monthly: false });
      expect(await body(deps({ payments: fakePayments().payments }))).toMatchObject({ payments: true, monthly: true });
    });

    it('tells the console whether there is anything to show, and whether there is a billing page', async () => {
      const kj = await w.kj('flags@example.com');
      const { payments } = fakePayments();
      const install = laptop();
      expect((await handleStatus({ installId: install }, kj, deps())).body).toMatchObject({ ok: true, payments: false, billing: false });
      expect((await handleStatus({ installId: install }, kj, deps({ payments }))).body).toMatchObject({ ok: true, payments: true, billing: false });
      await w.purchase(kj.userId, { appForever: true, customer: 'cus_flags' });
      expect((await handleStatus({ installId: install }, kj, deps({ payments }))).body).toMatchObject({ ok: true, payments: true, billing: true });
    });
  });

  describe('asking for a page', () => {
    it('gives nothing, and changes nothing about the account', async () => {
      const kj = await w.kj('nothing-given@example.com');
      const install = laptop();
      const { payments } = fakePayments();
      const before = await w.store.snapshot(kj.userId, install);
      expect((await checkout(kj, 'app', deps({ payments }), install)).status).toBe(200);
      expect((await checkout(kj, 'app', deps({ payments }), install)).status).toBe(200);
      expect(await w.store.snapshot(kj.userId, install)).toEqual(before);
      const reply = await handleStatus({ installId: install }, kj, deps({ payments }));
      if (!reply.body.ok) throw new Error('not ok');
      expect(await readPass(reply.body.pass, keys.keys)).toMatchObject({ app: false, source: null, cloudUntil: null });
    });

    it('is refused for a kind it does not know, or a laptop id that is not one', async () => {
      const kj = await w.kj('junk-kind@example.com');
      const { payments, asked } = fakePayments();
      for (const kind of [undefined, '', 'forever', 'APP', 7, null, { kind: 'app' }]) expect(refusal(await checkout(kj, kind, deps({ payments }))), String(kind)).toEqual({ status: 400, code: 'bad-request' });
      for (const installId of [undefined, 'short', 12345678901234567890]) {
        expect(refusal(await handleCheckout({ installId, kind: 'app' }, kj, deps({ payments }))), String(installId)).toEqual({ status: 400, code: 'bad-request' });
        expect(refusal(await handlePortal({ installId }, kj, deps({ payments }))), String(installId)).toEqual({ status: 400, code: 'bad-request' });
      }
      expect(asked.checkout).toHaveLength(0);
    });

    it('is limited to a few an hour for each account, and starts again the next hour', async () => {
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const at = (ms: number) => deps({ payments: fakePayments().payments, now: () => ms, limits: { redeemPerAccount: 10, redeemPerIp: 30, billingPerAccount: 3 } });
      const kj = await w.kj('hammering@example.com');
      const other = await w.kj('hammering-other@example.com');
      for (let i = 0; i < 3; i++) expect((await checkout(kj, 'app', at(hour + 60_000))).status).toBe(200);
      expect(refusal(await checkout(kj, 'app', at(hour + 120_000)))).toEqual({ status: 429, code: 'limit' });
      // The portal counts in the same hour, and nobody else is held up by it.
      await w.purchase(kj.userId, { appForever: true, customer: 'cus_hammer' });
      expect(refusal(await portal(kj, at(hour + 130_000)))).toEqual({ status: 429, code: 'limit' });
      expect((await checkout(other, 'app', at(hour + 140_000))).status).toBe(200);
      expect((await portal(kj, at(hour + 3_600_000 + 1000))).status).toBe(200);
    });
  });

  it('lets a failure from Stripe through, to be logged and answered as a hiccup, not as a refusal', async () => {
    const kj = await w.kj('stripe-down@example.com');
    const payments: Payments = {
      monthly: true,
      checkout: async () => {
        throw new StripeError(500, 'api_error', '');
      },
      portal: async () => {
        throw new StripeError(500, 'api_error', '');
      },
      hasSubscription: async () => false,
    };
    await expect(checkout(kj, 'app', deps({ payments }))).rejects.toThrow('Stripe 500 api_error');
  });
});

// --- what is asked of Stripe ------------------------------------------------------------------

describe('the Stripe calls', () => {
  const cfg: StripeConfig = {
    secretKey: 'sk_test_never_logged_or_sent_anywhere_else',
    priceApp: 'price_app',
    priceCloud: 'price_cloud',
    priceMonthly: 'price_monthly',
    successUrl: 'https://sing.example/thanks',
    cancelUrl: 'https://sing.example/encore',
    returnUrl: 'https://sing.example/thanks',
  };

  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: URLSearchParams;
  }
  /** A Stripe that answers with a canned reply and writes down what it was sent. */
  function stripe(reply: { status?: number; json: unknown } = { json: { url: 'https://checkout.stripe.com/c/pay/cs_test_abc' } }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body ?? '')) });
      return Response.json(reply.json, { status: reply.status ?? 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const who = { userId: '2b6f1c9e-0000-4000-8000-000000000001', email: 'a+b@example.com' };

  it('asks for a one-time payment for Encore, naming who is paying, and creates a customer for them', async () => {
    const s = stripe();
    const url = await stripePayments(cfg, s.fetchImpl).checkout({ kind: 'app', ...who, customer: null });
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
    const [call] = s.calls;
    expect(call!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call!.method).toBe('POST');
    expect(call!.headers).toMatchObject({ Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(call!.body)).toEqual({
      mode: 'payment',
      'line_items[0][price]': 'price_app',
      'line_items[0][quantity]': '1',
      'payment_method_types[0]': 'card',
      client_reference_id: who.userId,
      'metadata[user_id]': who.userId,
      'metadata[kind]': 'app',
      'payment_intent_data[metadata][user_id]': who.userId,
      'payment_intent_data[metadata][kind]': 'app',
      'payment_intent_data[statement_descriptor_suffix]': 'ENCORE',
      customer_email: 'a+b@example.com',
      customer_creation: 'always',
      success_url: 'https://sing.example/thanks',
      cancel_url: 'https://sing.example/encore',
    });
  });

  it('asks for a yearly subscription for Cloud, and carries the account onto the subscription so its invoices find it', async () => {
    const s = stripe();
    await stripePayments(cfg, s.fetchImpl).checkout({ kind: 'cloud', ...who, customer: null });
    expect(Object.fromEntries(s.calls[0]!.body)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_cloud',
      'line_items[0][quantity]': '1',
      'payment_method_types[0]': 'card',
      client_reference_id: who.userId,
      'metadata[user_id]': who.userId,
      'metadata[kind]': 'cloud',
      'subscription_data[metadata][user_id]': who.userId,
      'subscription_data[metadata][kind]': 'cloud',
      customer_email: 'a+b@example.com',
      success_url: 'https://sing.example/thanks',
      cancel_url: 'https://sing.example/encore',
    });
  });

  it('asks for a monthly subscription for Encore Monthly, stamped so that its invoices say what they are for', async () => {
    const s = stripe();
    await stripePayments(cfg, s.fetchImpl).checkout({ kind: 'monthly', ...who, customer: null });
    expect(Object.fromEntries(s.calls[0]!.body)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_monthly',
      'line_items[0][quantity]': '1',
      'payment_method_types[0]': 'card',
      client_reference_id: who.userId,
      'metadata[user_id]': who.userId,
      'metadata[kind]': 'monthly',
      'subscription_data[metadata][user_id]': who.userId,
      'subscription_data[metadata][kind]': 'monthly',
      customer_email: 'a+b@example.com',
      success_url: 'https://sing.example/thanks',
      cancel_url: 'https://sing.example/encore',
    });
  });

  it('offers cards and nothing else, whatever is bought and whoever is buying, so the account’s other payment methods are not shown for Encore', async () => {
    for (const kind of ['app', 'cloud', 'monthly'] as const) {
      for (const customer of [null, 'cus_known']) {
        const s = stripe();
        await stripePayments(cfg, s.fetchImpl).checkout({ kind, ...who, customer });
        const sent = Object.fromEntries(s.calls[0]!.body);
        expect(sent['payment_method_types[0]'], `${kind} ${customer}`).toBe('card');
        expect(Object.keys(sent).filter((k) => k.startsWith('payment_method_types')), `${kind} ${customer}`).toEqual(['payment_method_types[0]']);
      }
    }
  });

  it('puts ENCORE on the card statement of the one-time purchase, and on no subscription (those carry their statement text on their products)', async () => {
    const once = stripe();
    await stripePayments(cfg, once.fetchImpl).checkout({ kind: 'app', ...who, customer: null });
    expect(Object.fromEntries(once.calls[0]!.body)['payment_intent_data[statement_descriptor_suffix]']).toBe('ENCORE');
    for (const kind of ['cloud', 'monthly'] as const) {
      const s = stripe();
      await stripePayments(cfg, s.fetchImpl).checkout({ kind, ...who, customer: null });
      expect(Object.keys(Object.fromEntries(s.calls[0]!.body)).filter((k) => k.includes('statement_descriptor')), kind).toEqual([]);
    }
  });

  it('says Encore Monthly is on only when it has a price, and will not ask for one that is not there', async () => {
    const { priceMonthly: _, ...without } = cfg;
    expect(stripePayments(cfg).monthly).toBe(true);
    expect(stripePayments(without).monthly).toBe(false);
    const s = stripe();
    await expect(stripePayments(without, s.fetchImpl).checkout({ kind: 'monthly', ...who, customer: null })).rejects.toThrow(/No price/);
    expect(s.calls).toHaveLength(0);
  });

  it('uses the customer it already knows instead of an email', async () => {
    const s = stripe();
    await stripePayments(cfg, s.fetchImpl).checkout({ kind: 'app', ...who, customer: 'cus_known' });
    const sent = Object.fromEntries(s.calls[0]!.body);
    expect(sent.customer).toBe('cus_known');
    expect(sent).not.toHaveProperty('customer_email');
    expect(sent).not.toHaveProperty('customer_creation');
  });

  it('asks Stripe to work out tax only when told to', async () => {
    const off = stripe();
    await stripePayments(cfg, off.fetchImpl).checkout({ kind: 'app', ...who, customer: 'cus_known' });
    expect(Object.fromEntries(off.calls[0]!.body)).not.toHaveProperty('automatic_tax[enabled]');

    const on = stripe();
    await stripePayments({ ...cfg, automaticTax: true }, on.fetchImpl).checkout({ kind: 'app', ...who, customer: 'cus_known' });
    expect(Object.fromEntries(on.calls[0]!.body)).toMatchObject({ 'automatic_tax[enabled]': 'true', 'customer_update[address]': 'auto' });
    const fresh = stripe();
    await stripePayments({ ...cfg, automaticTax: true }, fresh.fetchImpl).checkout({ kind: 'app', ...who, customer: null });
    const sent = Object.fromEntries(fresh.calls[0]!.body);
    expect(sent).toMatchObject({ 'automatic_tax[enabled]': 'true' });
    expect(sent).not.toHaveProperty('customer_update[address]');
  });

  it('opens the billing portal for a customer, coming back to the thanks page', async () => {
    const s = stripe({ json: { url: 'https://billing.stripe.com/p/session/test_abc' } });
    expect(await stripePayments(cfg, s.fetchImpl).portal('cus_known')).toBe('https://billing.stripe.com/p/session/test_abc');
    expect(s.calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(Object.fromEntries(s.calls[0]!.body)).toEqual({ customer: 'cus_known', return_url: 'https://sing.example/thanks' });
  });

  it('looks for a running subscription with a plain GET, and never puts the key in the address', async () => {
    const s = stripe({ json: { data: [{ status: 'canceled' }, { status: 'past_due' }] } });
    expect(await stripePayments(cfg, s.fetchImpl).hasSubscription('cus_known')).toBe(true);
    const [call] = s.calls;
    expect(call!.method).toBe('GET');
    expect(call!.url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_known&status=all&limit=10');
    expect(call!.url).not.toContain('sk_');
    expect(call!.headers).not.toHaveProperty('Content-Type');
  });

  it('counts a subscription as running while it is active, in trial, or being retried, and not once it has ended', async () => {
    const has = async (...statuses: string[]) => stripePayments(cfg, stripe({ json: { data: statuses.map((status) => ({ status })) } }).fetchImpl).hasSubscription('cus_known');
    for (const status of ['active', 'trialing', 'past_due', 'unpaid']) expect(await has(status), status).toBe(true);
    for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'paused']) expect(await has(status), status).toBe(false);
    expect(await has()).toBe(false);
    expect(await stripePayments(cfg, stripe({ json: {} }).fetchImpl).hasSubscription('cus_known')).toBe(false);
  });

  it('reports a failure as what Stripe said it was, without the secret key or the customer’s details', async () => {
    const s = stripe({ status: 400, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price: price_app for a+b@example.com' } } });
    const err = await stripePayments(cfg, s.fetchImpl)
      .checkout({ kind: 'app', ...who, customer: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'resource_missing' });
    expect((err as Error).message).toBe('Stripe 400 invalid_request_error/resource_missing');
    expect(JSON.stringify(err) + String((err as Error).stack)).not.toContain(cfg.secretKey);
    expect((err as Error).message).not.toContain('example.com');
  });

  it('copes with an error that is not JSON at all', async () => {
    const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    await expect(stripePayments(cfg, fetchImpl).portal('cus_known')).rejects.toThrow('Stripe 502');
  });

  it('only hands on a page that really is Stripe’s', async () => {
    expect(stripePage('https://checkout.stripe.com/c/pay/cs_live_x#fid=abc')).toBe('https://checkout.stripe.com/c/pay/cs_live_x#fid=abc');
    expect(stripePage('https://billing.stripe.com/p/session/live_x')).toBe('https://billing.stripe.com/p/session/live_x');
    for (const bad of [undefined, null, 42, '', 'not a url', 'http://checkout.stripe.com/x', 'https://evil.example/checkout.stripe.com', 'https://checkout.stripe.com.evil.example/x', 'https://stripe.com/x', 'javascript:alert(1)']) {
      expect(() => stripePage(bad), String(bad)).toThrow();
    }
    for (const url of [undefined, 'https://evil.example/pay']) {
      const s = stripe({ json: { url } });
      await expect(stripePayments(cfg, s.fetchImpl).checkout({ kind: 'app', ...who, customer: null })).rejects.toThrow(/Stripe/);
    }
  });
});

describe('form encoding', () => {
  it('writes nested values in brackets, lists by position, and leaves out what is missing', () => {
    expect(encodeForm({ a: 'x', b: { c: 1, d: { e: true } }, f: [{ g: 'h' }, 'i'], j: null, k: undefined, l: false })).toBe(
      'a=x&b%5Bc%5D=1&b%5Bd%5D%5Be%5D=true&f%5B0%5D%5Bg%5D=h&f%5B1%5D=i&l=false',
    );
  });

  it('escapes what would otherwise change the meaning', () => {
    const encoded = encodeForm({ email: 'a+b&c=d@example.com', name: 'Zoë Ünal' });
    expect(encoded).not.toMatch(/[+ ]|&c=/);
    const back = Object.fromEntries(new URLSearchParams(encoded));
    expect(back).toEqual({ email: 'a+b&c=d@example.com', name: 'Zoë Ünal' });
  });
});
