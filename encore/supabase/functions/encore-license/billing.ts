// Paying: the two questions a signed-in KJ's laptop can ask besides "what do I have?".
//
//   checkout  { kind: 'app' | 'monthly' | 'cloud' }
//                                         a Stripe page to buy Encore ($149, with a year of
//                                         Cloud), to subscribe to Encore Monthly ($29 a month,
//                                         Cloud included), or to add another year of Cloud ($49)
//   portal                                Stripe's page for seeing payments and changing a card
//                                         or cancelling a subscription
//
// Asking gives nothing: the answer is only an address for the KJ's browser. What a payment
// is worth is decided by Stripe's webhook (../stripe-webhook) once the money has really
// moved, so a made-up request, or a page left half-finished, can't unlock anything.
//
// A page is refused where it would be a mistake rather than a sale: the owner's own account,
// Encore bought twice, a subscription to something they have for good, Cloud without Encore
// (or on top of Encore Monthly, which includes it), Cloud that never ends, a second
// subscription. A subscriber may buy Encore outright; the webhook then stops their renewals.
// Nothing is offered while the Stripe secrets are missing, and (as for trials and codes)
// nothing is taken for a license this service couldn't sign a pass for.

import { badInstall, DEFAULT_BILLING_PER_HOUR, evaluate, fail, HOUR, notConfigured, readInstallId, type Caller, type Deps, type Kind, type LinkReply } from './core.ts';

const paymentsOff = () => fail(503, 'payments-off', 'Buying isn’t switched on yet.');
const isKind = (kind: unknown): kind is Kind => kind === 'app' || kind === 'cloud' || kind === 'monthly';

/** Count a billing page against the account's hour; the reply to send if they have asked for too many. */
async function tooMany(caller: Caller, deps: Deps): Promise<LinkReply | null> {
  const now = (deps.now ?? Date.now)();
  const full = await deps.store.take(
    [{ name: `billing:account:${caller.userId}`, limit: deps.limits?.billingPerAccount ?? DEFAULT_BILLING_PER_HOUR }],
    new Date(Math.floor(now / HOUR) * HOUR).toISOString(),
  );
  return full ? fail(429, 'limit', 'Too many tries. Please wait an hour and try again.') : null;
}

export async function handleCheckout(input: unknown, caller: Caller, deps: Deps): Promise<LinkReply> {
  const installId = readInstallId(input);
  if (!installId) return badInstall();
  if (!deps.signing) return notConfigured();
  if (!deps.payments) return paymentsOff();
  const kind = (input as { kind?: unknown }).kind;
  if (!isKind(kind)) return fail(400, 'bad-request', 'Update Encore to buy.');
  if (kind === 'monthly' && !deps.payments.monthly) return fail(503, 'payments-off', 'Subscribing isn’t switched on yet.');

  const snapshot = await deps.store.snapshot(caller.userId, installId);
  const plan = evaluate(snapshot, (deps.now ?? Date.now)());
  const subscribed = plan.source === 'subscription';
  if (plan.owner) return fail(400, 'owner', 'This is the owner’s account. It already has everything.');
  if (kind !== 'cloud' && plan.appForever) return fail(400, 'already-owned', 'Encore is already yours on this account.');
  if (kind === 'cloud' && !plan.appForever) {
    return subscribed ? fail(400, 'cloud-included', 'Cloud is included with Encore Monthly.') : fail(400, 'app-first', 'Cloud goes with Encore. Buy Encore first: it comes with a year of Cloud.');
  }
  if (kind === 'cloud' && plan.cloudUntil === 'forever') return fail(400, 'cloud-forever', 'Your Cloud never runs out.');

  const limited = await tooMany(caller, deps);
  if (limited) return limited;

  const customer = snapshot.license?.stripeCustomerId ?? null;
  // Another subscription would charge twice, so Stripe is asked whether one is still going (a cancelled one has stopped, even
  // while its last days of grace run; one that is only set to end, or being retried, hasn't). Buying Encore outright is fine:
  // the webhook then stops a monthly renewal.
  if (kind !== 'app' && customer && (await deps.payments.hasSubscription(customer))) {
    return fail(
      400,
      'already-subscribed',
      kind === 'cloud' ? 'Cloud is already set to renew on this account. Use “Manage billing” to change or cancel it.' : 'Encore Monthly is already set up on this account. Use “Manage billing” to change, renew or cancel it.',
    );
  }
  const url = await deps.payments.checkout({ kind, userId: caller.userId, email: caller.email, customer });
  return { status: 200, body: { ok: true, url } };
}

export async function handlePortal(input: unknown, caller: Caller, deps: Deps): Promise<LinkReply> {
  const installId = readInstallId(input);
  if (!installId) return badInstall();
  if (!deps.payments) return paymentsOff();

  const customer = (await deps.store.snapshot(caller.userId, installId)).license?.stripeCustomerId;
  if (!customer) return fail(400, 'no-billing', 'There’s no card payment on this account to manage.');

  const limited = await tooMany(caller, deps);
  if (limited) return limited;

  return { status: 200, body: { ok: true, url: await deps.payments.portal(customer) } };
}
