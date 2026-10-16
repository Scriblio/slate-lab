import { describe, expect, it } from 'vitest';
import { isBlockedName, parseWords } from '../src/shared/namefilter.ts';

describe('name filter', () => {
  it.each([
    'Fuck',
    'f u c k',
    'F.U.C.K',
    'sh!t',
    'SH1T',
    'Fück',
    'fuckface',
    'Big Ass Dave',
    'A$$',
    'TITS',
    'n1gga',
    'Cunt',
    'xX_bitch_Xx',
    'dickhead',
  ])('turns away %s', (name) => {
    expect(isBlockedName(name)).toBe(true);
  });

  it.each([
    'Scunthorpe',
    'Cassie',
    'Hancock',
    'Essex',
    'Classic Rock Carl',
    'Brassy Brenda',
    'Assad',
    'Dick Van Dyke',
    'Pussycat Dolls',
    'Matt',
    'Dana 2',
    'Jo & Sam',
    'Titus',
    'Cumberland',
    'Analise',
    'Shiitake Sam',
    '',
    '   ',
  ])('lets %j through', (name) => {
    expect(isBlockedName(name)).toBe(false);
  });

  it('adds the KJ’s own words: whole names for short words, anywhere in a name for longer ones', () => {
    const extra = parseWords('Karen, bob\nCHAD;  x ');
    expect(extra).toEqual(['karen', 'bob', 'chad']);
    expect(isBlockedName('Karen', extra)).toBe(true);
    expect(isBlockedName('Not-Karen-Please', extra)).toBe(true);
    expect(isBlockedName('K a r e n', extra)).toBe(true);
    expect(isBlockedName('Bob', extra)).toBe(true);
    expect(isBlockedName('Bobby', extra)).toBe(false); // "bob" is short: only on its own
    expect(isBlockedName('Chadwick', extra)).toBe(true); // "chad" is long enough to match inside
    expect(isBlockedName('Dana', extra)).toBe(false);
  });
});
