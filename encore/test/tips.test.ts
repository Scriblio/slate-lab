// Quick-tip links: the KJ's Venmo, Cash App or PayPal.me link with an amount filled in.

import { describe, expect, it } from 'vitest';
import { formatTipAmount, parseTipAmounts, parseTipLink, tipLinkWithAmount } from '../src/shared/tips.ts';

describe('parseTipLink', () => {
  it('knows Venmo, Cash App and PayPal.me links, in the forms people paste', () => {
    expect(parseTipLink('https://venmo.com/u/dj-matt')).toEqual({ service: 'venmo', handle: 'dj-matt' });
    expect(parseTipLink('https://www.venmo.com/DJ_Matt')).toEqual({ service: 'venmo', handle: 'DJ_Matt' });
    expect(parseTipLink('https://account.venmo.com/u/dj-matt')).toEqual({ service: 'venmo', handle: 'dj-matt' });
    expect(parseTipLink('https://cash.app/$DJMatt')).toEqual({ service: 'cashapp', handle: '$DJMatt' });
    expect(parseTipLink('https://cash.app/%24DJMatt')).toEqual({ service: 'cashapp', handle: '$DJMatt' });
    expect(parseTipLink('https://paypal.me/djmatt')).toEqual({ service: 'paypal', handle: 'djmatt' });
    expect(parseTipLink('https://paypal.me/djmatt/20')).toEqual({ service: 'paypal', handle: 'djmatt' });
    expect(parseTipLink('https://www.paypal.com/paypalme/djmatt')).toEqual({ service: 'paypal', handle: 'djmatt' });
  });

  it('leaves everything else alone', () => {
    for (const link of [
      'https://ko-fi.com/djmatt',
      'https://venmo.com/',
      'https://venmo.com/u/',
      'https://venmo.com/code?user_id=123',
      'https://venmo.com/u/bad%20name',
      'https://cash.app/DJMatt',
      'https://cash.app/$',
      'https://www.paypal.com/donate?id=1',
      'http://paypal.me/djmatt',
      'https://paypal.me.evil.com/djmatt',
      'not a link',
    ]) {
      expect(parseTipLink(link), link).toBeNull();
    }
  });
});

describe('tipLinkWithAmount', () => {
  it('fills the amount in the way each service expects', () => {
    expect(tipLinkWithAmount('https://venmo.com/u/dj-matt', 5)).toBe('https://venmo.com/dj-matt?txn=pay&amount=5&note=Karaoke%20tip');
    expect(tipLinkWithAmount('https://venmo.com/u/dj-matt', 2.5, 'Thanks & cheers')).toBe('https://venmo.com/dj-matt?txn=pay&amount=2.50&note=Thanks%20%26%20cheers');
    expect(tipLinkWithAmount('https://cash.app/$DJMatt', 10)).toBe('https://cash.app/$DJMatt/10');
    expect(tipLinkWithAmount('https://paypal.me/djmatt/20', 1)).toBe('https://paypal.me/djmatt/1');
    expect(tipLinkWithAmount('https://www.paypal.com/paypalme/djmatt', 3)).toBe('https://paypal.me/djmatt/3');
  });

  it('gives nothing for links it can’t fill, or for no amount', () => {
    expect(tipLinkWithAmount('https://ko-fi.com/djmatt', 5)).toBeNull();
    expect(tipLinkWithAmount('https://cash.app/$DJMatt', 0)).toBeNull();
  });
});

describe('parseTipAmounts', () => {
  it('reads what the KJ types: sorted, no repeats, up to four, cents at most', () => {
    expect(parseTipAmounts('5, 1, 10')).toEqual([1, 5, 10]);
    expect(parseTipAmounts('$2 $2 $5.555 20 50 100')).toEqual([2, 5.56, 20, 50]);
    expect(parseTipAmounts([3, '7'])).toEqual([3, 7]);
  });

  it('drops anything that isn’t a sensible amount', () => {
    expect(parseTipAmounts('0, -5, abc, 501')).toEqual([]);
    expect(parseTipAmounts('')).toEqual([]);
    expect(parseTipAmounts(undefined)).toEqual([]);
  });

  it('writes whole dollars without cents', () => {
    expect(formatTipAmount(5)).toBe('5');
    expect(formatTipAmount(2.5)).toBe('2.50');
  });
});
