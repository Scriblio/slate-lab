// "Never cut off a show that's running": what holds a show open when the plan runs out.

import { describe, expect, it } from 'vitest';
import { ShowAccess } from '../src/server/access.ts';
import type { Access } from '../src/shared/license.ts';

const ALLOWED: Access = { shows: true, cloud: true };
const NO_CLOUD: Access = { shows: true, cloud: false };
const NOTHING: Access = { shows: false, cloud: false };

/** An access check whose plan we can change, like a license running out. */
function setup(first: Access | undefined) {
  let plan = first;
  const access = new ShowAccess(() => plan);
  return { access, set: (p: Access | undefined) => (plan = p) };
}

describe('show access', () => {
  it('is always open when licensing is off', () => {
    const { access } = setup(undefined);
    access.observe('a', 3);
    expect(access.showOpen('a')).toBe(true);
    expect(access.showOpen('anything')).toBe(true);
    expect(access.cloudOn('anything')).toBe(true);
  });

  it('follows the plan when nothing is running', () => {
    const { access, set } = setup(ALLOWED);
    expect(access.showOpen('a')).toBe(true);
    set(NOTHING);
    expect(access.showOpen('a')).toBe(false);
    expect(access.cloudOn('a')).toBe(false);
    set(NO_CLOUD);
    expect(access.showOpen('a')).toBe(true);
    expect(access.cloudOn('a')).toBe(false);
  });

  it('keeps a show that had singers open when the plan runs out, for its whole night', () => {
    const { access, set } = setup(ALLOWED);
    access.observe('tonight', 1);
    set(NOTHING);
    expect(access.showOpen('tonight')).toBe(true);
    expect(access.cloudOn('tonight')).toBe(true);
    // Even through a lull when everyone has left, and with more observations in the dark.
    access.observe('tonight', 0);
    access.observe('tonight', 5);
    expect(access.showOpen('tonight')).toBe(true);
  });

  it('does not keep open a show that never had singers while the plan allowed it', () => {
    const { access, set } = setup(ALLOWED);
    access.observe('empty', 0);
    set(NOTHING);
    expect(access.showOpen('empty')).toBe(false);
  });

  it('gives nothing to singers who turn up after the plan ran out', () => {
    const { access, set } = setup(ALLOWED);
    set(NOTHING);
    access.observe('late', 4); // a closed show with leftover singers, from yesterday say
    expect(access.showOpen('late')).toBe(false);
    expect(access.cloudOn('late')).toBe(false);
  });

  it('ends with the show: a new list starts closed once the plan has run out', () => {
    const { access, set } = setup(ALLOWED);
    access.observe('first', 2);
    set(NOTHING);
    expect(access.showOpen('first')).toBe(true);
    expect(access.showOpen('second')).toBe(false);
    expect(access.cloudOn('second')).toBe(false);
  });

  it('does not outlive the app: a fresh start knows nothing of the show that was running', () => {
    const before = setup(ALLOWED);
    before.access.observe('tonight', 2);
    before.set(NOTHING);
    expect(before.access.showOpen('tonight')).toBe(true);
    const restarted = setup(NOTHING); // same show on disk, plan already run out
    restarted.access.observe('tonight', 2);
    expect(restarted.access.showOpen('tonight')).toBe(false);
  });

  it('holds Cloud and the show separately: a plan with no Cloud still runs shows, and Cloud carries on only where it started', () => {
    const { access, set } = setup(ALLOWED);
    access.observe('night', 1);
    set(NO_CLOUD); // the Cloud year ended mid-show
    expect(access.showOpen('night')).toBe(true);
    expect(access.cloudOn('night')).toBe(true);
    // The next show doesn't inherit it, even though shows are still allowed and it gets singers.
    access.observe('next night', 3);
    expect(access.showOpen('next night')).toBe(true);
    expect(access.cloudOn('next night')).toBe(false);
  });

  it('never gives Cloud to a show that began on a plan without it', () => {
    const { access } = setup(NO_CLOUD);
    access.observe('night', 6);
    expect(access.showOpen('night')).toBe(true);
    expect(access.cloudOn('night')).toBe(false);
  });
});
